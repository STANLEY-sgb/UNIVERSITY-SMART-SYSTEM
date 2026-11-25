import { type ReaderSettings } from './idb';
import { newNonce, signRequest } from './signing';

/** Thrown when the server could not be reached in time: the caller may fall back to the offline policy. */
export class NetworkError extends Error {}

export interface ApiResult<T = any> { status: number; body: T; ms: number }

/** Online-first window before the offline policy applies (PDF: about 800 ms). */
export const ONLINE_TIMEOUT_MS = 800;

export class ReaderApi {
  constructor(private readonly s: Pick<ReaderSettings, 'baseUrl' | 'keyId' | 'hmacKey' | 'readerId'>) {}

  private async call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<ApiResult> {
    const url = `/api/v1${path}`;
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = newNonce();
    const signature = await signRequest(this.s.hmacKey, method, url, ts, nonce, bodyText);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.s.baseUrl}${url}`, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: { ...(bodyText ? { 'Content-Type': 'application/json' } : {}), 'X-Reader-Key-Id': this.s.keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': signature },
        ...(bodyText ? { body: bodyText } : {}),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      return { status: res.status, body: json, ms: Math.round(performance.now() - t0) };
    } catch {
      throw new NetworkError('network');
    } finally {
      clearTimeout(timer);
    }
  }

  verifyQr(token: string, direction?: 'ENTRY' | 'EXIT') {
    return this.call('POST', '/access/verify', { credential: { type: 'QR', token }, ...(direction ? { direction } : {}) }, ONLINE_TIMEOUT_MS);
  }
  /** Face is online-only: a generous timeout, and the caller must never fall back to an offline decision. */
  verifyFace(regNo: string, frames: number[][], direction?: 'ENTRY' | 'EXIT') {
    return this.call('POST', '/access/verify', { credential: { type: 'FACE', regNo, frames }, ...(direction ? { direction } : {}) }, 4000);
  }
  allowlist() { return this.call('GET', `/readers/${this.s.readerId}/allowlist`, undefined, 10_000); }
  uploadLogs(batch: { batchKey: string; entries: unknown[] }) { return this.call('POST', `/readers/${this.s.readerId}/logs`, batch, 15_000); }
}
