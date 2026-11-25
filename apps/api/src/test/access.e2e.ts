import { randomBytes } from 'node:crypto';
import { generateQrKeyPair, signQr } from '@kiu/vcard';
import { Harness, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { ReaderCreds, adminToken, makeCard, makeExam, makeStudent, openMealsAllDay, provisionReader, signedPost, verify } from './access-fixtures';

describe('access verification pipeline (e2e, real PostgreSQL, real crypto)', () => {
  let h: Harness;
  let admin: string;
  let gate: ReaderCreds, exam: ReaderCreds, borrow: ReaderCreds, cafe: ReaderCreds;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    await openMealsAllDay(h.prisma);
    admin = await adminToken(h);
    gate = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    exam = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    borrow = await provisionReader(h, admin, 'LIBRARY_BORROW', 'LIB-MAIN');
    cafe = await provisionReader(h, admin, 'CAFETERIA', 'CAF-MAIN');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const alertCount = (kind: string, extra: object = {}) => h.prisma.securityAlert.count({ where: { kind, ...extra } });

  describe('reader provisioning and device authentication', () => {
    it('returns the signing secret once and stores it only encrypted', async () => {
      const row = await h.prisma.readerCredential.findUniqueOrThrow({ where: { keyId: gate.keyId } });
      expect(row.secretEnc.startsWith('v1.')).toBe(true);
      expect(row.secretEnc).not.toContain(gate.secret);
      const list = await h.http().get('/api/v1/readers').set('Authorization', `Bearer ${admin}`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(gate.secret);
      expect(JSON.stringify(list.body)).not.toMatch(/secretEnc|keyId/);
    });

    it('rejects unauthenticated requests and unauthorised staff', async () => {
      await h.http().post('/api/v1/readers').send({}).expect(401);
      await h.http().post('/api/v1/access/verify').send({ credential: { type: 'QR', token: 'x' } }).expect(401);
    });

    it('rejects missing headers, unknown keys, bad signatures and tampered bodies', async () => {
      const s = await makeStudent(h.prisma, { enrol: [] });
      const c = await makeCard(h.prisma, s.id);
      const noHeaders = await h.http().post('/api/v1/access/verify').send({ credential: { type: 'QR', token: c.qr() } }).expect(401);
      expect(noHeaders.body.code).toBe('READER_AUTH_REQUIRED');
      expect((await verify(h, gate, c.qr(), {}, { keyId: 'rk_nope' })).body.code).toBe('READER_UNKNOWN');
      const before = await alertCount('READER_BAD_SIGNATURE', { readerId: gate.id });
      expect((await verify(h, gate, c.qr(), {}, { secret: 'f'.repeat(64) })).body.code).toBe('BAD_HMAC');
      expect((await verify(h, gate, c.qr(), {}, { signBody: '{"credential":{"type":"QR","token":"other"}}' })).body.code).toBe('BAD_HMAC');
      expect(await alertCount('READER_BAD_SIGNATURE', { readerId: gate.id })).toBe(before + 2);
    });

    it('rejects stale and future timestamps', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const now = Math.floor(Date.now() / 1000);
      for (const ts of [now - 300, now + 300]) {
        const res = await verify(h, gate, c.qr(), {}, { timestamp: String(ts) }).expect(401);
        expect(res.body.code).toBe('STALE_TIMESTAMP');
      }
    });

    it('TC-09: a captured request replayed verbatim is rejected for nonce reuse', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const nonce = randomBytes(16).toString('hex');
      const ts = String(Math.floor(Date.now() / 1000));
      const qr = c.qr();
      const first = await verify(h, gate, qr, {}, { nonce, timestamp: ts }).expect(200);
      expect(first.body.decision).toBe('GRANT');
      const before = await alertCount('REQUEST_REPLAY', { readerId: gate.id });
      const replay = await verify(h, gate, qr, {}, { nonce, timestamp: ts }).expect(409);
      expect(replay.body.code).toBe('NONCE_REPLAY');
      expect(await alertCount('REQUEST_REPLAY', { readerId: gate.id })).toBe(before + 1);
      expect(await h.prisma.accessLog.count({ where: { requestNonce: nonce } })).toBe(1); // replay never reached the pipeline
    });

    it('revoked readers are refused and an alert is raised; rotation invalidates the old secret', async () => {
      const r = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      await verify(h, r, c.qr()).expect(200);

      const rotated = await h.http().post(`/api/v1/readers/${r.id}/rotate-credential`).set('Authorization', `Bearer ${admin}`).expect(200);
      await verify(h, r, c.qr()).expect(403); // old key revoked
      const fresh = { ...r, keyId: rotated.body.credentials.keyId, secret: rotated.body.credentials.secret };
      await verify(h, fresh, c.qr()).expect(200);

      await h.http().patch(`/api/v1/readers/${r.id}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 'REVOKED', reason: 'Device stolen from gate' }).expect(200);
      const before = await alertCount('REVOKED_READER_USED', { readerId: r.id });
      const res = await verify(h, fresh, c.qr()).expect(403);
      expect(res.body.code).toBe('READER_REVOKED');
      expect(await alertCount('REVOKED_READER_USED', { readerId: r.id })).toBe(before + 1);
    });

    it('a reader cannot claim another reader\'s service', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const res = await verify(h, gate, c.qr(), { service: 'EXAM' }).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'READER_SERVICE_MISMATCH' });
      expect(await alertCount('READER_SERVICE_MISMATCH', { readerId: gate.id })).toBeGreaterThan(0);
    });
  });

  describe('credential verification', () => {
    it('grants a valid QR, logs the decision with rule version and timing, and returns minimal student data', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id);
      const res = await verify(h, gate, c.qr(), { direction: 'ENTRY' }).expect(200);
      expect(res.body).toMatchObject({ decision: 'GRANT', reason_code: 'OK' });
      expect(Object.keys(res.body.student).sort()).toEqual(['full_name', 'photo_ref', 'programme', 'reg_no']);
      expect(res.body.processing_ms).toBeGreaterThanOrEqual(0);
      const log = await h.prisma.accessLog.findUniqueOrThrow({ where: { id: res.body.log_id } });
      expect(log).toMatchObject({ decision: 'GRANT', studentId: s.id, cardId: c.card.id, readerId: gate.id, authMethod: 'QR', direction: 'ENTRY' });
      expect(log.ruleVersionId).not.toBeNull();
    });

    it('TC-10: expired QR is denied', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const res = await verify(h, gate, c.qr({ nowSeconds: Math.floor(Date.now() / 1000) - 120 })).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CREDENTIAL_EXPIRED' });
    });

    it('TC-10: a QR signed with the wrong key (copied identity, wrong secret) is denied and alerted', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const attacker = generateQrKeyPair();
      const before = await alertCount('BAD_SIGNATURE', { cardId: c.card.id });
      const res = await verify(h, gate, c.qr({ keyHex: attacker.privateKeyHex })).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CREDENTIAL_INVALID' });
      expect(res.body.student).toBeNull(); // an unauthenticated credential reveals nothing about the student
      expect(await alertCount('BAD_SIGNATURE', { cardId: c.card.id })).toBe(before + 1);
    });

    it('denies a modified payload, malformed tokens, unknown cards and non-QR types', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const [p, pl, sig] = c.qr().split('.') as [string, string, string];
      const body = JSON.parse(Buffer.from(pl, 'base64url').toString());
      const forged = `${p}.${Buffer.from(JSON.stringify({ ...body, exp: body.exp + 99999 })).toString('base64url')}.${sig}`;
      for (const token of [forged, 'garbage', 'KIU1.a.b', `${p}.${pl}`]) {
        const res = await verify(h, gate, token).expect(200);
        expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CREDENTIAL_INVALID' });
      }
      const ghost = signQr(generateQrKeyPair().privateKeyHex, { cardNumber: 'KIU-DOES-NOT-EXIST', counter: 1 });
      expect((await verify(h, gate, ghost).expect(200)).body.reason_code).toBe('CREDENTIAL_INVALID');
      await signedPost(h, gate, '/access/verify', { credential: { type: 'NFC', token: 'x' } }).expect(400);
      await signedPost(h, gate, '/access/verify', { credential: { type: 'QR', token: 'x' }, studentId: 'abc' }).expect(400); // clients can never assert a student id
    });

    it('rejects a replayed QR (same nonce) even when the request itself is new', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const qr = c.qr();
      expect((await verify(h, gate, qr).expect(200)).body.decision).toBe('GRANT');
      const again = await verify(h, gate, qr).expect(200);
      expect(again.body).toMatchObject({ decision: 'DENY', reason_code: 'NONCE_REPLAY' });
      expect(await alertCount('QR_REPLAY', { cardId: c.card.id })).toBe(1);
    });

    it('rejects a regressed wallet counter (cloned credential)', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect((await verify(h, gate, c.qr({ counter: 10 })).expect(200)).body.decision).toBe('GRANT');
      const stale = await verify(h, gate, c.qr({ counter: 9 })).expect(200);
      expect(stale.body).toMatchObject({ decision: 'DENY', reason_code: 'COUNTER_INVALID' });
      expect((await verify(h, gate, c.qr({ counter: 11 })).expect(200)).body.decision).toBe('GRANT');
    });

    it('serialises a QR double-spend race: exactly one request is accepted', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const qr = c.qr();
      const results = await Promise.all(Array.from({ length: 10 }, () => verify(h, gate, qr)));
      const decisions = results.map((r) => r.body.reason_code);
      expect(decisions.filter((d) => d === 'OK')).toHaveLength(1);
      expect(decisions.filter((d) => d === 'NONCE_REPLAY')).toHaveLength(9);
    });
  });

  describe('card and student lifecycle', () => {
    it('TC-04: a LOST card is denied at the gate and raises a HIGH alert', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id, 'LOST');
      const res = await verify(h, gate, c.qr()).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CARD_LOST' });
      expect(res.body.student).toBeNull();
      const alert = await h.prisma.securityAlert.findFirstOrThrow({ where: { kind: 'LOST_CARD_PRESENTED', cardId: c.card.id } });
      expect(alert.severity).toBe('HIGH');
    });

    it('TC-04: a BLOCKED card is denied', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id, 'BLOCKED');
      expect((await verify(h, gate, c.qr()).expect(200)).body.reason_code).toBe('CARD_BLOCKED');
    });

    it('denies expired and pending cards', async () => {
      const exp = await makeCard(h.prisma, (await makeStudent(h.prisma)).id, 'ACTIVE', { expired: true });
      expect((await verify(h, gate, exp.qr()).expect(200)).body.reason_code).toBe('CARD_EXPIRED');
      const pend = await makeCard(h.prisma, (await makeStudent(h.prisma)).id, 'PENDING');
      expect((await verify(h, gate, pend.qr()).expect(200)).body.reason_code).toBe('CARD_UNKNOWN');
    });

    it('revoking a card credential denies it even though its signature is still valid', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      await h.prisma.cardCredential.updateMany({ where: { cardId: c.card.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
      expect((await verify(h, gate, c.qr()).expect(200)).body.reason_code).toBe('CARD_LOST');
    });

    it('denies a suspended student account whatever the card says', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { active: false })).id);
      expect((await verify(h, gate, c.qr()).expect(200)).body.reason_code).toBe('STUDENT_SUSPENDED');
    });
  });

  describe('examination hall (TC-01, TC-02, TC-03, TC-08)', () => {
    it('TC-01: eligible, enrolled student in the right room is granted and attendance recorded once', async () => {
      const { exam: ex, courseCode } = await makeExam(h.prisma, 'EXH-A');
      const s = await makeStudent(h.prisma, { enrol: [courseCode] });
      const c = await makeCard(h.prisma, s.id);
      const first = await verify(h, exam, c.qr()).expect(200);
      expect(first.body).toMatchObject({ decision: 'GRANT', reason_code: 'OK' });
      const second = await verify(h, exam, c.qr()).expect(200);
      expect(second.body.decision).toBe('GRANT');
      expect(await h.prisma.examAttendance.count({ where: { examSessionId: ex.id, studentId: s.id } })).toBe(1); // no duplicate
    });

    it('TC-02 + TC-08: finance refusal, then Finance clears the student and the next scan is granted', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-A');
      const s = await makeStudent(h.prisma, { enrol: [courseCode], examCleared: false, fees: 40 });
      const c = await makeCard(h.prisma, s.id);
      const denied = await verify(h, exam, c.qr()).expect(200);
      expect(denied.body).toMatchObject({ decision: 'DENY', reason_code: 'FINANCE_NOT_CLEARED' });
      expect(denied.body.message).toMatch(/Finance/);
      expect(denied.body.student.reg_no).toBe(s.regNo); // authenticated identity, so the operator can help

      await h.prisma.studentStatus.updateMany({ where: { studentId: s.id }, data: { examCleared: true, feesPaidPercent: 100 } });
      expect((await verify(h, exam, c.qr()).expect(200)).body.decision).toBe('GRANT');
      expect(await h.prisma.examAttendance.count({ where: { studentId: s.id } })).toBe(1);
    });

    it('TC-03: not enrolled in the course unit is denied; no attendance is recorded', async () => {
      await makeExam(h.prisma, 'EXH-A');
      const s = await makeStudent(h.prisma, { enrol: [] });
      const c = await makeCard(h.prisma, s.id);
      const res = await verify(h, exam, c.qr()).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'NOT_ENROLLED' });
      expect(await h.prisma.examAttendance.count({ where: { studentId: s.id } })).toBe(0);
    });

    it('denies the wrong examination room', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-B');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { enrol: [courseCode] })).id);
      expect((await verify(h, exam, c.qr()).expect(200)).body.reason_code).toBe('WRONG_VENUE');
    });

    it('denies outside the entry window', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-A', { open: false });
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { enrol: [courseCode] })).id);
      const res = await verify(h, exam, c.qr()).expect(200);
      expect(res.body.decision).toBe('DENY');
      expect(res.body.reason_code).toBe('OUTSIDE_TIME_WINDOW');
    });

    it('denies when no examination is scheduled at all', async () => {
      await h.prisma.venue.create({ data: { code: 'EXH-NONE', name: 'Empty hall', kind: 'EXAM_HALL' } }).catch(() => undefined);
      const r = await provisionReader(h, admin, 'EXAM', 'EXH-NONE');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect((await verify(h, r, c.qr()).expect(200)).body.reason_code).toBe('OUTSIDE_TIME_WINDOW');
    });

    it('FAILS CLOSED when eligibility facts are unknown (no status row for the semester)', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-A');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { noStatus: true, enrol: [courseCode] })).id);
      const res = await verify(h, exam, c.qr()).expect(200);
      expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'FACT_UNKNOWN' });
    });

    it('denies unregistered students for the semester', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-A');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { registered: false, enrol: [courseCode] })).id);
      expect((await verify(h, exam, c.qr()).expect(200)).body.reason_code).toBe('NOT_REGISTERED');
    });
  });

  describe('library borrowing and cafeteria rules', () => {
    it('TC-05: overdue items block borrowing; clearing them unblocks it', async () => {
      const s = await makeStudent(h.prisma, { overdue: 2, fines: 15_000 });
      const c = await makeCard(h.prisma, s.id);
      expect((await verify(h, borrow, c.qr()).expect(200)).body.reason_code).toBe('LIBRARY_OVERDUE');
      await h.prisma.studentStatus.updateMany({ where: { studentId: s.id }, data: { libraryOverdueItems: 0 } });
      expect((await verify(h, borrow, c.qr()).expect(200)).body.decision).toBe('GRANT'); // fine below the configurable limit
    });

    it('the fine limit is a configurable policy value, not a hard-coded constant', async () => {
      const s = await makeStudent(h.prisma, { fines: 70_000 });
      const c = await makeCard(h.prisma, s.id);
      expect((await verify(h, borrow, c.qr()).expect(200)).body.reason_code).toBe('LIBRARY_FINES');
      await h.prisma.systemSetting.update({ where: { key: 'policy' }, data: { value: { fine_limit_ugx: 100_000 } } });
      try {
        expect((await verify(h, borrow, c.qr()).expect(200)).body.decision).toBe('GRANT');
      } finally {
        await h.prisma.systemSetting.update({ where: { key: 'policy' }, data: { value: { fine_limit_ugx: 50_000 } } });
      }
    });

    it('denies students without a meal plan', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma, { meal: false })).id);
      expect((await verify(h, cafe, c.qr()).expect(200)).body.reason_code).toBe('NO_MEAL_PLAN');
    });

    it('fails closed when a service has no published rule', async () => {
      await h.prisma.service.upsert({ where: { code: 'NORULE' }, update: {}, create: { code: 'NORULE', name: 'No rule service' } });
      const r = await provisionReader(h, admin, 'NORULE', 'GATE-MAIN');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect((await verify(h, r, c.qr()).expect(200)).body).toMatchObject({ decision: 'DENY', reason_code: 'RULE_MISSING' });
    });

    it('health-centre responses never include student details', async () => {
      const r = await provisionReader(h, admin, 'HEALTH', 'GATE-MAIN');
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const res = await verify(h, r, c.qr()).expect(200);
      expect(res.body.decision).toBe('GRANT');
      expect(res.body.student).toBeNull();
    });
  });

  describe('rules administration', () => {
    const auth = () => ({ Authorization: `Bearer ${admin}` });
    const gateRule = (extra: object[] = []) => ({
      schemaVersion: 1,
      requirements: { all: [{ fact: 'account_active', op: 'eq', value: true, reason: 'STUDENT_SUSPENDED', message: 'Inactive.' }, ...extra] },
    });

    it('rejects invalid definitions with precise errors and never stores them', async () => {
      const before = await h.prisma.accessRuleVersion.count();
      const res = await h.http().put('/api/v1/services/LAB/rule').set(auth()).send({ definition: { schemaVersion: 1, requirements: { fact: 'x', op: 'eval', value: 'process.exit()', reason: 'X', message: 'm' } } }).expect(400);
      expect(res.body.code).toBe('RULE_INVALID');
      expect(res.body.details.length).toBeGreaterThan(0);
      expect(await h.prisma.accessRuleVersion.count()).toBe(before);
    });

    it('draft -> test -> publish changes live decisions, is versioned, audited, and can be rolled back', async () => {
      const lab = await provisionReader(h, admin, 'LAB', 'GATE-MAIN');
      const unreg = await makeStudent(h.prisma, { registered: false });
      const card = await makeCard(h.prisma, unreg.id);

      expect((await verify(h, lab, card.qr()).expect(200)).body.reason_code).toBe('NOT_REGISTERED'); // seeded v1 requires registration

      const draft = await h.http().put('/api/v1/services/LAB/rule').set(auth()).send({ definition: gateRule(), changeNote: 'Open labs to all active students' }).expect(200);
      expect(draft.body.status).toBe('DRAFT');

      // A draft has no effect on live decisions.
      expect((await verify(h, lab, card.qr()).expect(200)).body.reason_code).toBe('NOT_REGISTERED');

      // Dry-run against the real student's facts.
      const dry = await h.http().post('/api/v1/rules/test').set(auth()).send({ definition: gateRule(), regNo: unreg.regNo }).expect(201);
      expect(dry.body).toMatchObject({ allowed: true });

      await h.http().post(`/api/v1/services/LAB/rule/versions/${draft.body.version}/publish`).set(auth()).send({ note: 'approved by ICT' }).expect(201);
      const granted = await verify(h, lab, card.qr()).expect(200);
      expect(granted.body.decision).toBe('GRANT');
      const log = await h.prisma.accessLog.findUniqueOrThrow({ where: { id: granted.body.log_id } });
      expect(log.ruleVersionId).toBe(draft.body.id); // the exact rule version is recorded for every decision

      await h.http().post(`/api/v1/services/LAB/rule/versions/${draft.body.version}/publish`).set(auth()).send({}).expect(409); // not a draft any more

      const rb = await h.http().post('/api/v1/services/LAB/rule/versions/1/rollback').set(auth()).send({ reason: 'Registration must be enforced again' }).expect(201);
      expect(rb.body.version).toBeGreaterThan(draft.body.version);
      expect((await verify(h, lab, card.qr()).expect(200)).body.reason_code).toBe('NOT_REGISTERED');

      const history = await h.http().get('/api/v1/services/LAB/rule/history').set(auth()).expect(200);
      expect(history.body.map((v: { status: string }) => v.status)).toEqual(['PUBLISHED', 'ARCHIVED', 'ARCHIVED']);
      const actions = (await h.prisma.auditTrail.findMany({ where: { entityType: 'AccessRule' } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['rules.draft_saved', 'rules.published', 'rules.rolled_back']));
    });

    it('enforces permissions: viewers read, only rules.manage writes', async () => {
      const { createStaff, loginBearer } = await import('./harness');
      const sec = await createStaff(h.prisma, ['SECURITY_OFFICER']);
      const t = (await loginBearer(h, sec.email, sec.password)).token!;
      await h.http().get('/api/v1/services/GATE/rule').set('Authorization', `Bearer ${t}`).expect(403); // security has no rules.view
      await h.http().put('/api/v1/services/GATE/rule').set('Authorization', `Bearer ${t}`).send({ definition: gateRule() }).expect(403);
      await h.http().post('/api/v1/readers').set('Authorization', `Bearer ${t}`).send({}).expect(403);
      const got = await h.http().get('/api/v1/services/GATE/rule').set(auth()).expect(200);
      expect(got.body.published.status).toBe('PUBLISHED');
      await h.http().get('/api/v1/services/NOPE/rule').set(auth()).expect(404);
    });
  });

  describe('access logs API', () => {
    it('filters and paginates the log and exposes only safe fields', async () => {
      const res = await h.http().get('/api/v1/logs?decision=DENY&service=EXAM&pageSize=5').set('Authorization', `Bearer ${admin}`).expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((l: { decision: string; service: { code: string } }) => l.decision === 'DENY' && l.service.code === 'EXAM')).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/requestNonce|context|ruleVersionId/);
      await h.http().get('/api/v1/logs').expect(401);
    });
  });
});
