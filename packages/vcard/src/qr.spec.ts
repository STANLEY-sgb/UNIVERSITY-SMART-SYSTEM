import {
  QR_TTL_SECONDS, checkQrTime, generateQrKeyPair, parseQr, signQr, verifyQrSignature,
} from './index';

const now = 1_800_000_000;
const keys = generateQrKeyPair();
const parsedOk = (t: string) => {
  const p = parseQr(t);
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  return p;
};

describe('Ed25519 rotating QR', () => {
  it('signs and verifies a token with the documented format and 30 s lifetime', () => {
    const token = signQr(keys.privateKeyHex, { cardNumber: 'KIU123', counter: 7, nowSeconds: now });
    expect(token.split('.')).toHaveLength(3);
    expect(token.startsWith('KIU1.')).toBe(true);
    const p = parsedOk(token);
    expect(p.payload).toMatchObject({ v: 1, cn: 'KIU123', ctr: 7, iat: now, exp: now + QR_TTL_SECONDS });
    expect(verifyQrSignature(p, keys.publicKeyHex)).toBe(true);
    expect(checkQrTime(p.payload, now + 10)).toBeNull();
  });

  it('uses a fresh nonce every time', () => {
    const a = parsedOk(signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now }));
    const b = parsedOk(signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now }));
    expect(a.payload.n).not.toBe(b.payload.n);
  });

  it('rejects a signature made by a different key', () => {
    const other = generateQrKeyPair();
    const p = parsedOk(signQr(other.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now }));
    expect(verifyQrSignature(p, keys.publicKeyHex)).toBe(false);
  });

  it('rejects any modification of the payload (card number, counter, expiry)', () => {
    const token = signQr(keys.privateKeyHex, { cardNumber: 'KIU123', counter: 7, nowSeconds: now });
    const [prefix, payload, sig] = token.split('.') as [string, string, string];
    const original = JSON.parse(Buffer.from(payload, 'base64url').toString());
    for (const change of [{ cn: 'KIU999' }, { ctr: 8 }, { exp: original.exp + 3600 }]) {
      const forged = Buffer.from(JSON.stringify({ ...original, ...change })).toString('base64url');
      expect(verifyQrSignature(parsedOk(`${prefix}.${forged}.${sig}`), keys.publicKeyHex)).toBe(false);
    }
  });

  it('rejects a truncated or corrupted signature without throwing', () => {
    const token = signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now });
    const [prefix, payload] = token.split('.') as [string, string];
    expect(verifyQrSignature(parsedOk(`${prefix}.${payload}.AAAA`), keys.publicKeyHex)).toBe(false);
  });

  it('enforces expiry with a small clock-skew allowance', () => {
    const p = parsedOk(signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now })).payload;
    expect(checkQrTime(p, now + 30)).toBeNull();
    expect(checkQrTime(p, now + 35)).toBeNull();      // within skew
    expect(checkQrTime(p, now + 36)).toBe('EXPIRED');
    expect(checkQrTime(p, now - 5)).toBeNull();
    expect(checkQrTime(p, now - 6)).toBe('NOT_YET_VALID');
  });

  it('rejects tokens with a lifetime other than 30 seconds (even if validly signed elsewhere)', () => {
    const p = parsedOk(signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now })).payload;
    expect(checkQrTime({ ...p, exp: p.iat + 3600 }, now)).toBe('BAD_LIFETIME');
  });

  it.each([
    ['not a string', 42], ['empty', ''], ['two parts', 'KIU1.abc'], ['four parts', 'KIU1.a.b.c'],
    ['wrong prefix', 'XYZ1.AAAA.AAAA'], ['bad chars', 'KIU1.@@@.###'], ['non-json payload', `KIU1.${Buffer.from('nope').toString('base64url')}.AAAA`],
    ['oversized', `KIU1.${'A'.repeat(2000)}.AAAA`],
  ])('treats %s as malformed', (_n, token) => {
    expect(parseQr(token).ok).toBe(false);
  });

  it('flags unsupported versions and rejects invalid field types', () => {
    const enc = (o: unknown) => `KIU1.${Buffer.from(JSON.stringify(o)).toString('base64url')}.AAAA`;
    expect(parseQr(enc({ v: 2, cn: 'K', ctr: 1, iat: 1, exp: 31, n: 'x'.repeat(16) }))).toMatchObject({ ok: false, error: 'VERSION' });
    expect(parseQr(enc({ v: 1, cn: 'K', ctr: -1, iat: 1, exp: 31, n: 'x'.repeat(16) })).ok).toBe(false);
    expect(parseQr(enc({ v: 1, cn: 'K', ctr: 1.5, iat: 1, exp: 31, n: 'x'.repeat(16) })).ok).toBe(false);
    expect(parseQr(enc({ v: 1, cn: 'K', ctr: 1, iat: 1, exp: 31, n: 'short' })).ok).toBe(false);
    expect(parseQr(enc(null)).ok).toBe(false);
  });

  it('rejects an invalid public key without throwing', () => {
    const p = parsedOk(signQr(keys.privateKeyHex, { cardNumber: 'K', counter: 1, nowSeconds: now }));
    expect(verifyQrSignature(p, 'abcd')).toBe(false);
  });
});

import { signMessage, verifyMessage } from './index';
describe('device proof-of-possession', () => {
  it('verifies only for the matching key and message', () => {
    const sig = signMessage(keys.privateKeyHex, 'KIU-ACTIVATE:KIU123');
    expect(verifyMessage(keys.publicKeyHex, 'KIU-ACTIVATE:KIU123', sig)).toBe(true);
    expect(verifyMessage(keys.publicKeyHex, 'KIU-ACTIVATE:KIU124', sig)).toBe(false);
    expect(verifyMessage(generateQrKeyPair().publicKeyHex, 'KIU-ACTIVATE:KIU123', sig)).toBe(false);
  });
  it('fails safely on malformed inputs', () => {
    expect(verifyMessage('abcd', 'm', 'zz')).toBe(false);
    expect(verifyMessage(keys.publicKeyHex, 'm', 'ab'.repeat(10))).toBe(false);
  });
});

import { publicKeyHexFromPrivate } from './index';
describe('key derivation', () => {
  it('derives the matching public key from a private seed', () => {
    expect(publicKeyHexFromPrivate(keys.privateKeyHex)).toBe(keys.publicKeyHex);
  });
});
