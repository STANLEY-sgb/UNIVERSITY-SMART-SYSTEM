import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { adminToken, makeCard, makeStudent, makeStudentUser, provisionReader, staffToken, verify } from './access-fixtures';
import { NOTICE_VERSION, NOTICE_VERSION_VOLUNTARY } from '../modules/biometrics/biometrics.service';
import { FRAME_LEN } from '../modules/biometrics/mock-adapter';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const person = (seed: number) => { const r = rng(seed); return Array.from({ length: FRAME_LEN }, () => 40 + r() * 170); };
const capture = (base: number[], seed: number) => { const r = rng(seed); return Array.from({ length: 5 }, () => base.map((v) => Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 8))))); };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('compulsory face enrolment (D-039): notice, pending list, exemptions, enforcement date (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let admin: string, officer: string, registry: string;
  let gate: Awaited<ReturnType<typeof provisionReader>>;
  const call = (m: 'get' | 'post' | 'put', p: string, t: string, b?: object) => h.http()[m](`/api/v1${p}`).set(bearer(t)).send(b);
  const policy = (b: object) => call('put', '/biometrics/policy', admin, { reason: 'Test policy change', ...b });
  const enrol = (regNo: string, seed: number, version = NOTICE_VERSION) => call('post', '/biometrics/enrollments', officer, { regNo, noticeVersion: version, consentConfirmed: true, frames: capture(person(seed), seed) });
  const scan = async (c: Awaited<ReturnType<typeof makeCard>>) => (await verify(h, gate, c.qr(), { direction: undefined }).expect(200)).body;
  const reset = () => policy({ enrolmentRequired: true, enforceFrom: null });

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'BIOMETRIC_OFFICER');
    registry = await staffToken(h, 'REGISTRY_OFFICER');
    gate = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it('the notice says enrolment is compulsory and offers exemptions, and enrolment is recorded on the institutional basis', async () => {
    const n = (await call('get', '/biometrics/notice', officer).expect(200)).body;
    expect(n).toMatchObject({ version: NOTICE_VERSION, required: true, prototypeOnly: true });
    expect(n.points.join(' ')).toMatch(/compulsory/i);
    expect(n.points.join(' ')).toMatch(/exemption/i);
    expect(n.points.join(' ')).not.toMatch(/optional/i);
    const s = await makeStudent(h.prisma, {});
    const res = await enrol(s.regNo, 11).expect(201);
    const consent = await h.prisma.biometricConsent.findFirstOrThrow({ where: { enrollmentId: res.body.id, status: 'GRANTED' } });
    expect(consent).toMatchObject({ lawfulBasis: 'INSTITUTIONAL_REQUIREMENT', noticeVersion: NOTICE_VERSION });
  });

  it('switching the requirement off restores the voluntary, consent-based notice, and old notices are rejected', async () => {
    try {
      await policy({ enrolmentRequired: false }).expect(200);
      const n = (await call('get', '/biometrics/notice', officer).expect(200)).body;
      expect(n).toMatchObject({ version: NOTICE_VERSION_VOLUNTARY, required: false });
      expect(n.points.join(' ')).toMatch(/optional/i);
      const s = await makeStudent(h.prisma, {});
      expect((await enrol(s.regNo, 12, NOTICE_VERSION).expect(409)).body.code).toBe('NOTICE_OUTDATED');
      const ok = await enrol(s.regNo, 12, NOTICE_VERSION_VOLUNTARY).expect(201);
      expect((await h.prisma.biometricConsent.findFirstOrThrow({ where: { enrollmentId: ok.body.id, status: 'GRANTED' } })).lawfulBasis).toBe('CONSENT');
    } finally { await reset().expect(200); }
  });

  it('lists who still has to enrol, with counts, and exemptions need a real reason and the right permission', async () => {
    const s = await makeStudent(h.prisma, {});
    const view = async () => (await call('get', '/biometrics/pending?pageSize=100', officer).expect(200)).body;
    const before = await view();
    expect(before.summary).toMatchObject({ required: true, enforced: false });
    expect(before.summary.students).toBe(before.summary.enrolled + before.summary.exempt + before.summary.pending);
    expect(before.data.some((r: { regNo: string }) => r.regNo === s.regNo)).toBe(true);

    await call('post', '/biometrics/exemptions', officer, { regNo: s.regNo, reason: 'Wheelchair user, camera not reachable' }).expect(403); // officers enrol; policy owners excuse
    await call('post', '/biometrics/exemptions', admin, { regNo: s.regNo, reason: 'short' }).expect(400);
    await call('post', '/biometrics/exemptions', admin, { regNo: s.regNo, reason: 'Wheelchair user, camera not reachable' }).expect(201);
    expect((await call('post', '/biometrics/exemptions', admin, { regNo: s.regNo, reason: 'Wheelchair user, camera not reachable' }).expect(409)).body.code).toBe('ALREADY_EXEMPT');
    const after = await view();
    expect(after.data.some((r: { regNo: string }) => r.regNo === s.regNo)).toBe(false);
    expect(after.summary.exempt).toBe(before.summary.exempt + 1);
    expect(await h.prisma.auditTrail.count({ where: { action: 'biometrics.exemption_granted', entityId: s.id } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { studentId: s.id, kind: 'FACE_EXEMPTION' } })).toBe(1);

    await call('post', '/biometrics/exemptions/revoke', admin, { regNo: s.regNo, reason: 'Circumstances changed' }).expect(200);
    expect((await view()).data.some((r: { regNo: string }) => r.regNo === s.regNo)).toBe(true);
    await call('post', '/biometrics/exemptions/revoke', admin, { regNo: s.regNo, reason: 'Circumstances changed' }).expect(404);

    await enrol(s.regNo, 21).expect(201);
    expect((await view()).data.some((r: { regNo: string }) => r.regNo === s.regNo)).toBe(false);
    await call('get', '/biometrics/pending', registry).expect(403);
    await h.http().get('/api/v1/biometrics/pending').expect(401);
  });

  it('the student sees the requirement, the date and any exemption', async () => {
    const u = await makeStudentUser(h);
    try {
      await policy({ enforceFrom: ymd(new Date(Date.now() + 14 * 86_400_000)) }).expect(200);
      expect((await call('get', '/me/biometrics', u.token).expect(200)).body).toMatchObject({ required: true, enrolled: false, exempt: false, enforceFrom: ymd(new Date(Date.now() + 14 * 86_400_000)) });
      await call('post', '/biometrics/exemptions', admin, { regNo: u.student.regNo, reason: 'Conscientious objection recorded' }).expect(201);
      expect((await call('get', '/me/biometrics', u.token).expect(200)).body).toMatchObject({ exempt: true, exemptReason: 'Conscientious objection recorded' });
    } finally { await reset().expect(200); }
  });

  it('from the enforcement date every credential is refused until the student enrols or is exempted; before it, nothing changes', async () => {
    const plain = await makeStudent(h.prisma, {}), enrolled = await makeStudent(h.prisma, {}), exempt = await makeStudent(h.prisma, {});
    const [cp, ce, cx] = [await makeCard(h.prisma, plain.id), await makeCard(h.prisma, enrolled.id), await makeCard(h.prisma, exempt.id)];
    await enrol(enrolled.regNo, 31).expect(201);
    await call('post', '/biometrics/exemptions', admin, { regNo: exempt.regNo, reason: 'Safeguarding concern on file' }).expect(201);
    try {
      expect(await scan(cp)).toMatchObject({ decision: 'GRANT' }); // required, but no date set: not enforced
      await policy({ enforceFrom: ymd(new Date(Date.now() + 5 * 86_400_000)) }).expect(200);
      expect(await scan(cp)).toMatchObject({ decision: 'GRANT' }); // date in the future
      await policy({ enforceFrom: ymd(new Date()) }).expect(200);
      const r = await scan(cp);
      expect(r).toMatchObject({ decision: 'DENY', reason_code: 'FACE_ENROLMENT_REQUIRED' });
      expect(r.message).toMatch(/enrolment desk/i);
      expect(await scan(ce)).toMatchObject({ decision: 'GRANT' });
      expect(await scan(cx)).toMatchObject({ decision: 'GRANT' });

      // it cannot be talked past with a manual override: the remedy is to enrol or be exempted
      const sec = await staffToken(h, 'SECURITY_OFFICER');
      const ov = await call('post', '/access/overrides', sec, { regNo: plain.regNo, serviceCode: 'GATE', reason: 'He is in a hurry today' }).expect(409);
      expect(ov.body.code).toBe('NOT_OVERRIDABLE');

      // enrolling lifts it at once
      await enrol(plain.regNo, 32).expect(201);
      expect(await scan(cp)).toMatchObject({ decision: 'GRANT' });
    } finally { await reset().expect(200); }
  });

  it('deleting your face data under enforcement puts you back in the "must enrol" state', async () => {
    const u = await makeStudentUser(h);
    const c = await makeCard(h.prisma, u.student.id);
    await enrol(u.student.regNo, 41).expect(201);
    try {
      await policy({ enforceFrom: ymd(new Date()) }).expect(200);
      expect(await scan(c)).toMatchObject({ decision: 'GRANT' });
      await call('post', '/me/biometrics/withdraw', u.token, {}).expect(200);
      expect(await scan(c)).toMatchObject({ decision: 'DENY', reason_code: 'FACE_ENROLMENT_REQUIRED' });
    } finally { await reset().expect(200); }
  });
});
