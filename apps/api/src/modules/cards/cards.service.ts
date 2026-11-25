import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { randomHex, sha256Hex } from '@kiu/security';
import { deriveCardKey, publicKeyFromHex, randomUidHex, verifyMessage } from '@kiu/vcard';
import { ENV, Env } from '../../config/env';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)

/** Never includes hashes, keys or the activation secret. */
const cardSelect = {
  id: true, cardNumber: true, status: true, issuedAt: true, expiresAt: true, activatedAt: true, activationExpiresAt: true,
  replacesCardId: true, createdAt: true,
  student: { select: { id: true, regNo: true, fullName: true } },
} satisfies Prisma.CardSelect;

export const activationMessage = (cardNumber: string) => `KIU-ACTIVATE:${cardNumber}`;

type Tx = Prisma.TransactionClient;

@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private newActivationCode(): string {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]!).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  }

  private hashCode(code: string): string {
    return sha256Hex(code.replace(/[\s-]/g, '').toUpperCase());
  }

  private async event(tx: Tx, cardId: string, eventType: string, actorId: string | null, reason?: string | null) {
    await tx.cardEvent.create({ data: { cardId, eventType, actorId, reason: reason ?? null } });
  }

  private async bumpRevocationVersion(tx: Tx, cardId: string, reason: string, actorId: string | null) {
    await tx.cardRevocation.create({ data: { cardId, reason, revokedBy: actorId } });
  }

  private async notify(tx: Tx, studentId: string, kind: string, title: string, body: string) {
    await tx.notification.create({ data: { studentId, kind, title, body } });
  }

  // ───────────────────────── queries ─────────────────────────

  async list(q: PageQuery & { regNo?: string; status?: string; q?: string }) {
    const where: Prisma.CardWhereInput = {
      ...(q.regNo ? { student: { regNo: q.regNo.toUpperCase() } } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.q ? { OR: [{ cardNumber: { contains: q.q, mode: 'insensitive' } }, { student: { fullName: { contains: q.q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({ where, select: cardSelect, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.card.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  async get(id: string) {
    const c = await this.prisma.card.findUnique({ where: { id }, select: cardSelect });
    if (!c) throw new NotFoundException({ code: 'CARD_NOT_FOUND', message: 'Card not found' });
    return c;
  }

  async history(id: string) {
    await this.get(id);
    return this.prisma.cardEvent.findMany({ where: { cardId: id }, orderBy: { at: 'asc' }, select: { eventType: true, reason: true, at: true, actorId: true } });
  }

  async mine(user: AuthUser) {
    if (!user.studentId) throw new NotFoundException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const cards = await this.prisma.card.findMany({
      where: { studentId: user.studentId }, orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, cardNumber: true, status: true, issuedAt: true, expiresAt: true, activatedAt: true, activationExpiresAt: true },
    });
    const current = cards.find((c) => c.status === 'ACTIVE') ?? cards.find((c) => c.status === 'PENDING') ?? cards[0] ?? null;
    return { current, history: cards };
  }

  // ───────────────────────── issuance ─────────────────────────

  /** Creates a card in PENDING and a one-time wallet activation code (returned once; only its hash is stored). */
  async issue(regNo: string, actor: AuthUser, meta: RequestMeta, opts: { replacesCardId?: string; reason?: string } = {}, tx?: Tx) {
    const run = async (t: Tx) => {
      const student = await t.student.findFirst({ where: { regNo: regNo.toUpperCase(), deletedAt: null } });
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
      if (student.accountStatus !== 'ACTIVE') throw new ConflictException({ code: 'STUDENT_NOT_ACTIVE', message: 'Cards can only be issued to active students' });
      if (!opts.replacesCardId && await t.card.findFirst({ where: { studentId: student.id, status: 'ACTIVE' } })) {
        throw new ConflictException({ code: 'ALREADY_HAS_ACTIVE_CARD', message: 'Student already has an active card. Use replace if it was lost.' });
      }
      // A new request supersedes any unactivated card.
      const stale = await t.card.findMany({ where: { studentId: student.id, status: 'PENDING' }, select: { id: true } });
      for (const s of stale) {
        await t.card.update({ where: { id: s.id }, data: { status: 'EXPIRED', activationHash: null } });
        await this.event(t, s.id, 'SUPERSEDED', actor.id, 'New card requested');
      }

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + this.env.CARD_VALIDITY_MONTHS);
      const code = this.newActivationCode();
      const card = await t.card.create({
        data: {
          cardNumber: `KIU${randomHex(5).toUpperCase()}`, uidHex: randomUidHex(), studentId: student.id, status: 'PENDING',
          regNoHash: sha256Hex(student.regNo), photoHash: student.photoSha256, expiresAt, issuedBy: actor.id,
          replacesCardId: opts.replacesCardId ?? null,
          activationHash: this.hashCode(code), activationExpiresAt: new Date(Date.now() + this.env.ACTIVATION_CODE_TTL_HOURS * 3_600_000),
          credentials: { create: [{ kind: 'AES_CARD_KEY', keyVersion: 1 }] }, // key is derived from the master key, never stored
        },
        select: cardSelect,
      });
      await this.event(t, card.id, 'ISSUED', actor.id, opts.reason ?? null);
      await this.notify(t, student.id, 'CARD_ISSUED', 'New card issued', 'Open your wallet and enter the activation code from the card office.');
      await this.audit.record({ actorId: actor.id, action: 'cards.issue', entityType: 'Card', entityId: card.id, after: card, reason: opts.reason ?? null, requestMeta: meta }, t);
      return { card, activationCode: code };
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Issue a fresh activation code (e.g. student got a new phone). Previous device keys are revoked on use. */
  async resetActivation(id: string, actor: AuthUser, meta: RequestMeta) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException({ code: 'CARD_NOT_FOUND', message: 'Card not found' });
    if (card.status !== 'ACTIVE' && card.status !== 'PENDING') throw new ConflictException({ code: 'CARD_NOT_ELIGIBLE', message: `A ${card.status} card cannot be re-enrolled` });
    const code = this.newActivationCode();
    await this.prisma.$transaction(async (tx) => {
      await tx.card.update({ where: { id }, data: { activationHash: this.hashCode(code), activationExpiresAt: new Date(Date.now() + this.env.ACTIVATION_CODE_TTL_HOURS * 3_600_000) } });
      await this.event(tx, id, 'ACTIVATION_RESET', actor.id);
      await this.audit.record({ actorId: actor.id, action: 'cards.activation_reset', entityType: 'Card', entityId: id, requestMeta: meta }, tx);
    });
    return { cardId: id, activationCode: code };
  }

  /**
   * Student wallet activation. The device generates its own Ed25519 key pair and sends only the public key plus
   * a signature proving possession; the private key never reaches the server. Returns the diversified AES card
   * key for the virtual card (software credential; see SECURITY_MODEL for the browser key-storage limitation).
   */
  async activate(user: AuthUser, input: { code: string; devicePublicKeyHex: string; proofHex: string; deviceLabel?: string }, meta: RequestMeta) {
    if (!user.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'Only student accounts can activate a card' });
    const bad = () => new BadRequestException({ code: 'ACTIVATION_INVALID', message: 'Activation code is invalid or expired' });
    const card = await this.prisma.card.findUnique({ where: { activationHash: this.hashCode(input.code) } });
    if (!card || card.studentId !== user.studentId || !card.activationExpiresAt || card.activationExpiresAt < new Date()
      || (card.status !== 'PENDING' && card.status !== 'ACTIVE')) throw bad();

    try { publicKeyFromHex(input.devicePublicKeyHex); } catch { throw new BadRequestException({ code: 'BAD_PUBLIC_KEY', message: 'Invalid device public key' }); }
    if (!verifyMessage(input.devicePublicKeyHex, activationMessage(card.cardNumber), input.proofHex)) {
      throw new BadRequestException({ code: 'PROOF_OF_POSSESSION_FAILED', message: 'Device could not prove possession of its key' });
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.card.updateMany({
          where: { id: card.id, activationHash: card.activationHash, status: { in: ['PENDING', 'ACTIVE'] } },
          data: { status: 'ACTIVE', activationHash: null, activationExpiresAt: null, activatedAt: new Date(), issuedAt: card.issuedAt ?? new Date() },
        });
        if (claimed.count !== 1) throw bad();
        // A new device replaces the old one.
        await tx.cardCredential.updateMany({ where: { cardId: card.id, kind: 'ED25519_QR', status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
        await tx.cardCredential.create({ data: { cardId: card.id, kind: 'ED25519_QR', publicKeyHex: input.devicePublicKeyHex.toLowerCase() } });
        await this.event(tx, card.id, 'ACTIVATED', null, input.deviceLabel?.slice(0, 80) ?? null);
        await this.audit.record({ actorId: user.id, action: 'cards.activated', entityType: 'Card', entityId: card.id, after: { deviceLabel: input.deviceLabel ?? null }, requestMeta: meta }, tx);
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException({ code: 'ALREADY_HAS_ACTIVE_CARD', message: 'You already have an active card. Report it lost first if you are replacing it.' });
      }
      throw e;
    }
    return {
      cardNumber: card.cardNumber, uidHex: card.uidHex, aidHex: card.aidHex, expiresAt: card.expiresAt,
      aesKeyHex: deriveCardKey(this.env.CARD_MASTER_KEY, card.uidHex, card.aidHex).toString('hex'),
    };
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async load(id: string) {
    const c = await this.prisma.card.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'CARD_NOT_FOUND', message: 'Card not found' });
    return c;
  }

  async block(id: string, reason: string, actor: AuthUser, meta: RequestMeta) {
    const c = await this.load(id);
    if (c.status !== 'ACTIVE') throw new ConflictException({ code: 'INVALID_TRANSITION', message: `Only an ACTIVE card can be blocked (is ${c.status})` });
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.card.update({ where: { id }, data: { status: 'BLOCKED' }, select: cardSelect });
      await this.bumpRevocationVersion(tx, id, `BLOCKED: ${reason}`, actor.id);
      await this.event(tx, id, 'BLOCKED', actor.id, reason);
      await this.notify(tx, c.studentId, 'CARD_BLOCKED', 'Your card was blocked', reason);
      await this.audit.record({ actorId: actor.id, action: 'cards.block', entityType: 'Card', entityId: id, before: { status: c.status }, after: { status: 'BLOCKED' }, reason, requestMeta: meta }, tx);
      return u;
    });
  }

  /** LOST is final: a lost credential is never reactivated (a replacement card gets fresh identifiers and keys). */
  async unblock(id: string, reason: string, actor: AuthUser, meta: RequestMeta) {
    const c = await this.load(id);
    if (c.status === 'LOST') throw new ConflictException({ code: 'LOST_CARD_FINAL', message: 'A card reported lost can never be reactivated. Issue a replacement.' });
    if (c.status !== 'BLOCKED') throw new ConflictException({ code: 'INVALID_TRANSITION', message: `Only a BLOCKED card can be unblocked (is ${c.status})` });
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: c.studentId } });
    if (student.accountStatus !== 'ACTIVE') throw new ConflictException({ code: 'STUDENT_NOT_ACTIVE', message: 'Student account is not active' });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const u = await tx.card.update({ where: { id }, data: { status: 'ACTIVE' }, select: cardSelect });
        await this.bumpRevocationVersion(tx, id, `UNBLOCKED: ${reason}`, actor.id);
        await this.event(tx, id, 'UNBLOCKED', actor.id, reason);
        await this.audit.record({ actorId: actor.id, action: 'cards.unblock', entityType: 'Card', entityId: id, before: { status: 'BLOCKED' }, after: { status: 'ACTIVE' }, reason, requestMeta: meta }, tx);
        return u;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'ALREADY_HAS_ACTIVE_CARD', message: 'Student already has another active card' });
      throw e;
    }
  }

  async reportLost(id: string, reason: string, actor: AuthUser, meta: RequestMeta, tx?: Tx) {
    const run = async (t: Tx) => {
      const c = await t.card.findUnique({ where: { id } });
      if (!c) throw new NotFoundException({ code: 'CARD_NOT_FOUND', message: 'Card not found' });
      if (c.status === 'LOST') return t.card.findUniqueOrThrow({ where: { id }, select: cardSelect }); // idempotent
      if (c.status === 'EXPIRED') throw new ConflictException({ code: 'INVALID_TRANSITION', message: 'An expired card cannot be reported lost' });
      const u = await t.card.update({ where: { id }, data: { status: 'LOST', activationHash: null, activationExpiresAt: null }, select: cardSelect });
      await t.cardCredential.updateMany({ where: { cardId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await this.bumpRevocationVersion(t, id, `LOST: ${reason}`, actor.id);
      await this.event(t, id, 'LOST', actor.id, reason);
      await this.notify(t, c.studentId, 'CARD_LOST', 'Card reported lost', 'Your card has been disabled. Request a replacement from the card office.');
      await this.audit.record({ actorId: actor.id, action: 'cards.report_lost', entityType: 'Card', entityId: id, before: { status: c.status }, after: { status: 'LOST' }, reason, requestMeta: meta }, t);
      return u;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Student self-service: report the caller's own current card lost. */
  async reportOwnLost(user: AuthUser, reason: string, meta: RequestMeta) {
    if (!user.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const card = await this.prisma.card.findFirst({ where: { studentId: user.studentId, status: { in: ['ACTIVE', 'BLOCKED', 'PENDING'] } }, orderBy: { createdAt: 'desc' } });
    if (!card) throw new NotFoundException({ code: 'CARD_NOT_FOUND', message: 'You have no card to report' });
    return this.reportLost(card.id, reason, user, meta);
  }

  /**
   * Replacement: old card is retired as LOST (if not already), a brand-new card is issued with fresh UID, number and
   * keys. Entitlements live on the student record, so nothing needs migrating. History of the old card is kept.
   */
  async replace(id: string, reason: string, feeStatus: string | undefined, actor: AuthUser, meta: RequestMeta) {
    const old = await this.load(id);
    if (await this.prisma.card.findFirst({ where: { replacesCardId: id } })) {
      throw new ConflictException({ code: 'ALREADY_REPLACED', message: 'This card has already been replaced' });
    }
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: old.studentId } });
    return this.prisma.$transaction(async (tx) => {
      if (old.status === 'ACTIVE' || old.status === 'BLOCKED' || old.status === 'PENDING') await this.reportLost(id, reason, actor, meta, tx);
      const fee = feeStatus ? ` [replacement fee: ${feeStatus}]` : '';
      const issued = await this.issue(student.regNo, actor, meta, { replacesCardId: id, reason: `Replacement: ${reason}${fee}` }, tx);
      await this.event(tx, id, 'REPLACED', actor.id, `${reason}${fee}`);
      return issued;
    });
  }
}
