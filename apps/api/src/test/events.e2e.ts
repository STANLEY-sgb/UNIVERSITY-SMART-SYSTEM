import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Harness, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { ReaderCreds, adminToken, makeCard, makeStudent, provisionReader, staffToken, verify } from './access-fixtures';

/** Opens a real SSE connection and collects `event:` / `data:` frames. */
function openStream(port: number, token: string | null) {
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  let status = 0;
  let ctype = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'text/event-stream' } });
  const ready = new Promise<void>((resolve, reject) => {
    req.on('response', (res) => {
      status = res.statusCode ?? 0; ctype = String(res.headers['content-type'] ?? '');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  const waitFor = async (pred: (f: { event: string; data: Record<string, unknown> }) => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`no matching event in ${ms} ms; saw ${JSON.stringify(frames)}`);
  };
  return { ready, frames, waitFor, close: () => req.destroy(), get status() { return status; }, get ctype() { return ctype; } };
}

describe('live events over server-sent events (e2e, real HTTP)', () => {
  let h: Harness;
  let port: number;
  let admin: string, cafe: string;
  let gate: ReaderCreds;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    const server = h.app.getHttpServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    admin = await adminToken(h);
    cafe = await staffToken(h, 'CAFETERIA_OPERATOR');
    gate = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it('needs a login and the dashboard permission', async () => {
    const anon = openStream(port, null); await anon.ready; expect(anon.status).toBe(401); anon.close();
    const noPerm = openStream(port, cafe); await noPerm.ready; expect(noPerm.status).toBe(403); noPerm.close();
  });

  it('pushes decisions and alerts as they happen, with no personal data', async () => {
    const s = openStream(port, admin);
    await s.ready;
    expect(s.status).toBe(200);
    expect(s.ctype).toContain('text/event-stream');

    const student = await makeStudent(h.prisma, {});
    const card = await makeCard(h.prisma, student.id);
    await verify(h, gate, card.qr()).expect(200);
    const grant = await s.waitFor((f) => f.event === 'decision' && f.data.decision === 'GRANT');
    expect(grant.data).toMatchObject({ type: 'decision', service: 'GATE', offline: false });
    expect(JSON.stringify(grant.data)).not.toContain(student.regNo);

    await verify(h, gate, 'KIU1.garbage.garbage').expect(200); // not a valid credential: denied
    await s.waitFor((f) => f.event === 'decision' && f.data.decision === 'DENY');

    const lost = await makeCard(h.prisma, student.id, 'LOST');
    await verify(h, gate, lost.qr()).expect(200); // raises a LOST_CARD_PRESENTED alert
    const alert = await s.waitFor((f) => f.event === 'alert' && f.data.kind === 'LOST_CARD_PRESENTED');
    expect(alert.data).toMatchObject({ severity: 'HIGH' });
    s.close();
  });

  it('releases the connection slot when a client disconnects', async () => {
    const svc = (await import('../modules/events/events.module')).EventsService;
    const events = h.app.get(svc);
    for (let t0 = Date.now(); events.streams !== 0 && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 25)); // earlier tests' streams
    const before = events.streams;
    const s = openStream(port, admin); await s.ready;
    for (let t0 = Date.now(); events.streams === before && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 25));
    expect(events.streams).toBe(before + 1);
    s.close();
    const t0 = Date.now();
    while (events.streams !== before && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    expect(events.streams).toBe(before);
  });
});
