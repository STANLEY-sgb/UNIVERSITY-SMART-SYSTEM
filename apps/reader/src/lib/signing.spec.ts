import { signReaderRequest } from '@kiu/security';
import { describe, expect, it } from 'vitest';
import { importHmacKey, newNonce, sha256Hex, signRequest } from './signing';

describe('browser request signing', () => {
  it('produces exactly the signature the Node/server implementation expects', async () => {
    const secret = 'a'.repeat(64);
    const key = await importHmacKey(secret);
    const cases: [string, string, string][] = [
      ['POST', '/api/v1/access/verify', '{"credential":{"type":"QR","token":"KIU1.x.y"},"direction":"ENTRY"}'],
      ['GET', '/api/v1/readers/0b0c0d0e-0000-4000-8000-000000000000/allowlist', ''],
      ['POST', '/api/v1/readers/x/logs', '{"entries":[{"a":"é☃"}]}'], // non-ASCII bodies must hash identically
    ];
    for (const [method, url, body] of cases) {
      const ts = '1800000000';
      const nonce = 'n'.repeat(32);
      expect(await signRequest(key, method, url, ts, nonce, body)).toBe(signReaderRequest(secret, method, url, ts, nonce, body));
    }
  });

  it('hashes like Node (known SHA-256 vector) and generates unpredictable nonces', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(newNonce());
  });

  it('keeps the secret non-extractable', async () => {
    const key = await importHmacKey('secret-secret-secret-secret');
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
  });
});
