import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { randomBytes } from 'node:crypto';
import { ReaderCreds, adminToken, apiFor, makeStudent, openMealsAllDay, makeStudentUser, signedPost, staffToken } from './access-fixtures';
import { NOTICE_VERSION } from '../modules/biometrics/biometrics.service';
import { FRAME_LEN, MockFaceAdapter } from '../modules/biometrics/mock-adapter';

// ── deterministic synthetic "faces": a stable per-person pattern plus per-frame sensor/motion jitter ──
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function person(seed: number): number[] { const r = rng(seed); return Array.from({ length: FRAME_LEN }, () => 40 + r() * 170); }
function capture(base: number[], seed = Math.floor(Math.random() * 1e9), n = 5, jitter = 4): number[][] {
  const r = rng(seed);
  return Array.from({ length: n }, () => base.map((v) => Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 2 * jitter)))));
}
const still = (base: number[], n = 5) => Array.from({ length: n }, () => [...base]);

describe('face verification: consent, enrolment, 1:1 match, revocation (e2e, prototype mock adapter)', () => {
  let h: Harness;
  let admin: string, officer: string, cardOfficer: string;
  let faceReader: ReaderCreds, plainReader: ReaderCreds, libReader: ReaderCreds;
  const api = () => apiFor(h);
  const post = (p: string, t: string, b: object) => h.http().post(`/api/v1${p}`).set(bearer(t)).send(b);
  const get = (p: string, t: string) => h.http().get(`/api/v1${p}`).set(bearer(t));

  async function makeReader(service: string, venue: string, supportsFace: boolean, authorise: boolean): Promise<ReaderCreds> {
    const code = `F-${randomBytes(3).toString('hex').toUpperCase()}`;
    const res = await post('/readers', admin, { code, name: `Face ${service}`, serviceCode: service, venueCode: venue, supportsFace }).expect(201);
    if (authorise) await h.http().put(`/api/v1/biometrics/devices/${res.body.reader.id}`).set(bearer(admin)).send({ authorised: true, reason: 'Pilot gate approved' }).expect(200);
    return { id: res.body.reader.id, code, keyId: res.body.credentials.keyId, secret: res.body.credentials.secret };
  }
  const face = (r: ReaderCreds, regNo: string, frames: number[][]) => signedPost(h, r, '/access/verify', { credential: { type: 'FACE', regNo, frames } });
  const enrol = (regNo: string, frames: number[][], extra: object = {}) =>
    post('/biometrics/enrollments', officer, { regNo, noticeVersion: NOTICE_VERSION, consentConfirmed: true, frames, ...extra });

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'BIOMETRIC_OFFICER');
    cardOfficer = await staffToken(h, 'CARD_OFFICER');
    faceReader = await makeReader('GATE', 'GATE-MAIN', true, true);
    plainReader = await makeReader('GATE', 'GATE-MAIN', false, false);
    libReader = await makeReader('LIBRARY_BORROW', 'LIB-MAIN', true, true);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  describe('adapter (labelled prototype-only)', () => {
    const a = new MockFaceAdapter();
    it('is flagged as a mock and separates people, rejects stills, darkness and malformed input', () => {
      expect(a.isMock).toBe(true);
      const p = a.extract(capture(person(1), 11)), same = a.extract(capture(person(1), 12)), other = a.extract(capture(person(2), 13));
      if (!p.ok || !same.ok || !other.ok) throw new Error('extract failed');
      expect(a.compare(p.template, same.template)).toBeGreaterThan(0.97);
      expect(a.compare(p.template, other.template)).toBeLessThan(0.3);
      expect(a.extract(still(person(1)))).toMatchObject({ ok: false, failure: 'LIVENESS_FAILED' });
      expect(a.extract(capture(person(1).map((v) => v * 0.1), 5))).toMatchObject({ ok: false, failure: 'QUALITY_FAILED' });
      expect(a.extract(capture(person(1).map(() => 128), 5))).toMatchObject({ ok: false, failure: 'QUALITY_FAILED' });
      expect(a.extract([[1, 2]])).toMatchObject({ ok: false, failure: 'BAD_INPUT' });
      expect(a.extract('x')).toMatchObject({ ok: false, failure: 'BAD_INPUT' });
    });
  });

  describe('enrolment', () => {
    it('needs consent, the current notice and a live, clear capture; stores only an encrypted template; audits', async () => {
      const s = await makeStudent(h.prisma, {});
      const me = person(101);
      await enrol(s.regNo, capture(me), { consentConfirmed: false }).expect(409);
      expect((await enrol(s.regNo, capture(me), { noticeVersion: 'old' }).expect(409)).body.code).toBe('NOTICE_OUTDATED');
      expect((await enrol(s.regNo, still(me)).expect(422)).body.code).toBe('FACE_LIVENESS_FAILED');
      expect((await enrol(s.regNo, capture(me.map((v) => v * 0.1))).expect(422)).body.code).toBe('FACE_QUALITY_FAILED');
      expect(await h.prisma.biometricEnrollment.count({ where: { studentId: s.id } })).toBe(0);

      const ok = await enrol(s.regNo, capture(me)).expect(201);
      expect(ok.body).toMatchObject({ status: 'ACTIVE', isMock: true });
      expect((await enrol(s.regNo, capture(me)).expect(409)).body.code).toBe('ALREADY_ENROLLED');
      const t = await h.prisma.biometricTemplate.findFirstOrThrow({ where: { enrollmentId: ok.body.id } });
      expect(t.encryptedTemplateRef.startsWith('v1.')).toBe(true);
      expect(await h.prisma.biometricConsent.count({ where: { enrollmentId: ok.body.id, status: 'GRANTED', lawfulBasis: 'INSTITUTIONAL_REQUIREMENT' } })).toBe(1);
      expect(await h.prisma.auditTrail.count({ where: { action: 'biometrics.enrolled', entityId: ok.body.id } })).toBe(1);
      const list = await get('/biometrics/enrollments?pageSize=100', officer).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(t.encryptedTemplateRef);
      expect(list.body.data.find((r: { id: string }) => r.id === ok.body.id)).toMatchObject({ regNo: s.regNo, model: { isMock: true } });
    });
    it('is permission-gated', async () => {
      const s = await makeStudent(h.prisma, {});
      await post('/biometrics/enrollments', cardOfficer, { regNo: s.regNo, noticeVersion: NOTICE_VERSION, consentConfirmed: true, frames: capture(person(5)) }).expect(403);
      await get('/biometrics/enrollments', cardOfficer).expect(403);
      await h.http().post('/api/v1/biometrics/enrollments').send({}).expect(401);
      await get('/biometrics/notice', officer).then((r) => expect(r.body).toMatchObject({ version: NOTICE_VERSION, prototypeOnly: true }));
    });
  });

  describe('verification through the shared access pipeline', () => {
    it('FACE-01/02: the right face is granted and logged as FACE; another face, a still image, or no enrolment is denied with a specific reason', async () => {
      const s = await makeStudent(h.prisma, {});
      const me = person(201);
      await enrol(s.regNo, capture(me, 1)).expect(201);

      const ok = await face(faceReader, s.regNo, capture(me, 2)).expect(200);
      expect(ok.body).toMatchObject({ decision: 'GRANT', reason_code: 'OK', student: { reg_no: s.regNo } });
      const log = await h.prisma.accessLog.findUniqueOrThrow({ where: { id: ok.body.log_id } });
      expect(log).toMatchObject({ authMethod: 'FACE', cardId: null, studentId: s.id });
      expect(log.context).toMatchObject({ failedFact: null });
      expect(await h.prisma.biometricAttempt.count({ where: { studentId: s.id, outcome: 'MATCH', mode: 'ONE_TO_ONE' } })).toBe(1);

      const wrong = await face(faceReader, s.regNo, capture(person(202), 3)).expect(200);
      expect(wrong.body).toMatchObject({ decision: 'DENY', reason_code: 'FACE_NO_MATCH', student: null });
      expect((await face(faceReader, s.regNo, still(me)).expect(200)).body.reason_code).toBe('FACE_LIVENESS_FAILED');
      expect((await face(faceReader, s.regNo, capture(me.map((v) => v * 0.1))).expect(200)).body.reason_code).toBe('FACE_QUALITY_FAILED');
      // a failed attempt never records which student was claimed
      expect(await h.prisma.biometricAttempt.count({ where: { studentId: s.id, outcome: { not: 'MATCH' } } })).toBe(0);

      const other = await makeStudent(h.prisma, {});
      const a = await face(faceReader, other.regNo, capture(me)).expect(200);
      const b = await face(faceReader, 'NO-SUCH-REG', capture(me)).expect(200);
      expect(a.body.reason_code).toBe('FACE_NOT_ENROLLED');
      expect(b.body.reason_code).toBe('FACE_NOT_ENROLLED'); // unknown reg no is indistinguishable
    });

    it('is refused at a reader that is not face-capable or not authorised, and when the institution switches face off', async () => {
      const s = await makeStudent(h.prisma, {});
      const me = person(301);
      await enrol(s.regNo, capture(me)).expect(201);
      expect((await face(plainReader, s.regNo, capture(me)).expect(200)).body.reason_code).toBe('FACE_NOT_ENABLED');
      const unauth = await makeReader('GATE', 'GATE-MAIN', true, false);
      expect((await face(unauth, s.regNo, capture(me)).expect(200)).body.reason_code).toBe('FACE_NOT_ENABLED');
      await post('/biometrics/devices/00000000-0000-4000-8000-000000000000', admin, {}).expect(404);
      await h.http().put(`/api/v1/biometrics/devices/${plainReader.id}`).set(bearer(admin)).send({ authorised: true, reason: 'try it' }).expect(409);

      await h.http().put('/api/v1/biometrics/policy').set(bearer(admin)).send({ faceEnabled: false, reason: 'Pause pilot' }).expect(200);
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.reason_code).toBe('FACE_NOT_ENABLED');
      await h.http().put('/api/v1/biometrics/policy').set(bearer(admin)).send({ faceEnabled: true, reason: 'Resume pilot' }).expect(200);
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.decision).toBe('GRANT');
      await h.http().put('/api/v1/biometrics/policy').set(bearer(officer)).send({ faceEnabled: false, reason: 'not allowed' }).expect(403);
      await h.http().put('/api/v1/biometrics/policy').set(bearer(admin)).send({ matchThreshold: 0.2, reason: 'too low' }).expect(400);
    });

    it('FACE-06 / never an eligibility bypass: a lost card does not stop face, a suspended account does, and unmet rules still deny', async () => {
      const u = await makeStudentUser(h);
      const me = person(401);
      const issued = await api().call('POST', '/cards', { regNo: u.student.regNo }, cardOfficer);
      await h.prisma.card.update({ where: { id: issued.body.card.id }, data: { status: 'LOST' } });
      await enrol(u.student.regNo, capture(me)).expect(201);
      expect((await face(faceReader, u.student.regNo, capture(me)).expect(200)).body.decision).toBe('GRANT');

      await h.prisma.student.update({ where: { id: u.student.id }, data: { accountStatus: 'SUSPENDED' } });
      expect((await face(faceReader, u.student.regNo, capture(me)).expect(200)).body.reason_code).toBe('STUDENT_SUSPENDED');
      await h.prisma.student.update({ where: { id: u.student.id }, data: { accountStatus: 'ACTIVE' } });

      const fined = await makeStudent(h.prisma, { fines: 90_000 });
      await enrol(fined.regNo, capture(me)).expect(201);
      const denied = await face(libReader, fined.regNo, capture(me)).expect(200);
      expect(denied.body.decision).toBe('DENY');
      expect(denied.body.reason_code).not.toMatch(/^FACE_|^OK$/);
    });
  });

  describe('revocation and withdrawal', () => {
    it('staff revocation deletes the template, denies face with CONSENT_REVOKED and leaves the card route alone', async () => {
      const s = await makeStudent(h.prisma, {});
      const me = person(501);
      const e = (await enrol(s.regNo, capture(me)).expect(201)).body.id as string;
      await post(`/biometrics/enrollments/${e}/revoke`, cardOfficer, { reason: 'Student request' }).expect(403);
      await post(`/biometrics/enrollments/${e}/revoke`, officer, { reason: 'x' }).expect(400);
      await post(`/biometrics/enrollments/${e}/revoke`, officer, { reason: 'Student asked at the desk' }).expect(200);
      const t = await h.prisma.biometricTemplate.findFirstOrThrow({ where: { enrollmentId: e } });
      expect(t).toMatchObject({ encryptedTemplateRef: 'DELETED' });
      expect(t.deletedAt).not.toBeNull();
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.reason_code).toBe('FACE_CONSENT_REVOKED');
      expect(await h.prisma.biometricConsent.count({ where: { enrollmentId: e, status: 'WITHDRAWN' } })).toBe(1);
      expect(await h.prisma.biometricRevocation.count({ where: { enrollmentId: e, initiatedBy: 'ADMIN' } })).toBe(1);
      await post(`/biometrics/enrollments/${e}/revoke`, officer, { reason: 'Again please' }).expect(409);
      // re-enrolment after revocation is possible with fresh consent
      await enrol(s.regNo, capture(me)).expect(201);
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.decision).toBe('GRANT');
    });

    it('a student can see and withdraw their own enrolment, and only their own', async () => {
      const u = await makeStudentUser(h);
      const me = person(601);
      expect((await get('/me/biometrics', u.token).expect(200)).body).toMatchObject({ enrolled: false, prototypeOnly: true });
      await enrol(u.student.regNo, capture(me)).expect(201);
      const mine = (await get('/me/biometrics', u.token).expect(200)).body;
      expect(mine).toMatchObject({ enrolled: true, enrollment: { status: 'ACTIVE' } });
      expect(JSON.stringify(mine)).not.toContain('encryptedTemplateRef');
      await get('/biometrics/enrollments', u.token).expect(403);
      await post('/me/biometrics/withdraw', u.token, {}).expect(200);
      expect((await get('/me/biometrics', u.token).expect(200)).body.enrolled).toBe(false);
      expect((await face(faceReader, u.student.regNo, capture(me)).expect(200)).body.reason_code).toBe('FACE_CONSENT_REVOKED');
      expect(await h.prisma.auditTrail.count({ where: { action: 'biometrics.withdrawn' } })).toBeGreaterThan(0);
      await post('/me/biometrics/withdraw', u.token, {}).expect(404);
    });
  });

  describe('hardening', () => {
    it('pauses face for one student after repeated failures (alert raised), leaves card route and other students alone, and a success clears the count', async () => {
      const s = await makeStudent(h.prisma, {}), other = await makeStudent(h.prisma, {});
      const me = person(701), you = person(702);
      await enrol(s.regNo, capture(me)).expect(201);
      await enrol(other.regNo, capture(you)).expect(201);
      // 4 failures, then a success resets the count
      for (let i = 0; i < 4; i++) expect((await face(faceReader, s.regNo, capture(person(900 + i), i)).expect(200)).body.reason_code).toBe('FACE_NO_MATCH');
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.decision).toBe('GRANT');
      for (let i = 0; i < 5; i++) await face(faceReader, s.regNo, capture(person(950 + i), i)).expect(200);
      const locked = await face(faceReader, s.regNo, capture(me)).expect(200);
      expect(locked.body).toMatchObject({ decision: 'DENY', reason_code: 'FACE_LOCKED' }); // even the right face is paused
      expect((await face(faceReader, other.regNo, capture(you)).expect(200)).body.decision).toBe('GRANT');
      expect(await h.prisma.securityAlert.count({ where: { kind: 'FACE_LOCKOUT', studentId: s.id } })).toBe(1);
      // the lockout expires
      await h.prisma.credentialNonce.deleteMany({ where: { scope: 'FACE_FAIL', nonce: { startsWith: `ff:${s.id}:` } } });
      expect((await face(faceReader, s.regNo, capture(me)).expect(200)).body.decision).toBe('GRANT');
    });

    it('FACE-08: the one-meal-per-sitting constraint applies to face exactly as to cards', async () => {
      await openMealsAllDay(h.prisma);
      const cafe = await makeReader('CAFETERIA', 'CAF-MAIN', true, true);
      const s = await makeStudent(h.prisma, {});
      const me = person(801);
      await enrol(s.regNo, capture(me)).expect(201);
      expect((await face(cafe, s.regNo, capture(me)).expect(200)).body).toMatchObject({ decision: 'GRANT' });
      expect((await face(cafe, s.regNo, capture(me)).expect(200)).body).toMatchObject({ decision: 'DENY', reason_code: 'MEAL_ALREADY_CLAIMED' });
      expect(await h.prisma.mealUsage.count({ where: { studentId: s.id } })).toBe(1);
    });
  });
});
