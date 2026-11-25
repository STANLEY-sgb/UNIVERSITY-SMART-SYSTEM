import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, KeyObject } from 'node:crypto';

/**
 * Rotating QR credential: `KIU1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>`.
 * The signature covers the exact base64url payload string, so no JSON canonicalisation is needed.
 * A QR is a short-lived signed assertion, not a secret: a screenshot can be replayed inside its
 * 30-second window except that nonce + counter checks on the server reject a second use.
 */
export * from './qr-format';
import { ParsedQr, QR_PREFIX, QR_TTL_SECONDS, QrPayload } from './qr-format';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function generateQrKeyPair(): { publicKeyHex: string; privateKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);
  return { publicKeyHex: pub.toString('hex'), privateKeyHex: seed.toString('hex') };
}

export function publicKeyFromHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function privateKeyFromHex(hex: string): KeyObject {
  const seed = Buffer.from(hex, 'hex');
  if (seed.length !== 32) throw new Error('Ed25519 private seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function signQr(privateKeyHex: string, input: { cardNumber: string; counter: number; nowSeconds?: number; nonce?: string }): string {
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: QrPayload = { v: 1, cn: input.cardNumber, ctr: input.counter, iat, exp: iat + QR_TTL_SECONDS, n: input.nonce ?? newNonce() };
  const payloadB64 = b64u(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(payloadB64), privateKeyFromHex(privateKeyHex));
  return `${QR_PREFIX}.${payloadB64}.${b64u(sig)}`;
}

export function verifyQrSignature(parsed: Extract<ParsedQr, { ok: true }>, publicKeyHex: string): boolean {
  try {
    return verify(null, Buffer.from(parsed.payloadB64), publicKeyFromHex(publicKeyHex), parsed.signature);
  } catch {
    return false;
  }
}

/** Generic Ed25519 message signature (used for device proof-of-possession at wallet activation). */
export function signMessage(privateKeyHex: string, message: string): string {
  return sign(null, Buffer.from(message), privateKeyFromHex(privateKeyHex)).toString('hex');
}

export function verifyMessage(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
    return verify(null, Buffer.from(message), publicKeyFromHex(publicKeyHex), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Derives the Ed25519 public key (32-byte hex) from a 32-byte private seed (hex). */
export function publicKeyHexFromPrivate(privateKeyHex: string): string {
  return createPublicKey(privateKeyFromHex(privateKeyHex)).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('hex');
}
