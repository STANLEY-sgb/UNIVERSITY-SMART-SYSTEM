import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { adminToken, staffToken } from './access-fixtures';

describe('institutional settings: policy, venues, academic calendar (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let admin: string, registry: string;
  let n = 0;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    registry = await staffToken(h, 'REGISTRY_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const call = (m: 'get' | 'post' | 'patch', p: string, t: string, b?: object) => h.http()[m](`/api/v1/settings${p}`).set(bearer(t)).send(b);

  it('is for settings.manage only', async () => {
    await call('get', '/policy', registry).expect(403);
    await call('get', '/venues', registry).expect(403);
    await h.http().get('/api/v1/settings/sessions').expect(401);
  });

  describe('policy', () => {
    it('changes placeholder values with a reason, audits before/after, and the rules engine sees it at once', async () => {
      const before = (await call('get', '/policy', admin).expect(200)).body.values;
      try {
        await call('patch', '/policy', admin, { fine_limit_ugx: 12_345, reason: 'x' }).expect(400);
        await call('patch', '/policy', admin, { reason: 'No values given' }).expect(409);
        await call('patch', '/policy', admin, { exam_min_fees_percent: 150, reason: 'Senate decision 4/2026' }).expect(400);
        const res = await call('patch', '/policy', admin, { fine_limit_ugx: 12_345, exam_min_fees_percent: 75, reason: 'Senate decision 4/2026' }).expect(200);
        expect(res.body.values).toMatchObject({ fine_limit_ugx: 12_345, exam_min_fees_percent: 75, gate_direction_required: before.gate_direction_required });
        const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'settings.policy_changed' }, orderBy: { seq: 'desc' } });
        expect(a.reason).toBe('Senate decision 4/2026');
        expect(a.after).toMatchObject({ fine_limit_ugx: 12_345 });
        expect(a.before).toMatchObject({ fine_limit_ugx: before.fine_limit_ugx });
        expect((await call('get', '/policy', admin).expect(200)).body.values.fine_limit_ugx).toBe(12_345);
      } finally {
        await call('patch', '/policy', admin, { fine_limit_ugx: before.fine_limit_ugx, exam_min_fees_percent: before.exam_min_fees_percent, reason: 'Restore test values' }).expect(200);
      }
    });
  });

  describe('venues', () => {
    it('adds and edits venues with validation, uniqueness and audit', async () => {
      const code = `TV-${Date.now() % 100000}${n++}`;
      await call('post', '/venues', admin, { code: 'bad code', name: 'x', kind: 'GATE', reason: 'Test venue' }).expect(400);
      await call('post', '/venues', admin, { code, name: 'Test room', kind: 'SPA', reason: 'Test venue' }).expect(400);
      expect((await call('post', '/venues', admin, { code, name: 'Test room', kind: 'LAB', opensAt: '18:00', closesAt: '08:00', reason: 'Test venue' }).expect(409)).body.code).toBe('INVALID_HOURS');
      expect((await call('post', '/venues', admin, { code, name: 'Test room', kind: 'LAB', opensAt: '08:00', reason: 'Test venue' }).expect(409)).body.code).toBe('INVALID_HOURS');
      await call('post', '/venues', admin, { code, name: 'Test room', kind: 'LAB', capacity: 40, opensAt: '08:00', closesAt: '18:00', reason: 'Test venue' }).expect(201);
      expect((await call('post', '/venues', admin, { code, name: 'Again', kind: 'LAB', reason: 'Test venue' }).expect(409)).body.code).toBe('VENUE_EXISTS');
      expect((await call('patch', `/venues/${code}`, admin, { closesAt: '07:00', reason: 'Shorten hours' }).expect(409)).body.code).toBe('INVALID_HOURS');
      await call('patch', `/venues/${code}`, admin, { name: 'Renamed room', capacity: 55, reason: 'Capacity corrected' }).expect(200);
      await call('patch', '/venues/NOPE-X', admin, { name: 'Nope', reason: 'Does not exist' }).expect(404);
      const list = (await call('get', '/venues', admin).expect(200)).body;
      expect(list.find((v: { code: string }) => v.code === code)).toMatchObject({ name: 'Renamed room', capacity: 55, kind: 'LAB', readers: 0 });
      const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'settings.venue_edited' }, orderBy: { seq: 'desc' } });
      expect(a.before).toMatchObject({ name: 'Test room', capacity: 40 });
    });
  });

  describe('academic calendar', () => {
    it('creates a session and semesters with date validation, and switches the current semester atomically', async () => {
      const original = await h.prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
      const code = '2031/2032';
      try {
        await call('post', '/sessions', admin, { code: '2031-32', startsOn: '2031-08-01', endsOn: '2032-07-31', reason: 'New year' }).expect(400);
        expect((await call('post', '/sessions', admin, { code, startsOn: '2032-07-31', endsOn: '2031-08-01', reason: 'New year' }).expect(409)).body.code).toBe('INVALID_DATES');
        const s = (await call('post', '/sessions', admin, { code, startsOn: '2031-08-01', endsOn: '2032-07-31', reason: 'New academic year' }).expect(201)).body.id as string;
        expect((await call('post', '/sessions', admin, { code, startsOn: '2031-08-01', endsOn: '2032-07-31', reason: 'Again' }).expect(409)).body.code).toBe('SESSION_EXISTS');

        expect((await call('post', `/sessions/${s}/semesters`, admin, { number: 1, startsOn: '2031-07-01', endsOn: '2031-12-15', reason: 'Semester 1' }).expect(409)).body.code).toBe('OUTSIDE_SESSION');
        const m1 = (await call('post', `/sessions/${s}/semesters`, admin, { number: 1, startsOn: '2031-08-01', endsOn: '2031-12-15', reason: 'Semester 1' }).expect(201)).body.id as string;
        expect((await call('post', `/sessions/${s}/semesters`, admin, { number: 1, startsOn: '2032-01-10', endsOn: '2032-05-15', reason: 'Dup number' }).expect(409)).body.code).toBe('SEMESTER_EXISTS');
        expect((await call('post', `/sessions/${s}/semesters`, admin, { number: 2, startsOn: '2031-12-01', endsOn: '2032-05-15', reason: 'Overlap' }).expect(409)).body.code).toBe('SEMESTER_OVERLAP');
        await call('post', `/sessions/${s}/semesters`, admin, { number: 2, startsOn: '2032-01-10', endsOn: '2032-05-15', reason: 'Semester 2' }).expect(201);

        await call('post', `/semesters/${m1}/make-current`, registry, { reason: 'Open the year' }).expect(403);
        await call('post', `/semesters/${m1}/make-current`, admin, { reason: 'Open the year' }).expect(200);
        expect(await h.prisma.semester.count({ where: { isCurrent: true } })).toBe(1);
        expect(await h.prisma.academicSession.count({ where: { isCurrent: true } })).toBe(1);
        expect((await call('post', `/semesters/${m1}/make-current`, admin, { reason: 'Again please' }).expect(409)).body.code).toBe('ALREADY_CURRENT');
        const view = (await call('get', '/sessions', admin).expect(200)).body;
        expect(view.find((x: { code: string }) => x.code === code)).toMatchObject({ isCurrent: true, semesters: [{ number: 1, isCurrent: true }, { number: 2, isCurrent: false }] });
        const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'settings.semester_made_current' }, orderBy: { seq: 'desc' } });
        expect(a.before).toMatchObject({ session: '2026/2027', number: 1 });
      } finally {
        await call('post', `/semesters/${original.id}/make-current`, admin, { reason: 'Restore test calendar' });
        expect((await h.prisma.semester.findFirstOrThrow({ where: { isCurrent: true } })).id).toBe(original.id);
      }
    });
  });
});
