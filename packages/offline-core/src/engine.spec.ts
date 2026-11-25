import { canonicalJson } from '@kiu/shared';
import { generateQrKeyPair, publicKeyHexFromPrivate, signMessage, signQr } from '@kiu/vcard';
import { MAX_QUEUE, MemoryStore, OfflineEngine, OfflineManifest, SignedManifest } from './index';

const SERVER = generateQrKeyPair(); // plays the API's cache-signing key
const READER = { readerCode: 'RDR-GATE-01', serviceCode: 'GATE' };
const NOW = 1_800_000_000_000;

interface Wallet { cn: string; keys: ReturnType<typeof generateQrKeyPair>; ctr: number; qr: (o?: { ctr?: number; at?: number }) => string }
const wallet = (cn: string): Wallet => {
  const keys = generateQrKeyPair();
  const w: Wallet = { cn, keys, ctr: 0, qr: (o = {}) => signQr(keys.privateKeyHex, { cardNumber: cn, counter: o.ctr ?? ++w.ctr, nowSeconds: Math.floor((o.at ?? NOW) / 1000) }) };
  return w;
};

function signed(over: Partial<OfflineManifest> = {}, wallets: Wallet[] = [], signer = SERVER): SignedManifest {
  const manifest: OfflineManifest = {
    v: 1, reader: READER.readerCode, service: READER.serviceCode, policy: 'CACHED_ALLOW', version: 1,
    issuedAt: new Date(NOW).toISOString(), validUntil: new Date(NOW + 30 * 60_000).toISOString(), revocationVersion: 5,
    cards: wallets.map((w) => ({ cn: w.cn, pk: [w.keys.publicKeyHex], name: `Student ${w.cn}`, exp: new Date(NOW + 365 * 86_400_000).toISOString() })),
    revoked: [], ...over,
  };
  return { manifest, signature: signMessage(signer.privateKeyHex, canonicalJson(manifest)), signerPublicKeyHex: signer.publicKeyHex };
}

async function setup(over: Partial<OfflineManifest> = {}, wallets: Wallet[] = [wallet('KIU-A')]) {
  const store = new MemoryStore();
  let now = NOW;
  const engine = new OfflineEngine(store, READER, () => now);
  const res = await engine.acceptManifest(signed(over, wallets));
  expect(res.ok).toBe(true);
  return { store, engine, wallets, setNow: (n: number) => { now = n; } };
}

describe('manifest acceptance', () => {
  it('derives the same public key the server advertises', () => {
    expect(publicKeyHexFromPrivate(SERVER.privateKeyHex)).toBe(SERVER.publicKeyHex);
  });

  it('accepts a correctly signed manifest and pins the signer on first use', async () => {
    const store = new MemoryStore();
    const engine = new OfflineEngine(store, READER, () => NOW);
    expect((await engine.acceptManifest(signed())).ok).toBe(true);
    expect(await store.getPinnedSigner()).toBe(SERVER.publicKeyHex);
  });

  it('rejects a manifest whose content was altered after signing', async () => {
    const m = signed({}, [wallet('KIU-A')]);
    m.manifest.cards.push({ cn: 'KIU-EVIL', pk: [generateQrKeyPair().publicKeyHex], name: 'Injected', exp: new Date(NOW + 1e9).toISOString() });
    const engine = new OfflineEngine(new MemoryStore(), READER, () => NOW);
    expect(await engine.acceptManifest(m)).toEqual({ ok: false, error: 'BAD_SIGNATURE' });
  });

  it('rejects a manifest signed by a different key once a signer is pinned', async () => {
    const { engine } = await setup();
    const attacker = generateQrKeyPair();
    expect(await engine.acceptManifest(signed({ version: 2 }, [], attacker))).toEqual({ ok: false, error: 'SIGNER_MISMATCH' });
  });

  it('rejects garbage signatures without throwing', async () => {
    const m = signed();
    const engine = new OfflineEngine(new MemoryStore(), READER, () => NOW);
    for (const signature of ['', 'zz', 'ab'.repeat(10), '00'.repeat(64)]) {
      expect((await engine.acceptManifest({ ...m, signature })).ok).toBe(false);
    }
  });

  it.each([
    ['another reader', { reader: 'RDR-OTHER' }, 'WRONG_READER'],
    ['another service', { service: 'EXAM' }, 'WRONG_SERVICE'],
    ['an expired manifest', { validUntil: new Date(NOW - 1).toISOString() }, 'EXPIRED'],
  ])('rejects a manifest for %s', async (_n, over, error) => {
    const engine = new OfflineEngine(new MemoryStore(), READER, () => NOW);
    expect(await engine.acceptManifest(signed(over as Partial<OfflineManifest>))).toEqual({ ok: false, error });
  });

  it('refuses to roll back to an older list (which could hide newer revocations)', async () => {
    const { engine } = await setup({ version: 7 });
    expect(await engine.acceptManifest(signed({ version: 6 }))).toEqual({ ok: false, error: 'REGRESSED_VERSION' });
    expect((await engine.acceptManifest(signed({ version: 8 }))).ok).toBe(true);
  });
});

describe('offline decisions', () => {
  it('TC-07: grants a valid cached credential and queues an idempotent log entry', async () => {
    const { engine, store, wallets } = await setup();
    const d = await engine.decide(wallets[0]!.qr(), 'ENTRY');
    expect(d).toMatchObject({ decision: 'GRANT', reason: 'OK', name: 'Student KIU-A' });
    expect(d.entry).toMatchObject({ cardNumber: 'KIU-A', decision: 'GRANT', direction: 'ENTRY', manifestVersion: 1, counter: 1 });
    expect(d.entry!.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(await store.queueSize()).toBe(1);
  });

  it('measured: offline decisions complete well inside the 300 ms target', async () => {
    const w = wallet('KIU-PERF');
    const { engine } = await setup({}, [w]);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await engine.decide(w.qr(), 'ENTRY');
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`offline decide x200: p50=${times[100]!.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${times[199]!.toFixed(2)}ms`);
    expect(p95).toBeLessThan(300);
  });

  it('fails closed with no manifest, an expired manifest, or a DENY_ALL policy (exam/cafeteria style services)', async () => {
    const w = wallet('KIU-A');
    const none = new OfflineEngine(new MemoryStore(), READER, () => NOW);
    expect((await none.decide(w.qr())).reason).toBe('OFFLINE_NOT_SYNCED');

    const { engine, setNow } = await setup({}, [w]);
    setNow(NOW + 31 * 60_000);
    expect((await engine.decide(w.qr({ at: NOW + 31 * 60_000 }))).reason).toBe('OFFLINE_CACHE_STALE');

    const strict = await setup({ policy: 'DENY_ALL', cards: [] }, []);
    expect((await strict.engine.decide(w.qr())).reason).toBe('OFFLINE_NOT_PERMITTED');
  });

  it('detects tampering with the persisted manifest between sync and use', async () => {
    const { engine, store, wallets } = await setup({}, [wallet('KIU-A')]);
    store.tamperManifest((m) => { m.revoked = []; m.cards.push({ cn: 'KIU-EVIL', pk: [wallets[0]!.keys.publicKeyHex], name: 'x', exp: new Date(NOW + 1e9).toISOString() }); });
    const d = await engine.decide(wallets[0]!.qr());
    expect(d).toMatchObject({ decision: 'DENY', reason: 'OFFLINE_CACHE_STALE' });
  });

  it('denies revoked, unknown and expired cards', async () => {
    const lost = wallet('KIU-LOST'), ghost = wallet('KIU-GHOST'), old = wallet('KIU-OLD');
    const { engine } = await setup({ revoked: ['KIU-LOST'] }, [old]);
    expect((await engine.decide(lost.qr())).reason).toBe('CARD_REVOKED');
    expect((await engine.decide(ghost.qr())).reason).toBe('CREDENTIAL_INVALID');

    const exp = await setup({}, [old]);
    exp.store.tamperManifest(() => undefined);
    const stale = signed({ cards: [{ cn: 'KIU-OLD', pk: [old.keys.publicKeyHex], name: 'Old', exp: new Date(NOW - 1000).toISOString() }] });
    await exp.engine.acceptManifest({ ...stale, manifest: { ...stale.manifest, version: 2 }, signature: signMessage(SERVER.privateKeyHex, canonicalJson({ ...stale.manifest, version: 2 })) });
    expect((await exp.engine.decide(old.qr())).reason).toBe('CARD_EXPIRED');
  });

  it('denies forged, modified, malformed and expired QR tokens', async () => {
    const w = wallet('KIU-A');
    const { engine } = await setup({}, [w]);
    expect((await engine.decide(flipMiddle(w.qr({ ctr: 1 })))).reason).toBe('CREDENTIAL_INVALID'); // flipped signature char
    expect((await engine.decide(signQr(generateQrKeyPair().privateKeyHex, { cardNumber: 'KIU-A', counter: 9, nowSeconds: NOW / 1000 }))).reason).toBe('CREDENTIAL_INVALID'); // attacker key
    expect((await engine.decide('garbage')).reason).toBe('CREDENTIAL_INVALID');
    expect((await engine.decide(w.qr({ at: NOW - 120_000 }))).reason).toBe('CREDENTIAL_EXPIRED');

    const [p, pl, s] = w.qr().split('.') as [string, string, string];
    const body = JSON.parse(Buffer.from(pl, 'base64url').toString());
    const forged = `${p}.${Buffer.from(JSON.stringify({ ...body, exp: body.exp + 999 })).toString('base64url')}.${s}`;
    expect((await engine.decide(forged)).reason).toBe('CREDENTIAL_INVALID');
  });

  it('rejects a replayed QR and a regressed counter locally', async () => {
    const w = wallet('KIU-A');
    const { engine } = await setup({}, [w]);
    const qr = w.qr({ ctr: 5 });
    expect((await engine.decide(qr)).decision).toBe('GRANT');
    expect((await engine.decide(qr)).reason).toBe('NONCE_REPLAY');
    expect((await engine.decide(w.qr({ ctr: 4 }))).reason).toBe('COUNTER_INVALID');
    expect((await engine.decide(w.qr({ ctr: 6 }))).decision).toBe('GRANT');
  });

  it('records denied-but-identified scans too, but never invents entries for unidentifiable credentials', async () => {
    const w = wallet('KIU-A');
    const { engine, store } = await setup({ revoked: ['KIU-LOST'] }, [w]);
    await engine.decide(wallet('KIU-LOST').qr());
    expect((await store.peekQueue(10)).map((e) => e.reasonCode)).toEqual(['CARD_REVOKED']);
    await engine.decide('garbage');
    expect(await store.queueSize()).toBe(1);
  });

  it('refuses new grants when the local log is full', async () => {
    const w = wallet('KIU-A');
    const { engine, store } = await setup({}, [w]);
    for (let i = 0; i < MAX_QUEUE; i++) await store.enqueue({ idempotencyKey: `k${i}`.padEnd(16, 'x'), cardNumber: 'X', decision: 'DENY', reasonCode: 'X', occurredAt: '', counter: 0, manifestVersion: 1 });
    expect((await engine.decide(w.qr())).reason).toBe('OFFLINE_QUEUE_FULL');
  });
});

describe('log synchronisation', () => {
  it('uploads in batches and only clears entries the server acknowledged', async () => {
    const w = wallet('KIU-A');
    const { engine, store } = await setup({}, [w]);
    for (let i = 0; i < 5; i++) await engine.decide(w.qr());
    const batches: number[] = [];
    const r = await engine.flush(async (b) => { batches.push(b.entries.length); return { ok: true }; }, 2);
    expect(r).toEqual({ sent: 5, failed: false });
    expect(batches).toEqual([2, 2, 1]);
    expect(await store.queueSize()).toBe(0);
  });

  it('keeps everything queued when the upload fails, and retries the SAME batch key', async () => {
    const w = wallet('KIU-A');
    const { engine, store } = await setup({}, [w]);
    await engine.decide(w.qr());
    await engine.decide(w.qr());
    const keys: string[] = [];
    const down = await engine.flush(async (b) => { keys.push(b.batchKey); throw new Error('network'); });
    expect(down).toEqual({ sent: 0, failed: true });
    expect(await store.queueSize()).toBe(2);
    await engine.flush(async (b) => { keys.push(b.batchKey); return { ok: true }; });
    expect(keys[1]).toBe(keys[0]); // lost response => the server dedupes by batch key
    expect(await store.queueSize()).toBe(0);
  });
});

/** Flips one character in the middle of the signature. (The final base64url char of a 64-byte signature carries only 4 real bits, so flipping it can decode to the same bytes.) */
function flipMiddle(token: string): string {
  const i = token.length - 20;
  return token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
}
