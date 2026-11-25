import { randomBytes } from 'node:crypto';
import {
  GENESIS_HASH, canonicalJson, chainHash, decryptSecret, encryptSecret,
  hmacSha256Hex, randomToken, safeEqual, sha256Hex, verifyChain,
} from './index';

const KEY = randomBytes(32).toString('base64');

describe('secret envelope (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const env = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(env.startsWith('v1.')).toBe(true);
    expect(decryptSecret(env, KEY)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptSecret('secret', KEY).split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64url')].join('.'), KEY)).toThrow();
  });

  it('rejects the wrong key and mismatched AAD', () => {
    const env = encryptSecret('secret', KEY, 'reader:1');
    expect(() => decryptSecret(env, randomBytes(32).toString('base64'), 'reader:1')).toThrow();
    expect(() => decryptSecret(env, KEY, 'reader:2')).toThrow();
    expect(decryptSecret(env, KEY, 'reader:1')).toBe('secret');
  });

  it('rejects keys that are not 32 bytes and malformed envelopes', () => {
    expect(() => encryptSecret('x', Buffer.from('short').toString('base64'))).toThrow();
    expect(() => decryptSecret('garbage', KEY)).toThrow();
  });
});

describe('primitives', () => {
  it('matches the RFC 4231 HMAC-SHA256 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('matches a known SHA-256 vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates distinct url-safe tokens', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(randomToken());
  });

  it('compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('audit hash chain', () => {
  const build = (payloads: unknown[]) => {
    let prev = GENESIS_HASH;
    return payloads.map((payload) => {
      const hash = chainHash(prev, payload);
      const entry = { payload, prevHash: prev, hash };
      prev = hash;
      return entry;
    });
  };

  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it('verifies an intact chain', () => {
    expect(verifyChain(build([{ a: 1 }, { a: 2 }, { a: 3 }]))).toBe(-1);
  });

  it('detects a modified payload at the right index', () => {
    const chain = build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    chain[1]!.payload = { a: 999 };
    expect(verifyChain(chain)).toBe(1);
  });

  it('detects a deleted entry', () => {
    const chain = build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    chain.splice(1, 1);
    expect(verifyChain(chain)).toBe(1);
  });
});

import { signReaderRequest } from './index';
describe('reader request signature', () => {
  const base = ['k', 'POST', '/api/v1/access/verify', '1800000000', 'n'.repeat(16), '{"a":1}'] as const;
  const sign = (over: Partial<Record<number, string>> = {}) => {
    const a = [...base] as string[];
    Object.entries(over).forEach(([i, v]) => { a[Number(i)] = v!; });
    return signReaderRequest(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!);
  };
  it('is deterministic and binds secret, method, path, timestamp, nonce and body', () => {
    expect(sign()).toBe(sign());
    for (const i of [0, 1, 2, 3, 4, 5]) expect(sign({ [i]: base[i] + 'x' })).not.toBe(sign());
  });
  it('is case-insensitive on method only', () => {
    expect(sign({ 1: 'post' })).toBe(sign());
  });
});
