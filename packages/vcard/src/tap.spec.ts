import { randomBytes } from 'node:crypto';
import {
  KIU_AID_HEX, VirtualCard, decryptCardRead, deriveCardKey, encryptCardRead, randomUidHex, samProof, verifyCardProof,
} from './index';

const MASTER = randomBytes(16).toString('hex');
const setup = () => {
  const uid = randomUidHex();
  const kc = deriveCardKey(MASTER, uid);
  const card = new VirtualCard(uid, kc, 'KIU0001TEST');
  return { uid, kc, card };
};
/** Plays the SAM (server) side of one authentication. */
const sam = (kc: Buffer, card: VirtualCard) => {
  const rndR = randomBytes(16);
  const { rndCHex, proofHex } = card.authenticate(rndR.toString('hex'));
  return { rndR, rndCHex, proofHex, ok: verifyCardProof(kc, rndR.toString('hex'), rndCHex, proofHex) };
};

describe('key diversification', () => {
  it('is deterministic per UID and differs between cards and masters', () => {
    expect(deriveCardKey(MASTER, 'AABBCCDDEEFF00').equals(deriveCardKey(MASTER, 'AABBCCDDEEFF00'))).toBe(true);
    expect(deriveCardKey(MASTER, 'AABBCCDDEEFF00').equals(deriveCardKey(MASTER, 'AABBCCDDEEFF01'))).toBe(false);
    expect(deriveCardKey(MASTER, 'AABBCCDDEEFF00').equals(deriveCardKey(randomBytes(16).toString('hex'), 'AABBCCDDEEFF00'))).toBe(false);
  });
  it('binds the application id', () => {
    expect(deriveCardKey(MASTER, 'AABBCCDDEEFF00', '4B4955').equals(deriveCardKey(MASTER, 'AABBCCDDEEFF00', '4B4956'))).toBe(false);
  });
  it('validates input formats', () => {
    expect(() => deriveCardKey('abcd', 'AABBCCDDEEFF00')).toThrow();
    expect(() => deriveCardKey(MASTER, 'XYZ')).toThrow();
  });
  it('generates distinct 7-byte UIDs', () => {
    const a = randomUidHex();
    expect(a).toMatch(/^[0-9A-F]{14}$/);
    expect(a).not.toBe(randomUidHex());
  });
});

describe('mutual authentication', () => {
  it('SELECT only answers for the KIU application id', () => {
    const { card, uid } = setup();
    expect(card.select(KIU_AID_HEX)).toEqual({ ok: true, uidHex: uid });
    expect(card.select('4B4956')).toEqual({ ok: false });
  });

  it('succeeds in both directions with the right key', () => {
    const { kc, card } = setup();
    const r = sam(kc, card);
    expect(r.ok).toBe(true);
    expect(card.verifyReader(samProof(kc, r.rndR, Buffer.from(r.rndCHex, 'hex')).toString('hex'))).toBe(true);
  });

  it('SAM rejects a card holding the wrong key (copied UID, wrong secret)', () => {
    const { uid, kc } = setup();
    const clone = new VirtualCard(uid, randomBytes(16), 'KIU0001TEST');
    expect(sam(kc, clone).ok).toBe(false);
  });

  it('card rejects an impostor reader and then refuses to release data', () => {
    const { card } = setup();
    card.authenticate(randomBytes(16).toString('hex'));
    expect(card.verifyReader(randomBytes(16).toString('hex'))).toBe(false);
    expect(() => card.readCardNumber()).toThrow(/not authenticated/);
  });

  it('refuses to read before authenticating, and malformed challenges fail safely', () => {
    const { card } = setup();
    expect(() => card.readCardNumber()).toThrow();
    expect(() => card.authenticate('not-hex')).toThrow();
    expect(card.verifyReader('00')).toBe(false);
  });

  it('uses fresh challenges every time, so a recorded proof is worthless later', () => {
    const { kc, card } = setup();
    const rndR = randomBytes(16).toString('hex');
    const a = card.authenticate(rndR);
    const b = card.authenticate(rndR);
    expect(a.rndCHex).not.toBe(b.rndCHex);
    expect(a.proofHex).not.toBe(b.proofHex);
    expect(verifyCardProof(kc, rndR, b.rndCHex, a.proofHex)).toBe(false);
  });

  it('verifyCardProof fails safely on malformed input', () => {
    const { kc } = setup();
    expect(verifyCardProof(kc, 'zz', 'zz', 'zz')).toBe(false);
    expect(verifyCardProof(kc, '', '', '')).toBe(false);
  });
});

describe('protected card-number read', () => {
  const fullRead = () => {
    const { kc, card } = setup();
    const r = sam(kc, card);
    card.verifyReader(samProof(kc, r.rndR, Buffer.from(r.rndCHex, 'hex')).toString('hex'));
    return { kc, r, read: card.readCardNumber(), card };
  };

  it('round-trips the card number and counter, and increments the counter', () => {
    const { kc, r, read, card } = fullRead();
    expect(decryptCardRead(kc, r.rndR, Buffer.from(r.rndCHex, 'hex'), read)).toEqual({ ok: true, cardNumber: 'KIU0001TEST', counter: 1 });
    expect(card.txCounter).toBe(1);
  });

  it('does not expose the card number in the clear', () => {
    const { read } = fullRead();
    expect(Buffer.from(read.ctHex, 'hex').toString('latin1')).not.toContain('KIU0001TEST');
  });

  it('rejects tampering with iv, ciphertext or mac (MAC is checked before decrypting)', () => {
    const { kc, r, read } = fullRead();
    const flip = (h: string) => (parseInt(h.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + h.slice(2);
    const rndC = Buffer.from(r.rndCHex, 'hex');
    for (const bad of [{ ...read, ivHex: flip(read.ivHex) }, { ...read, ctHex: flip(read.ctHex) }, { ...read, macHex: flip(read.macHex) }]) {
      expect(decryptCardRead(kc, r.rndR, rndC, bad)).toEqual({ ok: false, error: 'BAD_MAC' });
    }
  });

  it('rejects a read replayed into a different session', () => {
    const { kc, r, read } = fullRead();
    expect(decryptCardRead(kc, randomBytes(16), Buffer.from(r.rndCHex, 'hex'), read)).toEqual({ ok: false, error: 'BAD_MAC' });
  });

  it('rejects a read protected by a different card key', () => {
    const { r, read } = fullRead();
    expect(decryptCardRead(randomBytes(16), r.rndR, Buffer.from(r.rndCHex, 'hex'), read).ok).toBe(false);
  });

  it.each([
    ['short iv', { ivHex: 'aa', ctHex: '00'.repeat(16), macHex: '00'.repeat(16) }],
    ['empty ciphertext', { ivHex: '00'.repeat(16), ctHex: '', macHex: '00'.repeat(16) }],
    ['unaligned ciphertext', { ivHex: '00'.repeat(16), ctHex: '00'.repeat(17), macHex: '00'.repeat(16) }],
    ['non-hex mac', { ivHex: '00'.repeat(16), ctHex: '00'.repeat(16), macHex: 'zz'.repeat(16) }],
    ['oversized ciphertext', { ivHex: '00'.repeat(16), ctHex: '00'.repeat(1000), macHex: '00'.repeat(16) }],
  ])('treats %s as malformed without throwing', (_n, frame) => {
    const { kc } = setup();
    expect(decryptCardRead(kc, randomBytes(16), randomBytes(16), frame)).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('rejects a validly authenticated frame whose plaintext is not "number:counter"', () => {
    const { kc } = setup();
    const rndR = randomBytes(16);
    const rndC = randomBytes(16);
    const frame = encryptCardRead(kc, rndR, rndC, 'bad number with spaces', 1);
    expect(decryptCardRead(kc, rndR, rndC, frame)).toEqual({ ok: false, error: 'BAD_PLAINTEXT' });
  });
});

describe('shared transaction counter', () => {
  it('draws QR and AES reads from one strictly increasing sequence', () => {
    const { kc, card } = setup();
    expect(card.nextCounter()).toBe(1); // e.g. a QR token
    const r = sam(kc, card);
    card.verifyReader(samProof(kc, r.rndR, Buffer.from(r.rndCHex, 'hex')).toString('hex'));
    const read = card.readCardNumber();
    expect(decryptCardRead(kc, r.rndR, Buffer.from(r.rndCHex, 'hex'), read)).toMatchObject({ ok: true, counter: 2 });
    expect(card.nextCounter()).toBe(3);
  });
});
