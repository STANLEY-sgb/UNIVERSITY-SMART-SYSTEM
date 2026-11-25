/**
 * Browser implementation of the reader request signature (must match @kiu/security signReaderRequest byte for byte;
 * an equivalence test in signing.spec.ts checks it against the Node implementation).
 *   X-Signature = hex(HMAC-SHA256(secret, METHOD "\n" URL "\n" ts "\n" nonce "\n" sha256hex(body)))
 */
const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

/** Imports the shared secret as a NON-extractable HMAC key so it can be stored in IndexedDB without ever being readable again. */
export function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function signRequest(key: CryptoKey, method: string, url: string, timestamp: string, nonce: string, body: string): Promise<string> {
  const message = [method.toUpperCase(), url, timestamp, nonce, await sha256Hex(body)].join('\n');
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function newNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
