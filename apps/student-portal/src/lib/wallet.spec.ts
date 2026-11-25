import { checkQrTime, parseQr, publicKeyFromHex, verifyMessage, verifyQrSignature } from '@kiu/vcard';
import { describe, expect, it } from 'vitest';
import { MemoryKeyStorage, activationProof, generateDeviceKey, nextQr } from './wallet';

async function enrolled(cardNumber = 'KIU1234567890') {
  const storage = new MemoryKeyStorage();
  const key = await generateDeviceKey(cardNumber);
  await storage.save(key);
  return { storage, key };
}

describe('browser wallet tokens are accepted by the server-side verifier', () => {
  it('mints a KIU1 token whose Ed25519 signature verifies with the public key the server stores', async () => {
    const { storage, key } = await enrolled();
    const now = 1_800_000_000_000;
    const q = (await nextQr(storage, now))!;
    const parsed = parseQr(q.token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload).toMatchObject({ v: 1, cn: 'KIU1234567890', iat: 1_800_000_000, exp: 1_800_000_030 });
    expect(verifyQrSignature(parsed, key.publicKeyHex)).toBe(true);
    expect(checkQrTime(parsed.payload, 1_800_000_010)).toBeNull();
    expect(checkQrTime(parsed.payload, 1_800_000_100)).toBe('EXPIRED');
  });

  it('does not verify under another device key or after tampering', async () => {
    const a = await enrolled();
    const b = await enrolled();
    const q = (await nextQr(a.storage))!;
    const parsed = parseQr(q.token);
    if (!parsed.ok) throw new Error('parse');
    expect(verifyQrSignature(parsed, b.key.publicKeyHex)).toBe(false);
    const [p, pl, s] = q.token.split('.') as [string, string, string];
    const body = JSON.parse(atob(pl.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = `${p}.${btoa(JSON.stringify({ ...body, cn: 'KIU-OTHER' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${s}`;
    const fp = parseQr(forged);
    expect(fp.ok && verifyQrSignature(fp, a.key.publicKeyHex)).toBe(false);
  });

  it('uses a strictly increasing counter and a fresh nonce for every token, persisted before use', async () => {
    const { storage } = await enrolled();
    const now = 1_800_000_000_000;
    const seen: number[] = [];
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const q = (await nextQr(storage, now))!; // same wall-clock second on purpose
      seen.push(q.counter);
      const p = parseQr(q.token);
      if (p.ok) nonces.add(p.payload.n);
      expect((await storage.load())!.counter).toBe(q.counter);
    }
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(5);
    expect(nonces.size).toBe(5);
  });

  it('stays ahead of the server counter after a storage reset (time-seeded)', async () => {
    const fresh = new MemoryKeyStorage();
    await fresh.save(await generateDeviceKey('KIU1234567890'));
    const q = (await nextQr(fresh, 1_800_000_000_000))!;
    expect(q.counter).toBeGreaterThanOrEqual(1_800_000_000);
  });

  it('returns null when this device is not enrolled', async () => {
    expect(await nextQr(new MemoryKeyStorage())).toBeNull();
  });
});

describe('device key and activation proof', () => {
  it('has a 32-byte public key, a non-extractable private key, and a proof the API will accept', async () => {
    const { key } = await enrolled('KIU9876543210');
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(() => publicKeyFromHex(key.publicKeyHex)).not.toThrow();
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toBeTruthy();

    const proof = await activationProof(key);
    expect(proof).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyMessage(key.publicKeyHex, 'KIU-ACTIVATE:KIU9876543210', proof)).toBe(true);
    expect(verifyMessage(key.publicKeyHex, 'KIU-ACTIVATE:KIU0000000000', proof)).toBe(false);
  });
});
