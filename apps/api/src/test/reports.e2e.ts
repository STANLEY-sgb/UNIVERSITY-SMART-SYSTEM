import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { adminToken, makeStudent, makeStudentUser, staffToken } from './access-fixtures';
import { csvCell, resolveRange } from '../modules/admin/reports.controller';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('reports and CSV export (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let admin: string, management: string, finance: string;
  const today = ymd(new Date());

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    management = await staffToken(h, 'MANAGEMENT');
    finance = await staffToken(h, 'FINANCE_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const get = (path: string, token: string) => h.http().get(`/api/v1${path}`).set(bearer(token));

  async function seedLogs(regNo: string) {
    const s = await h.prisma.student.findFirstOrThrow({ where: { regNo } });
    const svc = await h.prisma.service.findFirstOrThrow();
    await h.prisma.accessLog.createMany({ data: [
      { studentId: s.id, serviceId: svc.id, authMethod: 'QR', decision: 'GRANT', reasonCode: 'OK', message: 'ok' },
      { studentId: s.id, serviceId: svc.id, authMethod: 'QR', decision: 'DENY', reasonCode: 'CARD_BLOCKED', message: 'blocked' },
    ] });
  }

  describe('range and CSV helpers', () => {
    it('defaults to the last 7 days and rejects bad ranges', () => {
      const r = resolveRange({});
      expect(r.to).toBe(today);
      expect((r.end.getTime() - r.start.getTime()) / 86_400_000).toBe(7);
      expect(() => resolveRange({ from: '2026-02-30' })).toThrow();
      expect(() => resolveRange({ from: '2026-05-02', to: '2026-05-01' })).toThrow();
      expect(() => resolveRange({ from: '2026-01-01', to: '2026-12-31' })).toThrow();
    });
    it('quotes cells and neutralises spreadsheet formulas', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
      expect(csvCell('@cmd')).toBe("'@cmd");
      expect(csvCell(null)).toBe('');
      expect(csvCell(false)).toBe('false');
    });
  });

  describe('GET /reports/access', () => {
    it('returns zero-filled days and counts that move when decisions are logged', async () => {
      const a = await makeStudent(h.prisma, {});
      const before = (await get(`/reports/access?from=${today}&to=${today}`, management).expect(200)).body;
      await seedLogs(a.regNo);
      const after = (await get(`/reports/access?from=${today}&to=${today}`, management).expect(200)).body;
      expect(after.byDay).toHaveLength(1);
      expect(after.byDay[0].date).toBe(today);
      expect(after.totals.decisions).toBe(before.totals.decisions + 2);
      expect(after.totals.grants).toBe(before.totals.grants + 1);
      expect(after.totals.denies).toBe(before.totals.denies + 1);
      expect(after.topDenialReasons.length).toBeGreaterThan(0);
      expect(JSON.stringify(after)).not.toContain(a.regNo);
    });
    it('fills quiet days with zeros across a week', async () => {
      const res = (await get('/reports/access', management).expect(200)).body;
      expect(res.byDay).toHaveLength(7);
      expect(res.byDay[0]).toEqual(expect.objectContaining({ grants: expect.any(Number), denies: expect.any(Number) }));
    });
    it('validates the range', async () => {
      expect((await get('/reports/access?from=2026-02-30', management).expect(400)).body.code).toBe('DATE_INVALID');
      expect((await get('/reports/access?from=2026-01-01&to=2026-12-31', management).expect(400)).body.code).toBe('RANGE_TOO_LARGE');
      await get('/reports/access?from=yesterday', management).expect(400);
    });
    it('needs reports.view and a login', async () => {
      await h.http().get('/api/v1/reports/access').expect(401);
      await get('/reports/access', (await makeStudentUser(h)).token).expect(403);
    });
  });

  describe('GET /reports/access/export', () => {
    it('downloads CSV with a header, the registration number and formula-safe cells, and audits the export', async () => {
      const a = await makeStudent(h.prisma, {});
      await seedLogs(a.regNo);
      const before = await h.prisma.auditTrail.count({ where: { action: 'reports.access_exported' } });
      const res = await get(`/reports/access/export?from=${today}&to=${today}`, management).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c).toString('utf8'))); }).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`access-${today}_${today}.csv`);
      expect(res.headers['cache-control']).toBe('no-store');
      const text = res.body as string;
      expect(text.startsWith('﻿occurred_at,decision,reason_code,service,reader,venue,reg_no')).toBe(true);
      expect(text).toContain(a.regNo);
      expect(text).toContain('CARD_BLOCKED');
      expect(await h.prisma.auditTrail.count({ where: { action: 'reports.access_exported' } })).toBe(before + 1);
    });
    it('is refused without reports.export or without the log permission', async () => {
      await get('/reports/access/export', finance).expect(403);
      await h.http().get('/api/v1/reports/access/export').expect(401);
      // admin holds both and can export
      await get(`/reports/access/export?from=${today}&to=${today}`, admin).expect(200);
    });
    it('rejects an invalid range', async () => {
      await get('/reports/access/export?from=2026-01-01&to=2026-12-31', management).expect(400);
    });
  });
});
