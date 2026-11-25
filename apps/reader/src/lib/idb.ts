import type { OfflineLogEntry, OfflineStore, SignedManifest } from '@kiu/offline-core';

/** Tiny promise wrapper over IndexedDB (no dependency). Durable across reloads — required for queued offline logs. */
const DB_NAME = 'kiu-reader';
const DB_VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('nonces');
      db.createObjectStore('counters');
      db.createObjectStore('queue', { keyPath: 'idempotencyKey' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(req ? (req as IDBRequest<T>).result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

export interface ReaderSettings {
  baseUrl: string;
  readerId: string;
  readerCode: string;
  serviceCode: string;
  keyId: string;
  /** Non-extractable HMAC key: the secret itself is never persisted. */
  hmacKey: CryptoKey;
}

export const settings = {
  get: () => run<ReaderSettings>('kv', 'readonly', (s) => s.get('settings')),
  set: (v: ReaderSettings) => run('kv', 'readwrite', (s) => s.put(v, 'settings')),
  clear: async () => {
    for (const st of ['kv', 'nonces', 'counters', 'queue']) await run(st, 'readwrite', (s) => s.clear());
  },
};

/** OfflineStore backed by IndexedDB. */
export class IdbStore implements OfflineStore {
  async getPinnedSigner() { return (await run<string>('kv', 'readonly', (s) => s.get('signer'))) ?? null; }
  async pinSigner(hex: string) { await run('kv', 'readwrite', (s) => s.put(hex, 'signer')); }
  async saveManifest(m: SignedManifest) { await run('kv', 'readwrite', (s) => s.put(m, 'manifest')); }
  async loadManifest() { return (await run<SignedManifest>('kv', 'readonly', (s) => s.get('manifest'))) ?? null; }
  async hasNonce(key: string) {
    const exp = await run<number>('nonces', 'readonly', (s) => s.get(key));
    return exp !== undefined;
  }
  async addNonce(key: string, expiresAtMs: number) {
    await run('nonces', 'readwrite', (s) => s.put(expiresAtMs, key));
    // opportunistic purge of expired nonces
    const all = await run<IDBValidKey[]>('nonces', 'readonly', (s) => s.getAllKeys());
    if ((all?.length ?? 0) > 2000) {
      const now = Date.now();
      for (const k of all!) {
        const exp = await run<number>('nonces', 'readonly', (s) => s.get(k));
        if (exp !== undefined && exp < now) await run('nonces', 'readwrite', (s) => s.delete(k));
      }
    }
  }
  async getCounter(cardNumber: string) { return (await run<number>('counters', 'readonly', (s) => s.get(cardNumber))) ?? 0; }
  async setCounter(cardNumber: string, n: number) { await run('counters', 'readwrite', (s) => s.put(n, cardNumber)); }
  async enqueue(e: OfflineLogEntry) { await run('queue', 'readwrite', (s) => s.put(e)); }
  async queueSize() { return (await run<number>('queue', 'readonly', (s) => s.count())) ?? 0; }
  async peekQueue(limit: number) {
    const all = (await run<OfflineLogEntry[]>('queue', 'readonly', (s) => s.getAll())) ?? [];
    return all.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(0, limit);
  }
  async removeFromQueue(keys: string[]) {
    for (const k of keys) await run('queue', 'readwrite', (s) => s.delete(k));
  }
}
