import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { aesCmac } from './cmac';

/**
 * Virtual AES card protocol (simulation of the PDF's DESFire-style flow):
 *
 *   SELECT AID -> UID
 *   reader/SAM  --RndR-->  card
 *   card        --RndC, proofC = CMAC(Kc, 01 || RndR || RndC)-->  SAM          (card proves key knowledge)
 *   SAM         --proofR = CMAC(Kc, 02 || RndC || RndR)-->        card         (SAM proves key knowledge: mutual)
 *   both derive Kenc = CMAC(Kc, 04 || RndC || RndR), Kmac = CMAC(Kc, 05 || RndC || RndR)
 *   card        --iv, ct = AES-CBC(Kenc, cardNumber:counter), mac = CMAC(Kmac, iv || ct)-->  SAM
 *
 * Kc = CMAC(master, UID || AID) is diversified per card; the master key never leaves the server (the SAM role).
 * The UID is public and proves nothing. This is a SOFTWARE SIMULATION: a browser/phone holding Kc is not a
 * tamper-resistant secure element.
 */
export const KIU_AID_HEX = '4B4955';
const TAG = { PROOF_CARD: 0x01, PROOF_SAM: 0x02, ENC: 0x04, MAC: 0x05 } as const;

const hex = (b: Buffer) => b.toString('hex');
const fromHex = (h: string, bytes: number, what: string): Buffer => {
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(h)) throw new Error(`${what} must be ${bytes} bytes of hex`);
  return Buffer.from(h, 'hex');
};
const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function randomUidHex(): string {
  return randomBytes(7).toString('hex').toUpperCase();
}

/** Per-card key diversification: Kc = AES-CMAC(master, UID || AID). */
export function deriveCardKey(masterKeyHex: string, uidHex: string, aidHex = KIU_AID_HEX): Buffer {
  return aesCmac(fromHex(masterKeyHex, 16, 'master key'), Buffer.concat([fromHex(uidHex, 7, 'UID'), fromHex(aidHex, 3, 'AID')]));
}

export function cardProof(kc: Buffer, rndR: Buffer, rndC: Buffer): Buffer {
  return aesCmac(kc, Buffer.concat([Buffer.from([TAG.PROOF_CARD]), rndR, rndC]));
}
export function samProof(kc: Buffer, rndR: Buffer, rndC: Buffer): Buffer {
  return aesCmac(kc, Buffer.concat([Buffer.from([TAG.PROOF_SAM]), rndC, rndR]));
}
export function sessionKeys(kc: Buffer, rndR: Buffer, rndC: Buffer): { enc: Buffer; mac: Buffer } {
  const mk = (tag: number) => aesCmac(kc, Buffer.concat([Buffer.from([tag]), rndC, rndR]));
  return { enc: mk(TAG.ENC), mac: mk(TAG.MAC) };
}

export interface ProtectedRead { ivHex: string; ctHex: string; macHex: string }

export function encryptCardRead(kc: Buffer, rndR: Buffer, rndC: Buffer, cardNumber: string, counter: number): ProtectedRead {
  const { enc, mac } = sessionKeys(kc, rndR, rndC);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', enc, iv);
  const ct = Buffer.concat([cipher.update(`${cardNumber}:${counter}`, 'utf8'), cipher.final()]);
  return { ivHex: hex(iv), ctHex: hex(ct), macHex: hex(aesCmac(mac, Buffer.concat([iv, ct]))) };
}

export type ReadError = 'MALFORMED' | 'BAD_MAC' | 'BAD_PLAINTEXT';

/** Encrypt-then-MAC: the MAC is checked BEFORE any decryption, so tampered frames never reach the cipher. */
export function decryptCardRead(kc: Buffer, rndR: Buffer, rndC: Buffer, r: ProtectedRead):
  { ok: true; cardNumber: string; counter: number } | { ok: false; error: ReadError } {
  let iv: Buffer, ct: Buffer, tag: Buffer;
  try {
    iv = fromHex(r.ivHex, 16, 'iv');
    tag = fromHex(r.macHex, 16, 'mac');
    if (!/^[0-9a-fA-F]+$/.test(r.ctHex) || r.ctHex.length % 32 !== 0 || r.ctHex.length === 0 || r.ctHex.length > 512) throw new Error('ct');
    ct = Buffer.from(r.ctHex, 'hex');
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
  const { enc, mac } = sessionKeys(kc, rndR, rndC);
  if (!eq(aesCmac(mac, Buffer.concat([iv, ct])), tag)) return { ok: false, error: 'BAD_MAC' };
  try {
    const d = createDecipheriv('aes-128-cbc', enc, iv);
    const text = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    const m = /^([A-Za-z0-9-]{4,40}):(\d{1,15})$/.exec(text);
    if (!m) return { ok: false, error: 'BAD_PLAINTEXT' };
    return { ok: true, cardNumber: m[1]!, counter: Number(m[2]) };
  } catch {
    return { ok: false, error: 'BAD_PLAINTEXT' };
  }
}

/** Server-side (SAM) verification of the card's proof. */
export function verifyCardProof(kc: Buffer, rndRHex: string, rndCHex: string, proofHex: string): boolean {
  try {
    const rndR = fromHex(rndRHex, 16, 'RndR'), rndC = fromHex(rndCHex, 16, 'RndC'), proof = fromHex(proofHex, 16, 'proof');
    return eq(cardProof(kc, rndR, rndC), proof);
  } catch {
    return false;
  }
}

/**
 * A virtual card as held by a wallet/simulator. Holds Kc and a transaction counter; every successful
 * read increments the counter (so a recorded read cannot be replayed to the server).
 */
export class VirtualCard {
  private session: { rndR: Buffer; rndC: Buffer; authenticated: boolean } | null = null;

  constructor(
    readonly uidHex: string,
    private readonly kc: Buffer,
    readonly cardNumber: string,
    private counter = 0,
    private readonly rng: (n: number) => Buffer = randomBytes,
  ) {}

  get txCounter(): number { return this.counter; }

  /** The card's single monotonic transaction counter. QR tokens and AES reads must both draw from it. */
  nextCounter(): number { return ++this.counter; }

  /** SELECT AID: only the right application answers. */
  select(aidHex: string): { ok: true; uidHex: string } | { ok: false } {
    return aidHex.toUpperCase() === KIU_AID_HEX ? { ok: true, uidHex: this.uidHex } : { ok: false };
  }

  /** Step 2: given the SAM's challenge, return the card's challenge and key-possession proof. */
  authenticate(rndRHex: string): { rndCHex: string; proofHex: string } {
    const rndR = fromHex(rndRHex, 16, 'RndR');
    const rndC = this.rng(16);
    this.session = { rndR, rndC, authenticated: false };
    return { rndCHex: hex(rndC), proofHex: hex(cardProof(this.kc, rndR, rndC)) };
  }

  /** Step 3: card verifies the SAM's proof. A card never releases data to an unauthenticated peer. */
  verifyReader(proofRHex: string): boolean {
    if (!this.session) return false;
    let ok = false;
    try {
      ok = eq(samProof(this.kc, this.session.rndR, this.session.rndC), fromHex(proofRHex, 16, 'proofR'));
    } catch { /* malformed -> false */ }
    this.session.authenticated = ok;
    if (!ok) this.session = null;
    return ok;
  }

  /** Step 4: authenticated, encrypted card-number read (one per session). */
  readCardNumber(): ProtectedRead {
    if (!this.session?.authenticated) throw new Error('Card is not authenticated');
    const out = encryptCardRead(this.kc, this.session.rndR, this.session.rndC, this.cardNumber, this.nextCounter());
    this.session = null;
    return out;
  }
}
