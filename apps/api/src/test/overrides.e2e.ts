import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { ReaderCreds, adminToken, makeCard, makeExam, makeStudent, provisionReader, staffToken, verify } from './access-fixtures';

describe('manual overrides: narrow, justified, audited (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let examReader: ReaderCreds, gate: ReaderCreds;
  let security: string, invigilator: string, finance: string;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    const admin = await adminToken(h);
    examReader = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    gate = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    security = await staffToken(h, 'SECURITY_OFFICER');
    invigilator = await staffToken(h, 'INVIGILATOR');
    finance = await staffToken(h, 'FINANCE_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const scan = async (r: ReaderCreds, c: Awaited<ReturnType<typeof makeCard>>) => (await verify(h, r, c.qr()).expect(200)).body;
  const override = (t: string, b: object) => h.http().post('/api/v1/access/overrides').set(bearer(t)).send(b);

  it('lets an invigilator admit a student refused for a rule reason, and records everything', async () => {
    const { courseCode, exam } = await makeExam(h.prisma, 'EXH-A');
    const s = await makeStudent(h.prisma, { enrol: [courseCode], examCleared: false, fees: 40 });
    const c = await makeCard(h.prisma, s.id);
    const body = { regNo: s.regNo, serviceCode: 'EXAM', readerCode: examReader.code, reason: 'Finance confirmed payment by phone' };

    expect((await override(invigilator, body).expect(409)).body.code).toBe('NO_RECENT_DENIAL');
    expect(await scan(examReader, c)).toMatchObject({ decision: 'DENY', reason_code: 'FINANCE_NOT_CLEARED' });
    await override(invigilator, { ...body, reason: 'short' }).expect(400);
    const res = await override(invigilator, body).expect(201);
    expect(res.body.originalReason).toBe('FINANCE_NOT_CLEARED');

    const log = await h.prisma.accessLog.findUniqueOrThrow({ where: { id: res.body.logId } });
    expect(log).toMatchObject({ authMethod: 'MANUAL_OVERRIDE', decision: 'GRANT', reasonCode: 'MANUAL_OVERRIDE', studentId: s.id });
    expect(log.overrideId).toBe(res.body.id);
    expect(await h.prisma.examAttendance.findFirst({ where: { examSessionId: exam.id, studentId: s.id } })).toMatchObject({ status: 'OVERRIDDEN' });
    expect(await h.prisma.securityAlert.count({ where: { kind: 'MANUAL_OVERRIDE', studentId: s.id } })).toBe(1);
    const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'access.override_granted', entityId: res.body.id } });
    expect(a.reason).toBe('Finance confirmed payment by phone');
    expect((await override(invigilator, body).expect(409)).body.code).toBe('ALREADY_OVERRIDDEN');
    // the underlying facts are untouched: the next ordinary scan is still refused
    expect(await scan(examReader, c)).toMatchObject({ decision: 'DENY', reason_code: 'FINANCE_NOT_CLEARED' });
  });

  it('never overrides identity, credential or account failures', async () => {
    const lost = await makeStudent(h.prisma, {});
    const lc = await makeCard(h.prisma, lost.id, 'LOST');
    expect(await scan(gate, lc)).toMatchObject({ decision: 'DENY', reason_code: 'CARD_LOST' });
    expect((await override(security, { regNo: lost.regNo, serviceCode: 'GATE', reason: 'He says it is fine' }).expect(409)).body.code).toBe('NOT_OVERRIDABLE');

    const susp = await makeStudent(h.prisma, { active: false });
    const sc = await makeCard(h.prisma, susp.id);
    expect(await scan(gate, sc)).toMatchObject({ decision: 'DENY', reason_code: 'STUDENT_SUSPENDED' });
    expect((await override(security, { regNo: susp.regNo, serviceCode: 'GATE', reason: 'He says it is fine' }).expect(409)).body.code).toBe('NOT_OVERRIDABLE');
  });

  it('is permission-gated, validates references, and is listed for reviewers', async () => {
    const s = await makeStudent(h.prisma, {});
    await override(finance, { regNo: s.regNo, serviceCode: 'GATE', reason: 'Not my job to do this' }).expect(403);
    await h.http().post('/api/v1/access/overrides').send({}).expect(401);
    expect((await override(security, { regNo: 'NO-SUCH', serviceCode: 'GATE', reason: 'Does not exist at all' }).expect(404)).body.code).toBe('STUDENT_NOT_FOUND');
    expect((await override(security, { regNo: s.regNo, serviceCode: 'NOPE', reason: 'Does not exist at all' }).expect(404)).body.code).toBe('SERVICE_NOT_FOUND');
    const list = await h.http().get('/api/v1/access/overrides').set(bearer(security)).expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data[0]).toMatchObject({ service: expect.any(String), originalReason: expect.any(String), by: expect.any(String) });
    await h.http().get('/api/v1/access/overrides').set(bearer(finance)).expect(403);
  });
});
