import { ReaderClient, SimWallet } from '@kiu/simulator';
import { Harness, startHarness } from './harness';
import { adminToken, apiFor, makeStudentUser, provisionReader, staffToken } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('admin console API: dashboard, alerts, services, student overview (e2e)', () => {
  let h: Harness;
  let admin: string, officer: string, reader: ReaderClient;
  const api = () => apiFor(h);
  const get = (p: string, t: string) => api().call('GET', p, undefined, t);

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'CARD_OFFICER');
    reader = new ReaderClient(api(), await provisionReader(h, admin, 'GATE', 'GATE-MAIN'));
  }, 120_000);
  afterAll(async () => { await h.close(); });

  async function wallet() {
    const u = await makeStudentUser(h);
    const i = await api().call('POST', '/cards', { regNo: u.student.regNo }, officer);
    return { u, w: await SimWallet.activate(api(), u.token, i.body.activationCode, i.body.card.cardNumber), cardId: i.body.card.id as string };
  }

  describe('GET /dashboard/summary', () => {
    it('is built from live data: new decisions move today\'s counters, denial reasons and the service breakdown', async () => {
      const before = (await get('/dashboard/summary', admin)).body;
      const a = await wallet();
      await reader.verify({ type: 'QR', token: a.w.qr() });                                  // GRANT
      await reader.verify({ type: 'QR', token: a.w.qr({ nowSeconds: Math.floor(Date.now() / 1000) - 400, counter: 999 }) }); // DENY expired
      const after = (await get('/dashboard/summary', admin)).body;

      expect(after.today.grants).toBe(before.today.grants + 1);
      expect(after.today.denies).toBe(before.today.denies + 1);
      // Reason counters are a shared top-N across the whole database, so assert shape and ordering, not a specific reason.
      const counts = after.topDenialReasons.map((r: { count: number }) => r.count);
      expect(counts.length).toBeGreaterThan(0);
      expect([...counts].sort((x: number, y: number) => y - x)).toEqual(counts);
      expect(after.byService.find((s: { code: string }) => s.code === 'GATE')).toMatchObject({ name: 'Campus Gate' });
      expect(after.cards.ACTIVE).toBeGreaterThanOrEqual((before.cards.ACTIVE ?? 0) + 1);
      expect(after.students.active).toBeGreaterThanOrEqual(12);
      expect(after.hourly.length).toBeGreaterThan(0);
      expect(after.recentDecisions[0]).toMatchObject({ decision: expect.any(String), reasonCode: expect.any(String) });
    });

    it('counts a reader as online only after a recent heartbeat', async () => {
      const r = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
      const before = (await get('/dashboard/summary', admin)).body.readers.online;
      const hb = await new ReaderClient(api(), r).post('/readers/heartbeat', { queuedLogs: 0 });
      expect(hb.status).toBe(200);
      expect((await get('/dashboard/summary', admin)).body.readers.online).toBe(before + 1);
      await h.prisma.reader.update({ where: { id: r.id }, data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) } });
      expect((await get('/dashboard/summary', admin)).body.readers.online).toBe(before);
    });

    it('only includes sections the caller may see (minimum data per role)', async () => {
      const finance = (await get('/dashboard/summary', await staffToken(h, 'FINANCE_OFFICER'))).body;
      expect(finance.today).toBeDefined();
      expect(finance).not.toHaveProperty('recentDecisions');   // needs access.logs.view
      expect(finance).not.toHaveProperty('recentAdminActions'); // needs audit.view

      const mgmt = (await get('/dashboard/summary', await staffToken(h, 'MANAGEMENT'))).body;
      expect(mgmt).toHaveProperty('recentDecisions');
      expect(mgmt.recentAdminActions.length).toBeGreaterThan(0);
      expect(mgmt.recentAdminActions[0]).toHaveProperty('actor');
    });

    it('is refused to students, to staff without reports.view, and to anonymous callers', async () => {
      const s = await makeStudentUser(h);
      expect((await get('/dashboard/summary', s.token)).status).toBe(403);
      expect((await get('/dashboard/summary', await staffToken(h, 'CAFETERIA_OPERATOR'))).status).toBe(403);
      expect((await api().call('GET', '/dashboard/summary')).status).toBe(401);
    });
  });

  describe('alerts', () => {
    it('lists open alerts, filters by severity, acknowledges once and audits it', async () => {
      const a = await wallet();
      await api().call('POST', `/cards/${a.cardId}/report-lost`, { reason: 'Stolen in town' }, officer);
      await reader.verify({ type: 'QR', token: a.w.qr() }); // raises LOST_CARD_PRESENTED (HIGH)

      const security = await staffToken(h, 'SECURITY_OFFICER');
      const open = await get('/alerts?severity=HIGH&pageSize=50', security);
      expect(open.status).toBe(200);
      const mine = open.body.data.find((x: { kind: string; student: { regNo: string } | null }) => x.kind === 'LOST_CARD_PRESENTED' && x.student?.regNo === a.u.student.regNo);
      expect(mine).toBeDefined();
      expect(mine.ackedAt).toBeNull();

      const ack = await api().call('POST', `/alerts/${mine.id}/ack`, { note: 'Student contacted, card already replaced' }, security);
      expect(ack.status).toBe(200);
      expect(ack.body.already).toBe(false);
      expect((await api().call('POST', `/alerts/${mine.id}/ack`, {}, security)).body.already).toBe(true);

      const stillOpen = (await get('/alerts?severity=HIGH&pageSize=100', security)).body.data;
      expect(stillOpen.find((x: { id: string }) => x.id === mine.id)).toBeUndefined();
      const done = (await get('/alerts?state=acknowledged&pageSize=100', security)).body.data;
      expect(done.find((x: { id: string }) => x.id === mine.id)).toBeDefined();
      expect(await h.prisma.auditTrail.count({ where: { action: 'alerts.acknowledged', entityId: mine.id } })).toBe(1);
      expect((await api().call('POST', `/alerts/00000000-0000-4000-8000-000000000000/ack`, {}, security)).status).toBe(404);
    });

    it('is permission-gated: finance cannot see alerts; management can see but not acknowledge', async () => {
      expect((await get('/alerts', await staffToken(h, 'FINANCE_OFFICER'))).status).toBe(403);
      const mgmt = await staffToken(h, 'MANAGEMENT');
      const list = await get('/alerts', mgmt);
      expect(list.status).toBe(200);
      if (list.body.data[0]) expect((await api().call('POST', `/alerts/${list.body.data[0].id}/ack`, {}, mgmt)).status).toBe(403);
    });
  });

  describe('services and student overview', () => {
    it('lists services with published rule version, draft flag, offline policy and reader count', async () => {
      const r = await get('/services', admin);
      expect(r.status).toBe(200);
      const gate = r.body.find((s: { code: string }) => s.code === 'GATE');
      expect(gate).toMatchObject({ offlinePolicy: 'CACHED_ALLOW', publishedVersion: 1, hasDraft: false });
      expect(gate.readers).toBeGreaterThan(0);
      expect(r.body.find((s: { code: string }) => s.code === 'EXAM').offlinePolicy).toBe('DENY_ALL');
      expect((await get('/services', await staffToken(h, 'REGISTRY_OFFICER'))).status).toBe(403);
    });

    it('student overview returns each role only what it may see', async () => {
      const a = await wallet();
      await reader.verify({ type: 'QR', token: a.w.qr() });
      const id = a.u.student.id;

      const registry = (await get(`/students/${id}/overview`, await staffToken(h, 'REGISTRY_OFFICER'))).body;
      expect(registry.facts).toMatchObject({ account_active: true, fees_paid_percent: 100 });
      expect(registry.cards).toBeNull();
      expect(registry.recentAccess).toBeNull();

      const cardOfficer = (await get(`/students/${id}/overview`, officer)).body;
      expect(cardOfficer.facts).toBeNull();                 // card office does not see fees/fines
      expect(cardOfficer.cards[0]).toMatchObject({ status: 'ACTIVE' });
      expect(cardOfficer.recentAccess.length).toBeGreaterThan(0);

      const security = (await get(`/students/${id}/overview`, await staffToken(h, 'SECURITY_OFFICER'))).body;
      expect(security.facts).toBeNull();
      expect(security.cards).toBeNull();
      expect(security.recentAccess[0]).toHaveProperty('decision');

      expect((await get(`/students/${id}/overview`, a.u.token)).status).toBe(403); // a student cannot use the staff endpoint
      expect((await get('/students/00000000-0000-4000-8000-000000000000/overview', officer)).status).toBe(404);
    });
  });
});
