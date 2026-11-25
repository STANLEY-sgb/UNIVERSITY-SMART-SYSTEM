/**
 * On-device wallet. The Ed25519 private key is generated here with WebCrypto as NON-EXTRACTABLE and stored as a
 * CryptoKey object in IndexedDB: page scripts can ask it to sign but can never read the key bytes, and the server
 * only ever receives the public half. This is software-backed (not a secure element): see docs/SECURITY_MODEL.md.
 *
 * QR format (identical to @kiu/vcard): KIU1.<b64url(payload)>.<b64url(Ed25519 signature over the b64url payload)>
 */
const enc = new TextEncoder();

export const QR_TTL_SECONDS = 30;

export const b64u = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export interface DeviceKey { cardNumber: string; privateKey: CryptoKey; publicKeyHex: string; counter: number; enrolledAt: string }

export interface KeyStorage {
  load(): Promise<DeviceKey | null>;
  save(k: DeviceKey): Promise<void>;
  clear(): Promise<void>;
}

/** Generates a fresh non-extractable Ed25519 key pair and returns the public key as hex. */
export async function generateDeviceKey(cardNumber: string): Promise<DeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { cardNumber, privateKey: pair.privateKey, publicKeyHex: toHex(raw), counter: 0, enrolledAt: new Date().toISOString() };
}

/** Proof of possession for activation: signature over "KIU-ACTIVATE:<cardNumber>", hex-encoded (matches the API). */
export async function activationProof(key: DeviceKey): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, enc.encode(`KIU-ACTIVATE:${key.cardNumber}`))));
}

export interface QrToken { token: string; iat: number; exp: number; counter: number }

/**
 * Mints the next QR token. The counter only ever goes up and is persisted BEFORE the token is returned, so a crash or
 * reload can never re-issue a counter the server has already accepted. It is time-seeded so it also stays ahead of
 * the server after a storage reset.
 */
export async function nextQr(storage: KeyStorage, nowMs = Date.now()): Promise<QrToken | null> {
  const key = await storage.load();
  if (!key) return null;
  const iat = Math.floor(nowMs / 1000);
  const counter = Math.max(key.counter + 1, iat);
  await storage.save({ ...key, counter });
  const payload = { v: 1, cn: key.cardNumber, ctr: counter, iat, exp: iat + QR_TTL_SECONDS, n: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const payloadB64 = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, enc.encode(payloadB64)));
  return { token: `KIU1.${payloadB64}.${b64u(sig)}`, iat, exp: payload.exp, counter };
}

/** In-memory storage (tests). */
export class MemoryKeyStorage implements KeyStorage {
  private k: DeviceKey | null = null;
  async load() { return this.k; }
  async save(k: DeviceKey) { this.k = k; }
  async clear() { this.k = null; }
}

/** IndexedDB storage (CryptoKey objects survive structured cloning, key bytes stay unreadable). */
export class IdbKeyStorage implements KeyStorage {
  private db() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('kiu-wallet', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => { db.close(); resolve(req.result); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  }
  load() { return this.tx<DeviceKey | undefined>('readonly', (s) => s.get('device')).then((v) => v ?? null); }
  async save(k: DeviceKey) { await this.tx('readwrite', (s) => s.put(k, 'device')); }
  async clear() { await this.tx('readwrite', (s) => s.clear()); }
}
