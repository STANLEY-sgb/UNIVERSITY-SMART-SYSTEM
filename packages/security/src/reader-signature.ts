import { hmacSha256Hex, sha256Hex } from './crypto';

/**
 * Canonical string signed by readers: method, path+query, unix-seconds timestamp, nonce, body hash.
 * Binding the method/path stops a captured signature being replayed against another endpoint.
 */
export function readerSigningString(method: string, url: string, timestamp: string, nonce: string, body: string | Buffer): string {
  return [method.toUpperCase(), url, timestamp, nonce, sha256Hex(body)].join('\n');
}

export function signReaderRequest(secret: string, method: string, url: string, timestamp: string, nonce: string, body: string | Buffer = ''): string {
  return hmacSha256Hex(secret, readerSigningString(method, url, timestamp, nonce, body));
}
