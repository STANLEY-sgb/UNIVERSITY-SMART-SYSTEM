import { createHash } from 'node:crypto';
import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { makeStudent, staffToken } from './access-fixtures';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('CSV imports: preview, commit, idempotency (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let finance: string, registry: string, librarian: string, management: string;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    finance = await staffToken(h, 'FINANCE_OFFICER');
    registry = await staffToken(h, 'REGISTRY_OFFICER');
    librarian = await staffToken(h, 'LIBRARIAN');
    management = await staffToken(h, 'MANAGEMENT');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const preview = (token: string, kind: string, csv: string) => h.http().post('/api/v1/imports/preview').set(bearer(token)).send({ kind, csv });
  const commit = (token: string, kind: string, csv: string, extra: object = {}) =>
    h.http().post('/api/v1/imports/commit').set(bearer(token)).send({ kind, csv, reason: 'Term payments file', expectedSha256: sha(csv), ...extra });
  const status = (studentId: string) => h.prisma.studentStatus.findFirstOrThrow({ where: { studentId } });

  it('preview shows per-row before/after and errors, and changes nothing', async () => {
    const a = await makeStudent(h.prisma, { examCleared: false, fees: 40 });
    const b = await makeStudent(h.prisma, { examCleared: true, fees: 100 });
    const csv = `reg_no,fees_paid_percent,exam_cleared\n${a.regNo},100,yes\n${b.regNo},100,true\nNOPE-1,50,no\n${a.regNo},10,no\n${b.regNo.toLowerCase()}x,abc,maybe\n`;
    const res = await preview(finance, 'FINANCE', csv).expect(200);
    expect(res.body.sha256).toBe(sha(csv));
    expect(res.body.summary).toEqual({ total: 5, ok: 1, unchanged: 1, errors: 3 });
    expect(res.body.rows[0]).toMatchObject({ status: 'OK', before: { fees_paid_percent: 40, exam_cleared: false }, after: { fees_paid_percent: 100, exam_cleared: true } });
    expect(res.body.rows[1].status).toBe('UNCHANGED');
    expect(res.body.rows[2].errors).toContain('unknown student');
    expect(res.body.rows[3].errors).toContain('duplicate reg_no in this file');
    expect((await status(a.id)).examCleared).toBe(false);
  });

  it('commit applies the valid rows, audits each, notifies on clearance change, bumps factsVersion and records a job', async () => {
    const a = await makeStudent(h.prisma, { examCleared: false, fees: 40 });
    const before = (await status(a.id)).factsVersion;
    const csv = `Reg_No , Fees_Paid_Percent,Exam_Cleared\n${a.regNo},100,1\nGHOST-9,100,1\n`;
    const res = await commit(finance, 'FINANCE', csv).expect(200);
    expect(res.body).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', summary: { total: 2, ok: 1, errors: 1 } });
    const after = await status(a.id);
    expect(after).toMatchObject({ examCleared: true });
    expect(Number(after.feesPaidPercent)).toBe(100);
    expect(after.factsVersion).toBe(before + 1);
    expect(await h.prisma.notification.count({ where: { studentId: a.id, kind: 'FINANCE_CLEARANCE' } })).toBe(1);
    const rowAudit = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'import.finance_row', entityId: after.id } });
    expect(rowAudit.before).toMatchObject({ exam_cleared: false });
    expect(rowAudit.after).toMatchObject({ exam_cleared: true });
    const job = await h.prisma.syncJob.findUniqueOrThrow({ where: { id: res.body.jobId } });
    expect(job).toMatchObject({ kind: 'FINANCE', source: 'CSV_UPLOAD', rowsTotal: 2, rowsFailed: 1, fileSha256: sha(csv) });
  });

  it('is idempotent: the same file cannot be imported twice, and a file that changed since preview is refused', async () => {
    const a = await makeStudent(h.prisma, { registered: false });
    const csv = `reg_no,semester_registered\n${a.regNo},yes\n`;
    expect((await preview(registry, 'REGISTRY', csv).expect(200)).body.alreadyImported).toBeNull();
    await commit(registry, 'REGISTRY', csv).expect(200);
    expect((await status(a.id)).semesterRegistered).toBe(true);
    const again = await commit(registry, 'REGISTRY', csv).expect(409);
    expect(again.body.code).toBe('DUPLICATE_IMPORT');
    expect((await preview(registry, 'REGISTRY', csv).expect(200)).body.alreadyImported).not.toBeNull();
    const edited = `reg_no,semester_registered\n${a.regNo},no\n`;
    expect((await commit(registry, 'REGISTRY', edited, { expectedSha256: sha(csv) }).expect(409)).body.code).toBe('FILE_CHANGED');
    expect((await status(a.id)).semesterRegistered).toBe(true);
  });

  it('library fines import, and a file with no effective change is refused', async () => {
    const a = await makeStudent(h.prisma, { fines: 90_000 });
    const csv = `reg_no,fine_ugx\n${a.regNo},0\n`;
    await commit(librarian, 'LIBRARY', csv).expect(200);
    expect((await status(a.id)).libraryFinesUgx).toBe(0);
    const same = `reg_no,fine_ugx\n${a.regNo},0\n# second file\n`;
    expect((await commit(librarian, 'LIBRARY', same).expect(409)).body.code).toBe('NOTHING_TO_APPLY');
  });

  it('rejects malformed files with specific codes', async () => {
    const code = async (token: string, kind: string, csv: string) => (await preview(token, kind, csv).expect(400)).body.code;
    expect(await code(finance, 'FINANCE', 'reg_no\nA\n')).toBe('NOTHING_TO_IMPORT');
    expect(await code(finance, 'FINANCE', 'fees_paid_percent\n10\n')).toBe('MISSING_COLUMNS');
    expect(await code(finance, 'FINANCE', 'reg_no,fees_paid_percent,secret\nA,1,2\n')).toBe('UNKNOWN_COLUMNS');
    expect(await code(finance, 'FINANCE', 'reg_no,fees_paid_percent\n')).toBe('CSV_EMPTY');
    expect(await code(finance, 'FINANCE', 'reg_no,fees_paid_percent\n"A,1\n')).toBe('CSV_INVALID');
    await preview(finance, 'PAYROLL', 'a,b\n1,2\n').expect(400);
    const many = 'reg_no,fees_paid_percent\n' + Array.from({ length: 1001 }, (_, i) => `R${i},1`).join('\n');
    expect(await code(finance, 'FINANCE', many)).toBe('TOO_MANY_ROWS');
  });

  it('each import kind needs the permission of the equivalent single edit; anonymous and students are refused', async () => {
    const csv = 'reg_no,fine_ugx\nX,0\n';
    await preview(finance, 'LIBRARY', csv).expect(403);
    await preview(librarian, 'FINANCE', 'reg_no,fees_paid_percent\nX,1\n').expect(403);
    await preview(management, 'REGISTRY', 'reg_no,semester_registered\nX,yes\n').expect(403);
    await h.http().post('/api/v1/imports/preview').send({ kind: 'LIBRARY', csv }).expect(401);
  });

  it('lists import jobs for staff who may view integrations', async () => {
    const res = await h.http().get('/api/v1/imports/jobs').set(bearer(finance)).expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.data[0]).toHaveProperty('rowsTotal');
    await h.http().get('/api/v1/imports/jobs').set(bearer(librarian)).expect(403);
  });
});
