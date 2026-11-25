import { createCipheriv } from 'node:crypto';

/**
 * AES-128-CMAC (RFC 4493 / NIST SP 800-38B), built on the platform's AES block primitive.
 * Verified against the RFC 4493 test vectors in cmac.spec.ts. Used for card-key diversification
 * (CMAC(master, UID || AID)), mutual authentication proofs, session-key derivation and message MACs.
 */
const BLOCK = 16;
const RB = 0x87;

function aesBlock(key: Buffer, block: Buffer): Buffer {
  const c = createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(b: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK);
  let carry = 0;
  for (let i = BLOCK - 1; i >= 0; i--) {
    const v = b[i]!;
    out[i] = ((v << 1) & 0xff) | carry;
    carry = (v & 0x80) !== 0 ? 1 : 0;
  }
  return out;
}

function subkeys(key: Buffer): { k1: Buffer; k2: Buffer } {
  const l = aesBlock(key, Buffer.alloc(BLOCK));
  const k1 = shiftLeft(l);
  if ((l[0]! & 0x80) !== 0) k1[BLOCK - 1] = k1[BLOCK - 1]! ^ RB;
  const k2 = shiftLeft(k1);
  if ((k1[0]! & 0x80) !== 0) k2[BLOCK - 1] = k2[BLOCK - 1]! ^ RB;
  return { k1, k2 };
}

export function aesCmac(key: Buffer, message: Buffer): Buffer {
  if (key.length !== 16) throw new Error('AES-CMAC key must be 16 bytes');
  const { k1, k2 } = subkeys(key);
  const n = Math.max(1, Math.ceil(message.length / BLOCK));
  const complete = message.length > 0 && message.length % BLOCK === 0;

  const last = Buffer.alloc(BLOCK);
  const lastStart = (n - 1) * BLOCK;
  if (complete) {
    const blk = message.subarray(lastStart, lastStart + BLOCK);
    for (let i = 0; i < BLOCK; i++) last[i] = blk[i]! ^ k1[i]!;
  } else {
    const rest = message.subarray(lastStart);
    const padded = Buffer.alloc(BLOCK);
    rest.copy(padded);
    padded[rest.length] = 0x80;
    for (let i = 0; i < BLOCK; i++) last[i] = padded[i]! ^ k2[i]!;
  }

  let x: Buffer = Buffer.alloc(BLOCK);
  for (let i = 0; i < n - 1; i++) {
    const blk = message.subarray(i * BLOCK, (i + 1) * BLOCK);
    const y = Buffer.alloc(BLOCK);
    for (let j = 0; j < BLOCK; j++) y[j] = x[j]! ^ blk[j]!;
    x = aesBlock(key, y);
  }
  const y = Buffer.alloc(BLOCK);
  for (let j = 0; j < BLOCK; j++) y[j] = x[j]! ^ last[j]!;
  return aesBlock(key, y);
}
