import { REASON_CODES, canonicalJson } from '@kiu/shared';
import { checkQrTime, parseQr } from '@kiu/vcard/dist/qr-format';

/**
 * Offline decision engine for readers. Pure logic over an injected store, so the identical code runs in the
 * reader's browser (IndexedDB store) and in Node tests (memory store).
 *
 * Security properties (see docs/SECURITY_MODEL.md):
 *  - the manifest is only trusted if its Ed25519 signature verifies against the PINNED signer key;
 *  - a stale manifest (past validUntil) or a DENY_ALL policy fails closed;
 *  - QR signatures are verified locally; nonces are single-use and counters strictly increase per card;
 *  - cards in the revoked list, unknown cards and expired cards are refused;
 *  - every decision is queued with an idempotency key for reconciliation.
 * LIMITATION (unavoidable): a reader that is offline cannot learn of revocations issued after its last sync.
 */

export interface OfflineManifest {
  v: 1; reader: string; service: string; policy: 'CACHED_ALLOW' | 'DENY_ALL'; version: number;
  issuedAt: string; validUntil: string; revocationVersion: number;
  cards: { cn: string; pk: string[]; name: string; exp: string }[];
  revoked: string[];
}
export interface SignedManifest { manifest: OfflineManifest; signature: string; signerPublicKeyHex: string }

export interface OfflineLogEntry {
  idempotencyKey: string; cardNumber: string; decision: 'GRANT' | 'DENY'; reasonCode: string;
  occurredAt: string; direction?: 'ENTRY' | 'EXIT'; counter: number; manifestVersion: number;
}

export interface OfflineStore {
  getPinnedSigner(): Promise<string | null>;
  pinSigner(hex: string): Promise<void>;
  saveManifest(m: SignedManifest): Promise<void>;
  loadManifest(): Promise<SignedManifest | null>;
  hasNonce(key: string): Promise<boolean>;
  addNonce(key: string, expiresAtMs: number): Promise<void>;
  getCounter(cardNumber: string): Promise<number>;
  setCounter(cardNumber: string, n: number): Promise<void>;
  enqueue(e: OfflineLogEntry): Promise<void>;
  queueSize(): Promise<number>;
  peekQueue(limit: number): Promise<OfflineLogEntry[]>;
  removeFromQueue(idempotencyKeys: string[]): Promise<void>;
}

export interface OfflineDecision {
  decision: 'GRANT' | 'DENY';
  reason: string;
  message: string;
  /** Display name for the operator (GRANT, or an authenticated-but-refused card). */
  name: string | null;
  entry: OfflineLogEntry | null;
}

export const MAX_QUEUE = 5000;

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);

/** Ed25519 via WebCrypto (Node ≥ 20, current Chrome/Edge/Firefox/Safari). */
export async function verifyEd25519(publicKeyHex: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex) || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}

export function randomKey(bytes = 18): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type ManifestVerdict =
  | { ok: true; manifest: OfflineManifest }
  | { ok: false; error: 'BAD_SIGNATURE' | 'SIGNER_MISMATCH' | 'WRONG_READER' | 'WRONG_SERVICE' | 'REGRESSED_VERSION' | 'EXPIRED' };

export class OfflineEngine {
  constructor(
    private readonly store: OfflineStore,
    private readonly identity: { readerCode: string; serviceCode: string },
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Validates and stores a freshly downloaded manifest. The signer key is pinned on first use (the download
   * itself arrives over the reader's HMAC-authenticated channel); any later change of signer is rejected.
   */
  async acceptManifest(res: SignedManifest): Promise<ManifestVerdict> {
    const m = res.manifest;
    const pinned = await this.store.getPinnedSigner();
    if (pinned && pinned.toLowerCase() !== res.signerPublicKeyHex.toLowerCase()) return { ok: false, error: 'SIGNER_MISMATCH' };
    const sigOk = await verifyEd25519(res.signerPublicKeyHex, new TextEncoder().encode(canonicalJson(m)), hexToBytes(res.signature));
    if (!sigOk) return { ok: false, error: 'BAD_SIGNATURE' };
    if (m.reader !== this.identity.readerCode) return { ok: false, error: 'WRONG_READER' };
    if (m.service !== this.identity.serviceCode) return { ok: false, error: 'WRONG_SERVICE' };
    if (Date.parse(m.validUntil) <= this.clock()) return { ok: false, error: 'EXPIRED' };
    const current = await this.store.loadManifest();
    if (current && m.version < current.manifest.version) return { ok: false, error: 'REGRESSED_VERSION' }; // rollback to an older (less revoked) list
    if (!pinned) await this.store.pinSigner(res.signerPublicKeyHex.toLowerCase());
    await this.store.saveManifest(res);
    return { ok: true, manifest: m };
  }

  /** Decide a QR scan without the server. Never throws for bad input: it always returns a (DENY) decision. */
  async decide(token: string, direction?: 'ENTRY' | 'EXIT'): Promise<OfflineDecision> {
    const now = this.clock();
    const deny = (reason: string, message: string, extra: { name?: string | null; card?: string; counter?: number; version?: number } = {}): Promise<OfflineDecision> =>
      this.finish('DENY', reason, message, extra.name ?? null, extra.card ?? null, extra.counter ?? 0, extra.version ?? 0, now, direction);

    const stored = await this.store.loadManifest();
    if (!stored) return deny(REASON_CODES.OFFLINE_NOT_SYNCED, 'Reader has no offline list yet. Connect to the network.');
    const m = stored.manifest;
    // Re-verify what is persisted: storage may have been tampered with between sync and use.
    const pinned = await this.store.getPinnedSigner();
    const sigOk = pinned && pinned.toLowerCase() === stored.signerPublicKeyHex.toLowerCase()
      && await verifyEd25519(stored.signerPublicKeyHex, new TextEncoder().encode(canonicalJson(m)), hexToBytes(stored.signature));
    if (!sigOk) return deny(REASON_CODES.OFFLINE_CACHE_STALE, 'Offline list failed its integrity check.', { version: m.version });

    if (m.policy === 'DENY_ALL') return deny(REASON_CODES.OFFLINE_NOT_PERMITTED, 'This service cannot be verified offline.', { version: m.version });
    if (Date.parse(m.validUntil) <= now) return deny(REASON_CODES.OFFLINE_CACHE_STALE, 'Offline list has expired. Connect to the network.', { version: m.version });

    const parsed = parseQr(token);
    if (!parsed.ok) return deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential not recognised.', { version: m.version });
    const { payload } = parsed;
    const card = m.cards.find((c) => c.cn === payload.cn);
    if (!card) {
      return m.revoked.includes(payload.cn)
        ? deny(REASON_CODES.CARD_REVOKED, 'This card is blocked or reported lost.', { card: payload.cn, version: m.version })
        : deny(REASON_CODES.CREDENTIAL_INVALID, 'Card is not in the offline list.', { card: payload.cn, version: m.version });
    }

    let sigGood = false;
    for (const pk of card.pk) {
      if (await verifyEd25519(pk, new TextEncoder().encode(parsed.payloadB64), parsed.signature)) { sigGood = true; break; }
    }
    if (!sigGood) return deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential could not be verified.', { card: payload.cn, version: m.version });

    const timeErr = checkQrTime(payload, Math.floor(now / 1000));
    if (timeErr === 'EXPIRED') return deny(REASON_CODES.CREDENTIAL_EXPIRED, 'QR code has expired. Ask the student to refresh it.', { card: payload.cn, name: card.name, counter: payload.ctr, version: m.version });
    if (timeErr) return deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential is not valid at this time.', { card: payload.cn, version: m.version });
    if (Date.parse(card.exp) <= now) return deny(REASON_CODES.CARD_EXPIRED, 'This card has expired.', { card: payload.cn, name: card.name, counter: payload.ctr, version: m.version });

    const nonceKey = `${payload.cn}:${payload.n}`;
    if (await this.store.hasNonce(nonceKey)) return deny(REASON_CODES.NONCE_REPLAY, 'This QR code was already used.', { card: payload.cn, name: card.name, counter: payload.ctr, version: m.version });
    await this.store.addNonce(nonceKey, (payload.exp + 120) * 1000);

    if (payload.ctr <= await this.store.getCounter(payload.cn)) {
      return deny(REASON_CODES.COUNTER_INVALID, 'Credential counter is invalid.', { card: payload.cn, name: card.name, counter: payload.ctr, version: m.version });
    }
    if ((await this.store.queueSize()) >= MAX_QUEUE) return deny(REASON_CODES.OFFLINE_QUEUE_FULL, 'Reader log is full. Connect to the network to sync.', { card: payload.cn, version: m.version });

    await this.store.setCounter(payload.cn, payload.ctr);
    return this.finish('GRANT', REASON_CODES.OK, 'Access granted (offline).', card.name, payload.cn, payload.ctr, m.version, now, direction);
  }

  private async finish(decision: 'GRANT' | 'DENY', reason: string, message: string, name: string | null, cardNumber: string | null, counter: number, version: number, now: number, direction?: 'ENTRY' | 'EXIT'): Promise<OfflineDecision> {
    // Decisions about unidentifiable credentials carry no card number and are not worth uploading.
    if (!cardNumber) return { decision, reason, message, name, entry: null };
    const entry: OfflineLogEntry = {
      idempotencyKey: randomKey(), cardNumber, decision, reasonCode: reason, occurredAt: new Date(now).toISOString(),
      ...(direction ? { direction } : {}), counter, manifestVersion: version,
    };
    if ((await this.store.queueSize()) < MAX_QUEUE) await this.store.enqueue(entry);
    return { decision, reason, message, name, entry };
  }

  /** Uploads queued decisions in batches; entries are removed only after the server acknowledges the batch. */
  async flush(upload: (batch: { batchKey: string; entries: OfflineLogEntry[] }) => Promise<{ ok: boolean }>, batchSize = 200): Promise<{ sent: number; failed: boolean }> {
    let sent = 0;
    for (;;) {
      const entries = await this.store.peekQueue(batchSize);
      if (entries.length === 0) return { sent, failed: false };
      // The batch key is derived from its content so a retry after a lost response is recognised as the same batch.
      const batchKey = `b-${entries[0]!.idempotencyKey}-${entries.length}`.slice(0, 64);
      const res = await upload({ batchKey, entries }).catch(() => ({ ok: false }));
      if (!res.ok) return { sent, failed: true };
      await this.store.removeFromQueue(entries.map((e) => e.idempotencyKey));
      sent += entries.length;
    }
  }
}

/** In-memory store (tests, and a fallback when IndexedDB is unavailable — not durable across reloads). */
export class MemoryStore implements OfflineStore {
  private signer: string | null = null;
  private manifest: SignedManifest | null = null;
  private nonces = new Map<string, number>();
  private counters = new Map<string, number>();
  private queue: OfflineLogEntry[] = [];
  async getPinnedSigner() { return this.signer; }
  async pinSigner(hex: string) { this.signer = hex; }
  async saveManifest(m: SignedManifest) { this.manifest = m; }
  async loadManifest() { return this.manifest; }
  async hasNonce(k: string) { return this.nonces.has(k); }
  async addNonce(k: string, exp: number) { this.nonces.set(k, exp); }
  async getCounter(c: string) { return this.counters.get(c) ?? 0; }
  async setCounter(c: string, n: number) { this.counters.set(c, n); }
  async enqueue(e: OfflineLogEntry) { this.queue.push(e); }
  async queueSize() { return this.queue.length; }
  async peekQueue(limit: number) { return this.queue.slice(0, limit); }
  async removeFromQueue(keys: string[]) { const s = new Set(keys); this.queue = this.queue.filter((e) => !s.has(e.idempotencyKey)); }
  /** test helper */
  tamperManifest(fn: (m: OfflineManifest) => void) { if (this.manifest) fn(this.manifest.manifest); }
}
