import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { adminToken, makeStudent, staffToken } from './access-fixtures';

describe('domain reports with permission-scoped CSV export (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let admin: string, finance: string, librarian: string, invigilator: string, cafeteria: string;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    finance = await staffToken(h, 'FINANCE_OFFICER');
    librarian = await staffToken(h, 'LIBRARIAN');
    invigilator = await staffToken(h, 'INVIGILATOR');
    cafeteria = await staffToken(h, 'CAFETERIA_OPERATOR');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const get = (p: string, t: string) => h.http().get(`/api/v1/reports${p}`).set(bearer(t));
  const csv = (p: string, t: string) => get(p, t).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c).toString('utf8'))); });

  it('the catalogue lists only the reports a role may run', async () => {
    const ids = async (t: string) => (await get('/catalog', t).expect(200)).body.map((x: { id: string }) => x.id).sort();
    expect(await ids(finance)).toEqual(['finance-clearance']);
    expect(await ids(librarian)).toEqual(['library-overdue']);
    expect(await ids(invigilator)).toEqual(['exam-attendance']);
    expect(await ids(cafeteria)).toEqual(['meals-served']);
    expect((await ids(admin)).length).toBe(5);
    await h.http().get('/api/v1/reports/catalog').expect(401);
  });

  it('finance clearance lists active students who are not cleared, with a summary', async () => {
    const s = await makeStudent(h.prisma, { examCleared: false, fees: 35 });
    const res = (await get('/domain/finance-clearance', finance).expect(200)).body;
    expect(res.rows.find((r: { regNo: string }) => r.regNo === s.regNo)).toMatchObject({ feesPaidPercent: 35, registered: 'yes' });
    expect(res.summary.students).toBe(res.summary.cleared + res.summary.notCleared);
    await get('/domain/finance-clearance', librarian).expect(403);
  });

  it('library overdue counts loans past due and their fines', async () => {
    const s = await makeStudent(h.prisma, {});
    await h.prisma.libraryLoan.create({ data: { studentId: s.id, itemRef: 'ITM-1', title: 'Old book', dueAt: new Date(Date.now() - 5 * 86_400_000), fineUgx: 2500 } });
    const res = (await get('/domain/library-overdue', librarian).expect(200)).body;
    expect(res.rows.find((r: { regNo: string }) => r.regNo === s.regNo)).toMatchObject({ title: 'Old book', daysOverdue: 5, fine: 2500 });
    expect(res.summary.fineUgx).toBeGreaterThanOrEqual(2500);
  });

  it('meals served and exam attendance take a date range, which is validated', async () => {
    expect((await get('/domain/meals-served?from=2026-02-30', cafeteria).expect(400)).body.code).toBe('DATE_INVALID');
    expect((await get('/domain/exam-attendance?from=2026-01-01&to=2026-12-31', invigilator).expect(400)).body.code).toBe('RANGE_TOO_LARGE');
    const today = new Date().toISOString().slice(0, 10);
    const meals = (await get(`/domain/meals-served?from=${today}&to=${today}`, cafeteria).expect(200)).body;
    expect(meals).toMatchObject({ id: 'meals-served', from: today, to: today, truncated: false });
    const exams = (await get('/domain/exam-attendance', invigilator).expect(200)).body;
    expect(exams.columns.map((c: { key: string }) => c.key)).toContain('attendedPct');
    await get('/domain/meals-served', invigilator).expect(403);
    await get('/domain/nope', admin).expect(404);
  });

  it('CSV needs reports.export on top of the report permission, is formula-safe, and is audited', async () => {
    await get('/domain/finance-clearance?format=csv', finance).expect(403); // finance may view, but has no export permission
    const s = await makeStudent(h.prisma, { examCleared: false, fees: 10 });
    await h.prisma.student.update({ where: { id: s.id }, data: { fullName: '=HYPERLINK("http://x")' } });
    const before = await h.prisma.auditTrail.count({ where: { action: 'reports.exported' } });
    const res = await csv('/domain/finance-clearance?format=csv', admin).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('finance-clearance-');
    const text = res.body as string;
    expect(text.startsWith('﻿Reg. no.,Name,Fees paid %')).toBe(true);
    expect(text).toContain(s.regNo);
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(await h.prisma.auditTrail.count({ where: { action: 'reports.exported' } })).toBe(before + 1);
  });
});
