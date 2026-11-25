import { ReaderClient, SimWallet } from '@kiu/simulator';
import { Harness, startHarness } from './harness';
import { adminToken, apiFor, makeExam, makeStudentUser, provisionReader, staffToken } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('GET /me/eligibility (e2e)', () => {
  let h: Harness;
  let admin: string, officer: string;
  const api = () => apiFor(h);

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'CARD_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const byService = (body: { services: { service: string }[] }, code: string) => body.services.find((s) => s.service === code) as
    { service: string; status: string; reason_code: string | null; message: string; office: string | null; detail?: Record<string, unknown> };

  it('explains every unmet condition with its reason and the office to contact', async () => {
    const { courseCode } = await makeExam(h.prisma, 'EXH-A');
    const u = await makeStudentUser(h, { enrol: [courseCode], examCleared: false, fees: 35, overdue: 2, fines: 80_000, meal: false, hostelPaid: false });
    const r = await api().call('GET', '/me/eligibility', undefined, u.token);
    expect(r.status).toBe(200);
    expect(r.body.student).toMatchObject({ reg_no: u.student.regNo, account_status: 'ACTIVE' });

    expect(byService(r.body, 'GATE')).toMatchObject({ status: 'ELIGIBLE', reason_code: null });
    expect(byService(r.body, 'EXAM')).toMatchObject({ status: 'NOT_ELIGIBLE', reason_code: 'FINANCE_NOT_CLEARED', office: 'Finance Office' });
    expect(byService(r.body, 'EXAM').detail).toMatchObject({ course_unit: courseCode, venue: expect.any(String) });
    expect(byService(r.body, 'LIBRARY_BORROW')).toMatchObject({ status: 'NOT_ELIGIBLE', reason_code: 'LIBRARY_OVERDUE', office: 'Library' });
    expect(byService(r.body, 'LIBRARY_ENTRY').status).toBe('ELIGIBLE'); // entry is separate from borrowing
    expect(byService(r.body, 'CAFETERIA')).toMatchObject({ status: 'NOT_ELIGIBLE', reason_code: 'NO_MEAL_PLAN' });
    expect(byService(r.body, 'HOSTEL')).toMatchObject({ status: 'NOT_ELIGIBLE', reason_code: 'HOSTEL_NOT_ASSIGNED', office: 'Hostel Warden' });
  });

  it('turns green when the facts change (Finance clears the student)', async () => {
    const { courseCode } = await makeExam(h.prisma, 'EXH-A');
    const u = await makeStudentUser(h, { enrol: [courseCode], examCleared: false });
    expect(byService((await api().call('GET', '/me/eligibility', undefined, u.token)).body, 'EXAM').status).toBe('NOT_ELIGIBLE');
    await h.prisma.studentStatus.updateMany({ where: { studentId: u.student.id }, data: { examCleared: true } });
    expect(byService((await api().call('GET', '/me/eligibility', undefined, u.token)).body, 'EXAM').status).toBe('ELIGIBLE');
  });

  it('never disagrees with what a reader decides for the same student', async () => {
    const { courseCode } = await makeExam(h.prisma, 'EXH-A');
    const examCreds = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    const borrowCreds = await provisionReader(h, admin, 'LIBRARY_BORROW', 'LIB-MAIN');
    for (const spec of [{ enrol: [courseCode] }, { enrol: [courseCode], examCleared: false }, { enrol: [courseCode], overdue: 1 }, { enrol: [] as string[] }]) {
      const u = await makeStudentUser(h, spec);
      const i = await api().call('POST', '/cards', { regNo: u.student.regNo }, officer);
      const w = await SimWallet.activate(api(), u.token, i.body.activationCode, i.body.card.cardNumber);
      const elig = (await api().call('GET', '/me/eligibility', undefined, u.token)).body;
      const exam = await new ReaderClient(api(), examCreds).verify({ type: 'QR', token: w.qr() });
      const borrow = await new ReaderClient(api(), borrowCreds).verify({ type: 'QR', token: w.qr() });
      const e = byService(elig, 'EXAM'), b = byService(elig, 'LIBRARY_BORROW');
      if (e.status === 'NOT_APPLICABLE') expect(exam.body.decision).toBe('DENY');
      else expect([e.status === 'ELIGIBLE' ? 'GRANT' : 'DENY', e.reason_code ?? 'OK']).toEqual([exam.body.decision, exam.body.reason_code]);
      expect([b.status === 'ELIGIBLE' ? 'GRANT' : 'DENY', b.reason_code ?? 'OK']).toEqual([borrow.body.decision, borrow.body.reason_code]);
    }
  });

  it('reports NOT_APPLICABLE when no exam is scheduled and UNKNOWN when facts are missing (fail closed, honest message)', async () => {
    const none = await makeStudentUser(h, { enrol: [] });
    expect(byService((await api().call('GET', '/me/eligibility', undefined, none.token)).body, 'EXAM').status).toBe('NOT_APPLICABLE');
    const unknown = await makeStudentUser(h, { noStatus: true });
    const r = byService((await api().call('GET', '/me/eligibility', undefined, unknown.token)).body, 'LAB');
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'FACT_UNKNOWN' });
    expect(r.message).toMatch(/do not have the information/i);
  });

  it('shows a suspended student a clear reason and contains only their own data', async () => {
    const a = await makeStudentUser(h, { active: false });
    const b = await makeStudentUser(h);
    const ra = await api().call('GET', '/me/eligibility', undefined, a.token);
    expect(byService(ra.body, 'GATE')).toMatchObject({ status: 'NOT_ELIGIBLE', reason_code: 'STUDENT_SUSPENDED' });
    const rb = await api().call('GET', '/me/eligibility', undefined, b.token);
    expect(JSON.stringify(rb.body)).not.toContain(a.student.regNo);
    expect(JSON.stringify(ra.body)).not.toMatch(/passwordHash|email/i);
  });

  it('requires a student login; staff and anonymous callers are refused', async () => {
    expect((await api().call('GET', '/me/eligibility')).status).toBe(401);
    expect((await api().call('GET', '/me/eligibility', undefined, officer)).status).toBe(403);
    expect((await api().call('GET', '/me/eligibility', undefined, admin)).status).toBe(403);
  });
});

describe('student self-service: history and notifications (e2e)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); await seedDemo(h.prisma, { students: 12 }); }, 120_000);
  afterAll(async () => { await h.close(); });

  it('shows a student only their own access history and notifications, and lets them mark them read', async () => {
    const officer = await staffToken(h, 'CARD_OFFICER');
    const admin = await adminToken(h);
    const reader = new ReaderClient(apiFor(h), await provisionReader(h, admin, 'GATE', 'GATE-MAIN'));
    const api = apiFor(h);
    const mk = async () => {
      const u = await makeStudentUser(h);
      const i = await api.call('POST', '/cards', { regNo: u.student.regNo }, officer);
      const w = await SimWallet.activate(api, u.token, i.body.activationCode, i.body.card.cardNumber);
      return { u, w };
    };
    const a = await mk(), b = await mk();
    await reader.verify({ type: 'QR', token: a.w.qr() });
    await reader.verify({ type: 'QR', token: a.w.qr({ nowSeconds: Math.floor(Date.now() / 1000) - 300, counter: 99 }) }); // expired -> DENY
    await reader.verify({ type: 'QR', token: b.w.qr() });

    const ha = await api.call('GET', '/me/access-history?pageSize=10', undefined, a.u.token);
    expect(ha.body.meta.total).toBe(2);
    expect(ha.body.data.map((r: { decision: string }) => r.decision).sort()).toEqual(['DENY', 'GRANT']);
    expect(JSON.stringify(ha.body)).not.toContain(b.u.student.regNo);
    expect(ha.body.data[0]).not.toHaveProperty('studentId');

    const na = await api.call('GET', '/me/notifications', undefined, a.u.token);
    expect(na.body.unread).toBeGreaterThan(0); // "card issued"
    expect((await api.call('POST', '/me/notifications/read-all', {}, a.u.token)).status).toBe(204);
    expect((await api.call('GET', '/me/notifications', undefined, a.u.token)).body.unread).toBe(0);
    expect((await api.call('GET', '/me/notifications', undefined, b.u.token)).body.unread).toBeGreaterThan(0); // untouched

    expect((await api.call('GET', '/me/access-history', undefined, officer)).status).toBe(403);
    expect((await api.call('GET', '/me/access-history')).status).toBe(401);
  });
});
