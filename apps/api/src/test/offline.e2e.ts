import { randomBytes } from 'node:crypto';
import { canonicalJson } from '@kiu/shared';
import { MemoryStore, OfflineEngine, SignedManifest } from '@kiu/offline-core';
import { ReaderClient, SimWallet } from '@kiu/simulator';
import { publicKeyHexFromPrivate, verifyMessage } from '@kiu/vcard';
import { Harness, startHarness } from './harness';
import { ReaderCreds, adminToken, apiFor, makeStudent, makeStudentUser, provisionReader, staffToken } from './access-fixtures';
import { seedDemo } from '../seed/demo';

describe('offline mode: signed allow-list, local decisions, idempotent reconciliation (e2e)', () => {
  let h: Harness;
  let admin: string, officer: string;
  let gateCreds: ReaderCreds, examCreds: ReaderCreds;
  let gate: ReaderClient, examReader: ReaderClient;
  const api = () => apiFor(h);

  beforeAll(async () => {
    h = await startHarness({ OFFLINE_CACHE_TTL_MINUTES: '30' });
    await seedDemo(h.prisma, { students: 12 });
    admin = await adminToken(h);
    officer = await staffToken(h, 'CARD_OFFICER');
    gateCreds = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    examCreds = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    gate = new ReaderClient(api(), gateCreds);
    examReader = new ReaderClient(api(), examCreds);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  async function wallet(spec: Parameters<typeof makeStudentUser>[1] = {}) {
    const u = await makeStudentUser(h, spec);
    const i = await api().call('POST', '/cards', { regNo: u.student.regNo }, officer);
    const w = await SimWallet.activate(api(), u.token, i.body.activationCode, i.body.card.cardNumber, i.body.card.id);
    return { u, w, cardId: i.body.card.id as string };
  }
  const fetchManifest = async (r: ReaderClient, creds: ReaderCreds) => {
    const res = await r.get(`/readers/${creds.id}/allowlist`);
    expect(res.status).toBe(200);
    return res.body as SignedManifest;
  };
  const engineFor = (creds: ReaderCreds, service: string) => new OfflineEngine(new MemoryStore(), { readerCode: creds.code, serviceCode: service });

  describe('GET /readers/:id/allowlist', () => {
    it('is signed by the server key, scoped to the reader, versioned and short-lived', async () => {
      const a = await wallet();
      const m1 = await fetchManifest(gate, gateCreds);
      const m2 = await fetchManifest(gate, gateCreds);
      expect(m1.signerPublicKeyHex).toBe(publicKeyHexFromPrivate(h.env.CACHE_SIGNING_KEY));
      expect(verifyMessage(m1.signerPublicKeyHex, canonicalJson(m1.manifest), m1.signature)).toBe(true);
      expect(m1.manifest).toMatchObject({ v: 1, reader: gateCreds.code, service: 'GATE', policy: 'CACHED_ALLOW' });
      expect(m2.manifest.version).toBe(m1.manifest.version + 1);
      const ttl = Date.parse(m1.manifest.validUntil) - Date.parse(m1.manifest.issuedAt);
      expect(ttl).toBe(30 * 60_000);
      expect(m1.manifest.cards.find((c) => c.cn === a.w.cardNumber)).toMatchObject({ pk: [a.w.devicePublicKeyHex] });
      expect(await h.prisma.readerCacheVersion.count({ where: { readerId: gateCreds.id } })).toBe(2);
    });

    it('contains only active, unexpired cards of active students — and the minimum fields', async () => {
      const ok = await wallet();
      const lost = await wallet();
      const blocked = await wallet();
      const suspended = await wallet();
      const pendingU = await makeStudentUser(h);
      await api().call('POST', '/cards', { regNo: pendingU.student.regNo }, officer);
      await api().call('POST', `/cards/${lost.cardId}/report-lost`, { reason: 'Lost at the market' }, officer);
      await api().call('POST', `/cards/${blocked.cardId}/block`, { reason: 'Disciplinary hold' }, officer);
      await h.prisma.student.update({ where: { id: suspended.u.student.id }, data: { accountStatus: 'SUSPENDED' } });

      const { manifest } = await fetchManifest(gate, gateCreds);
      const inList = new Set(manifest.cards.map((c) => c.cn));
      expect(inList.has(ok.w.cardNumber)).toBe(true);
      for (const x of [lost, blocked, suspended]) expect(inList.has(x.w.cardNumber)).toBe(false);
      expect(manifest.revoked).toEqual(expect.arrayContaining([lost.w.cardNumber, blocked.w.cardNumber]));
      expect(Object.keys(manifest.cards[0]!).sort()).toEqual(['cn', 'exp', 'name', 'pk']);
      const raw = JSON.stringify(manifest);
      for (const s of [ok, lost, blocked, suspended]) expect(raw).not.toContain(s.u.student.regNo);
      expect(raw).not.toMatch(/regNo|reg_no|uid|aesKey|activation|email|phone|passwordHash/i);
    });

    it('gives DENY_ALL services an empty list so a reader fails closed (exam hall)', async () => {
      await wallet();
      const res = await fetchManifest(examReader, examCreds);
      expect(res.manifest).toMatchObject({ policy: 'DENY_ALL', cards: [], revoked: [], service: 'EXAM' });
      const engine = engineFor(examCreds, 'EXAM');
      expect((await engine.acceptManifest(res)).ok).toBe(true);
    });

    it('requires reader authentication and refuses another reader\'s id', async () => {
      await h.http().get(`/api/v1/readers/${gateCreds.id}/allowlist`).expect(401);
      const other = await gate.get(`/readers/${examCreds.id}/allowlist`);
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('READER_MISMATCH');
      expect((await gate.get('/readers/not-a-uuid/allowlist')).status).toBe(400);
      // a signature for a different path/method must not be reusable
      const replay = await gate.get(`/readers/${gateCreds.id}/allowlist`, { nonce: 'n'.repeat(24), timestamp: String(Math.floor(Date.now() / 1000)) });
      expect(replay.status).toBe(200);
      expect((await gate.get(`/readers/${gateCreds.id}/allowlist`, { nonce: 'n'.repeat(24), timestamp: String(Math.floor(Date.now() / 1000)) })).status).toBe(409);
    });
  });

  describe('TC-07 / demo 7: offline gate, queued logs, reconciliation', () => {
    it('reader syncs, goes offline, decides locally, reconnects and uploads idempotently', async () => {
      const a = await wallet();
      const b = await wallet();
      const engine = engineFor(gateCreds, 'GATE');
      expect((await engine.acceptManifest(await fetchManifest(gate, gateCreds))).ok).toBe(true);

      // ---- network "down": nothing below touches the API ----
      const d1 = await engine.decide(a.w.qr(), 'ENTRY');
      const d2 = await engine.decide(b.w.qr(), 'ENTRY');
      const replay = await engine.decide(a.w.qr({ counter: 1 }), 'ENTRY'); // counter already used locally
      const late = await wallet(); // enrolled AFTER the sync: unknown to this reader
      const outsider = await engine.decide(late.w.qr());
      expect([d1.decision, d2.decision]).toEqual(['GRANT', 'GRANT']);
      expect(replay.decision).toBe('DENY');
      expect(outsider).toMatchObject({ decision: 'DENY', reason: 'CREDENTIAL_INVALID' });
      expect(d1.name).toBe(a.u.student.fullName);

      // ---- network "up": reconcile ----
      const uploads: { duplicate: boolean; accepted: number; duplicates: number; conflicts: number }[] = [];
      const upload = async (batch: { batchKey: string; entries: unknown[] }) => {
        const r = await gate.post(`/readers/${gateCreds.id}/logs`, batch);
        if (r.status === 200) uploads.push(r.body);
        return { ok: r.status === 200 };
      };
      const flushed = await engine.flush(upload);
      expect(flushed.failed).toBe(false);
      expect(flushed.sent).toBe(4); // 2 grants + the replay denial + the unknown-card denial (all carry a card number, so all are reconciled)
      expect(uploads[0]).toMatchObject({ duplicate: false, conflicts: 0 });

      const rows = await h.prisma.accessLog.findMany({ where: { readerId: gateCreds.id, offline: true, cardId: { in: [a.cardId, b.cardId] } }, orderBy: { occurredAt: 'asc' } });
      expect(rows.map((r) => r.decision)).toEqual(expect.arrayContaining(['GRANT', 'GRANT', 'DENY']));
      expect(rows.every((r) => r.offline && r.authMethod === 'QR')).toBe(true);
      expect(rows.find((r) => r.studentId === a.u.student.id && r.decision === 'GRANT')?.direction).toBe('ENTRY');
      // The late card is real on the server, so the reader's refusal is reconciled against it (audit trail), as a DENY.
      const lateRow = await h.prisma.accessLog.findFirst({ where: { cardId: late.cardId, offline: true } });
      expect(lateRow).toMatchObject({ decision: 'DENY', reasonCode: 'CREDENTIAL_INVALID' });
      expect(await h.prisma.offlineLogBatch.count({ where: { readerId: gateCreds.id, reconciledAt: { not: null } } })).toBeGreaterThan(0);
    });

    it('re-uploading the same batch (lost response) creates no duplicates', async () => {
      const a = await wallet();
      const engine = engineFor(gateCreds, 'GATE');
      await engine.acceptManifest(await fetchManifest(gate, gateCreds));
      await engine.decide(a.w.qr(), 'ENTRY');
      const batch = { batchKey: `b-${randomBytes(12).toString('hex')}`, entries: await (engine as unknown as { store: MemoryStore }).store.peekQueue(10) };
      const first = await gate.post(`/readers/${gateCreds.id}/logs`, batch);
      const again = await gate.post(`/readers/${gateCreds.id}/logs`, batch);
      expect(first.body).toMatchObject({ duplicate: false, accepted: 1 });
      expect(again.body).toMatchObject({ duplicate: true, accepted: 0 });
      // even under a NEW batch key the per-entry idempotency key prevents a second row
      const rekeyed = await gate.post(`/readers/${gateCreds.id}/logs`, { ...batch, batchKey: `b-${randomBytes(12).toString('hex')}` });
      expect(rekeyed.body).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await h.prisma.accessLog.count({ where: { cardId: a.cardId, offline: true } })).toBe(1);
    });

    it('flags a grant made on a stale cache after the card was reported lost, and alerts', async () => {
      const a = await wallet();
      const engine = engineFor(gateCreds, 'GATE');
      await engine.acceptManifest(await fetchManifest(gate, gateCreds));
      await api().call('POST', `/cards/${a.cardId}/report-lost`, { reason: 'Stolen after the reader synced' }, officer);
      const d = await engine.decide(a.w.qr(), 'ENTRY');
      expect(d.decision).toBe('GRANT'); // the isolated reader cannot know: the documented, unavoidable limitation
      const before = await h.prisma.securityAlert.count({ where: { kind: 'OFFLINE_STALE_GRANT', readerId: gateCreds.id } });
      const res = await engine.flush(async (batch) => {
        const r = await gate.post(`/readers/${gateCreds.id}/logs`, batch);
        expect(r.body.conflicts).toBe(1);
        return { ok: r.status === 200 };
      });
      expect(res.failed).toBe(false);
      expect(await h.prisma.securityAlert.count({ where: { kind: 'OFFLINE_STALE_GRANT', readerId: gateCreds.id } })).toBe(before + 1);
      const log = await h.prisma.accessLog.findFirstOrThrow({ where: { cardId: a.cardId, offline: true } });
      expect(log.message).toMatch(/stale cache/);
      expect(log.context).toMatchObject({ conflict: true });
    });

    it('a fresh sync after the revocation makes the reader deny the lost card', async () => {
      const a = await wallet();
      const engine = engineFor(gateCreds, 'GATE');
      await api().call('POST', `/cards/${a.cardId}/report-lost`, { reason: 'Lost before sync' }, officer);
      await engine.acceptManifest(await fetchManifest(gate, gateCreds));
      expect((await engine.decide(a.w.qr())).reason).toBe('CARD_REVOKED');
    });

    it('offline acceptance advances the server counter, so the same QR cannot be replayed online afterwards', async () => {
      const a = await wallet();
      const engine = engineFor(gateCreds, 'GATE');
      await engine.acceptManifest(await fetchManifest(gate, gateCreds));
      const qr = a.w.qr();
      expect((await engine.decide(qr, 'ENTRY')).decision).toBe('GRANT');
      await engine.flush(async (b) => ({ ok: (await gate.post(`/readers/${gateCreds.id}/logs`, b)).status === 200 }));
      const online = await gate.verify({ type: 'QR', token: qr });
      expect(online.body).toMatchObject({ decision: 'DENY', reason_code: 'COUNTER_INVALID' });
      expect((await gate.verify({ type: 'QR', token: a.w.qr() })).body.decision).toBe('GRANT'); // the next fresh QR still works
    });

    it('validates uploads: size, timestamps, ids, authentication', async () => {
      const entry = (o: object = {}) => ({ idempotencyKey: randomBytes(12).toString('hex'), cardNumber: 'KIUX', decision: 'DENY', reasonCode: 'CREDENTIAL_INVALID', occurredAt: new Date().toISOString(), counter: 0, manifestVersion: 1, ...o });
      const post = (body: unknown) => gate.post(`/readers/${gateCreds.id}/logs`, body);
      expect((await post({ batchKey: randomBytes(12).toString('hex'), entries: [] })).status).toBe(400);
      expect((await post({ batchKey: 'short', entries: [entry()] })).status).toBe(400);
      expect((await post({ batchKey: randomBytes(12).toString('hex'), entries: Array.from({ length: 501 }, () => entry()) })).status).toBe(400);
      expect((await post({ batchKey: randomBytes(12).toString('hex'), entries: [entry({ decision: 'MAYBE' })] })).status).toBe(400);
      expect((await post({ batchKey: randomBytes(12).toString('hex'), entries: [entry({ extra: 'x' })] })).status).toBe(400);

      const res = await post({ batchKey: randomBytes(12).toString('hex'), entries: [
        entry({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),            // future
        entry({ occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }),      // too old
        entry(),
      ] });
      expect(res.body).toMatchObject({ accepted: 1, rejected: 2 });

      await h.http().post(`/api/v1/readers/${gateCreds.id}/logs`).send({}).expect(401);
      expect((await examReader.post(`/readers/${gateCreds.id}/logs`, { batchKey: randomBytes(12).toString('hex'), entries: [entry()] })).status).toBe(403);
    });

    it('does not let one reader hijack another reader\'s batch key', async () => {
      const key = randomBytes(12).toString('hex');
      const entry = { idempotencyKey: randomBytes(12).toString('hex'), cardNumber: 'KIUX', decision: 'DENY', reasonCode: 'CREDENTIAL_INVALID', occurredAt: new Date().toISOString(), counter: 0, manifestVersion: 1 };
      expect((await gate.post(`/readers/${gateCreds.id}/logs`, { batchKey: key, entries: [entry] })).status).toBe(200);
      const other = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
      const hijack = await new ReaderClient(api(), other).post(`/readers/${other.id}/logs`, { batchKey: key, entries: [{ ...entry, idempotencyKey: randomBytes(12).toString('hex') }] });
      expect(hijack.status).toBe(400);
      expect(hijack.body.code).toBe('BATCH_KEY_IN_USE');
    });
  });

  it('makeStudent helper sanity: unrelated fixtures never leak into manifests', async () => {
    const s = await makeStudent(h.prisma);
    const { manifest } = await fetchManifest(gate, gateCreds);
    expect(JSON.stringify(manifest)).not.toContain(s.regNo);
  });
});
