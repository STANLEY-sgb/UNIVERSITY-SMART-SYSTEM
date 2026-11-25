import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { deriveCardKey, samProof, verifyCardProof } from '@kiu/vcard';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { ReaderContext } from '../readers/reader-auth.guard';

export const TAP_SESSION_TTL_MS = 30_000;

/**
 * Server-side (SAM) half of the virtual-card mutual authentication. Readers never hold the master key:
 * they relay challenge/response frames here over their HMAC-authenticated channel.
 */
@Injectable()
export class TapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Step 1 (after the reader's SELECT returned the card UID). Always answers with a challenge — even for an unknown
   * UID — so the endpoint cannot be used to enumerate which UIDs exist.
   */
  async begin(reader: ReaderContext, uidHex: string) {
    if (!/^[0-9A-Fa-f]{14}$/.test(uidHex)) throw new BadRequestException({ code: 'BAD_UID', message: 'UID must be 7 bytes of hex' });
    const uid = uidHex.toUpperCase();
    const card = await this.prisma.card.findUnique({ where: { uidHex: uid }, select: { id: true } });
    const rndR = randomBytes(16).toString('hex');
    const s = await this.prisma.tapSession.create({
      data: { readerId: reader.id, cardId: card?.id ?? null, uidHex: uid, rndR, expiresAt: new Date(Date.now() + TAP_SESSION_TTL_MS) },
    });
    if (Math.random() < 0.02) void this.prisma.tapSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3_600_000) } } }).catch(() => undefined);
    return { sessionId: s.id, rndR, expiresInMs: TAP_SESSION_TTL_MS };
  }

  /**
   * Step 2: verify the card's proof of key possession and return the SAM's proof so the card can authenticate the
   * reader side. Exactly ONE attempt per session (claimed atomically) — no oracle for guessing the proof.
   */
  async authenticate(reader: ReaderContext, input: { sessionId: string; rndCHex: string; proofHex: string }) {
    const fail = { ok: false as const, reason_code: 'CREDENTIAL_INVALID', message: 'Card could not be authenticated.' };
    if (!/^[0-9a-f-]{36}$/i.test(input.sessionId)) return fail;
    const claimed = await this.prisma.tapSession.updateMany({
      where: { id: input.sessionId, readerId: reader.id, state: 'BEGUN', expiresAt: { gt: new Date() } },
      data: { state: 'FAILED', rndC: input.rndCHex.toLowerCase().slice(0, 32) },
    });
    if (claimed.count !== 1) return fail;
    const session = await this.prisma.tapSession.findUniqueOrThrow({ where: { id: input.sessionId } });

    const card = session.cardId ? await this.prisma.card.findUnique({ where: { id: session.cardId } }) : null;
    const kc = card ? deriveCardKey(this.env.CARD_MASTER_KEY, card.uidHex, card.aidHex) : null;
    // Unknown UIDs are processed against a random key so timing does not reveal whether the UID exists.
    const ok = verifyCardProof(kc ?? randomBytes(16), session.rndR, input.rndCHex, input.proofHex);
    if (!ok || !card || !kc) {
      // Copied UID with wrong key (TC-10) and random probing both land here; both are recorded.
      if (card) await this.alerts.raise({ kind: 'COPIED_UID_WRONG_KEY', severity: 'HIGH', readerId: reader.id, cardId: card.id, studentId: card.studentId });
      await this.prisma.accessLog.create({
        data: {
          readerId: reader.id, serviceId: reader.serviceId, venueId: reader.venueId, cardId: card?.id ?? null, studentId: null,
          authMethod: 'VIRTUAL_TAP', decision: 'DENY', reasonCode: 'CREDENTIAL_INVALID', message: 'Card failed AES mutual authentication.',
          context: { stage: 'tap_auth', uidKnown: Boolean(card) },
        },
      });
      return fail;
    }
    await this.prisma.tapSession.update({ where: { id: session.id }, data: { state: 'AUTHENTICATED' } });
    return { ok: true as const, proofRHex: samProof(kc, Buffer.from(session.rndR, 'hex'), Buffer.from(input.rndCHex, 'hex')).toString('hex') };
  }
}
