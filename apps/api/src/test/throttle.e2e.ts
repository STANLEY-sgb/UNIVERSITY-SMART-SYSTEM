import { randomBytes } from 'node:crypto';
import { Harness, startHarness } from './harness';
import { adminToken, makeCard, makeStudent, provisionReader, verify } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('rate limiting keeps device traffic and people separate (e2e)', () => {
  let h: Harness;
  beforeAll(async () => {
    // Small limits so the behaviour is observable: people 5/min, each reader 8/min, whole IP 20 reader requests/min.
    h = await startHarness({ THROTTLE_DEFAULT_LIMIT: '5', THROTTLE_READER_LIMIT: '8', THROTTLE_READER_IP_LIMIT: '20', THROTTLE_LOGIN_LIMIT: '1000' });
    await seedDemo(h.prisma, { students: 12 });
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it('reader traffic is not counted against the per-IP limit for people, and is capped per reader key', async () => {
    // Admin set-up calls must not eat the people-budget: give the admin its token first, then count only reader requests.
    const admin = await adminToken(h);
    const a = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    const b = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    const card = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);

    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await verify(h, a, card.qr())).status);
    // 5/min would have throttled by now if readers shared the people budget; instead the reader's own 8/min applies.
    expect(codes.slice(0, 8).every((c) => c === 200)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);

    // A different reader behind the same IP is unaffected by the first reader's burst.
    expect((await verify(h, b, card.qr())).status).toBe(200);
  });

  it('people are still limited per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await h.http().get('/api/v1/students')).status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes).toContain(429);
  });

  it('spoofed reader key ids cannot bypass limiting: the per-IP reader ceiling still applies', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await h.http().post('/api/v1/access/verify')
        .set('X-Reader-Key-Id', `rk_${randomBytes(6).toString('hex')}`).set('X-Timestamp', '1').set('X-Nonce', 'n'.repeat(16)).set('X-Signature', 'x')
        .send({ credential: { type: 'QR', token: 'x' } });
      statuses.push(r.status);
    }
    expect(statuses).toContain(401);   // unknown key rejected by the reader guard...
    expect(statuses).toContain(429);   // ...but not unlimited
  });
});
