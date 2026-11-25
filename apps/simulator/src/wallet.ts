import { VirtualCard, generateQrKeyPair, signMessage, signQr } from '@kiu/vcard';
import { ApiClient, ReaderClient } from './api';

export interface ProtocolEvent { step: string; command?: string; response?: string; ok?: boolean; ms?: number }

/**
 * A student's virtual wallet: the Ed25519 device key (never sent anywhere) plus the AES virtual card.
 * Created only through the real activation API, exactly as the future mobile wallet will.
 */
export class SimWallet {
  constructor(
    readonly cardNumber: string,
    readonly cardId: string | undefined,
    private readonly devicePrivateKeyHex: string,
    readonly devicePublicKeyHex: string,
    readonly card: VirtualCard,
    readonly aesKeyHex: string,
  ) {}

  /** Activates a PENDING card for the logged-in student and returns the resulting wallet. */
  static async activate(api: ApiClient, studentToken: string, activationCode: string, cardNumber: string, cardId?: string): Promise<SimWallet> {
    const keys = generateQrKeyPair();
    const res = await api.call('POST', '/me/card/activate', {
      code: activationCode, devicePublicKeyHex: keys.publicKeyHex,
      proofHex: signMessage(keys.privateKeyHex, `KIU-ACTIVATE:${cardNumber}`), deviceLabel: 'KIU simulator',
    }, studentToken);
    if (res.status !== 200) throw new Error(`activation failed: ${res.status} ${res.body?.code}`);
    const b = res.body;
    return new SimWallet(
      b.cardNumber, cardId, keys.privateKeyHex, keys.publicKeyHex,
      new VirtualCard(b.uidHex, Buffer.from(b.aesKeyHex, 'hex'), b.cardNumber),
      b.aesKeyHex,
    );
  }

  /** Fresh QR; draws from the card's single monotonic counter (shared with AES reads). */
  qr(o: { counter?: number; nowSeconds?: number; keyHex?: string } = {}): string {
    return signQr(o.keyHex ?? this.devicePrivateKeyHex, {
      cardNumber: this.cardNumber, counter: o.counter ?? this.card.nextCounter(), ...(o.nowSeconds !== undefined ? { nowSeconds: o.nowSeconds } : {}),
    });
  }

  /**
   * Full mutual-authentication tap through a reader. Returns the credential to submit to /access/verify (or the
   * failure that stopped the protocol) plus a sanitised protocol log (no keys, no challenges' secrets).
   */
  async tap(reader: ReaderClient, card: VirtualCard = this.card): Promise<
    { ok: true; credential: Record<string, unknown>; events: ProtocolEvent[] } | { ok: false; stage: string; response: any; events: ProtocolEvent[] }
  > {
    const events: ProtocolEvent[] = [];
    const timed = async <T>(step: string, command: string, fn: () => Promise<T>, show: (r: T) => string): Promise<T> => {
      const t = performance.now();
      const r = await fn();
      events.push({ step, command, response: show(r), ms: Math.round(performance.now() - t) });
      return r;
    };

    const sel = await timed('SELECT AID', '00A4 4B4955', async () => card.select('4B4955'), (r) => (r.ok ? `OK uid=${r.uidHex}` : 'NOT FOUND'));
    if (!sel.ok) return { ok: false, stage: 'select', response: sel, events };

    const begin = await timed('REQUEST CHALLENGE', 'POST /access/tap/begin', () => reader.post('/access/tap/begin', { uidHex: sel.uidHex }), (r) => `HTTP ${r.status} RndR=${String(r.body.rndR ?? '').slice(0, 8)}…`);
    if (begin.status !== 200) return { ok: false, stage: 'begin', response: begin.body, events };

    const resp = card.authenticate(begin.body.rndR);
    const auth = await timed('MUTUAL AUTH (card proof)', 'POST /access/tap/auth', () => reader.post('/access/tap/auth', { sessionId: begin.body.sessionId, rndCHex: resp.rndCHex, proofHex: resp.proofHex }), (r) => (r.body.ok ? 'card authenticated' : `REJECTED ${r.body.reason_code ?? r.status}`));
    if (auth.status !== 200 || !auth.body.ok) return { ok: false, stage: 'auth', response: auth.body, events };

    const readerOk = card.verifyReader(auth.body.proofRHex);
    events.push({ step: 'MUTUAL AUTH (reader proof)', command: 'card verifies SAM proof', response: readerOk ? 'reader authenticated' : 'REJECTED', ok: readerOk });
    if (!readerOk) return { ok: false, stage: 'reader-proof', response: null, events };

    const read = card.readCardNumber();
    events.push({ step: 'READ CARD NUMBER', command: 'AES-CBC + CMAC (session keys)', response: `ct=${read.ctHex.slice(0, 8)}… (card number never in the clear)` });
    return { ok: true, credential: { type: 'TAP', sessionId: begin.body.sessionId, ivHex: read.ivHex, ctHex: read.ctHex, macHex: read.macHex }, events };
  }
}
