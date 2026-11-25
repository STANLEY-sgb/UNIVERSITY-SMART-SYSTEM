import { runScenarios } from '@kiu/simulator';
import { Harness, startHarness } from './harness';
import { adminToken, apiFor } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('security attack simulator against the real API (e2e)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); await seedDemo(h.prisma, { students: 12 }); }, 120_000);
  afterAll(async () => { await h.close(); });

  it('every scenario behaves as documented, using only public HTTP endpoints', async () => {
    const students = [1, 2, 3, 4].map((i) => ({
      regNo: `2026-${['BCS', 'BIT', 'BBA', 'LLB', 'BED'][(i - 1) % 5]}-${String(i).padStart(4, '0')}`,
      email: `student${String(i).padStart(2, '0')}@kiu-demo.test`,
      password: 'Demo-Password-2026!',
    }));
    const results = await runScenarios({ api: apiFor(h), adminToken: await adminToken(h), students });

    const failed = results.filter((r) => !r.passed);
    expect(failed).toEqual([]);
    expect(results.map((r) => r.id)).toEqual([
      'BASE-QR', 'BASE-TAP', 'ATK-01', 'ATK-02', 'ATK-03', 'ATK-04', 'ATK-05', 'ATK-06', 'ATK-07', 'ATK-08', 'ATK-09', 'ATK-10', 'ATK-11', 'ATK-12',
    ]);
  }, 120_000);

  it('is repeatable: running again retires the previous cards through the lost-card path and still passes', async () => {
    const students = [1, 2, 3, 4].map((i) => ({
      regNo: `2026-${['BCS', 'BIT', 'BBA', 'LLB', 'BED'][(i - 1) % 5]}-${String(i).padStart(4, '0')}`,
      email: `student${String(i).padStart(2, '0')}@kiu-demo.test`, password: 'Demo-Password-2026!',
    }));
    const results = await runScenarios({ api: apiFor(h), adminToken: await adminToken(h), students });
    expect(results.filter((r) => !r.passed)).toEqual([]);
    for (const s of students) {
      const active = await h.prisma.card.count({ where: { student: { regNo: s.regNo }, status: 'ACTIVE' } });
      expect(active).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('left an auditable trail: denials in the access log and alerts for the attacks', async () => {
    const kinds = (await h.prisma.securityAlert.findMany({ select: { kind: true } })).map((a) => a.kind);
    for (const k of ['COPIED_UID_WRONG_KEY', 'QR_REPLAY', 'BAD_SIGNATURE', 'REQUEST_REPLAY', 'REVOKED_READER_USED', 'LOST_CARD_PRESENTED', 'BLOCKED_CARD_PRESENTED', 'COUNTER_REGRESSION']) {
      expect(kinds).toContain(k);
    }
    expect(await h.prisma.accessLog.count({ where: { decision: 'DENY', authMethod: 'VIRTUAL_TAP' } })).toBeGreaterThan(0);
  });
});
