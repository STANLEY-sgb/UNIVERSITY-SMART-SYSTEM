/**
 * Pure (no Node built-ins) parts of the rotating-QR format, shared by the server, the simulator and
 * browser/offline readers. Signature verification lives in qr.ts (Node) or in the caller's Ed25519 library.
 */
export const QR_PREFIX = 'KIU1';
export const QR_TTL_SECONDS = 30;
export const QR_CLOCK_SKEW_SECONDS = 5;
const MAX_TOKEN_LENGTH = 1024;

export interface QrPayload {
  v: 1;
  /** Card number */
  cn: string;
  /** Monotonic counter */
  ctr: number;
  iat: number;
  exp: number;
  /** Random nonce, base64url */
  n: string;
}

export type QrError = 'MALFORMED' | 'VERSION' | 'SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'BAD_LIFETIME';

export type ParsedQr =
  | { ok: true; payload: QrPayload; payloadB64: string; signature: Uint8Array }
  | { ok: false; error: 'MALFORMED' | 'VERSION' };

const B64U = /^[A-Za-z0-9_-]+$/;

export function base64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '==='.slice((b.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Structural parse only; does NOT authenticate. Never trust `payload` until the signature has been verified. */
export function parseQr(token: unknown): ParsedQr {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, error: 'MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'MALFORMED' };
  const [prefix, payloadB64, sigB64] = parts as [string, string, string];
  if (prefix !== QR_PREFIX) return { ok: false, error: prefix.startsWith('KIU') ? 'VERSION' : 'MALFORMED' };
  if (!B64U.test(payloadB64) || !B64U.test(sigB64)) return { ok: false, error: 'MALFORMED' };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
  const p = payload as Partial<QrPayload> | null;
  if (!p || typeof p !== 'object' || p.v !== 1) return { ok: false, error: p && typeof p === 'object' && 'v' in p ? 'VERSION' : 'MALFORMED' };
  if (typeof p.cn !== 'string' || p.cn.length === 0 || p.cn.length > 64 || !Number.isSafeInteger(p.ctr) || (p.ctr as number) < 0
    || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || typeof p.n !== 'string' || p.n.length < 16 || p.n.length > 64) {
    return { ok: false, error: 'MALFORMED' };
  }
  return { ok: true, payload: p as QrPayload, payloadB64, signature: base64urlToBytes(sigB64) };
}

/** Time checks, to be applied only AFTER the signature verifies. */
export function checkQrTime(payload: QrPayload, nowSeconds = Math.floor(Date.now() / 1000), skew = QR_CLOCK_SKEW_SECONDS): QrError | null {
  if (payload.exp - payload.iat !== QR_TTL_SECONDS) return 'BAD_LIFETIME';
  if (nowSeconds < payload.iat - skew) return 'NOT_YET_VALID';
  if (nowSeconds > payload.exp + skew) return 'EXPIRED';
  return null;
}
