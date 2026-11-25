import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canonicalJson } from '@kiu/shared';
import { publicKeyHexFromPrivate, signMessage } from '@kiu/vcard';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { ReaderContext } from '../readers/reader-auth.guard';

export interface OfflineManifest {
  v: 1;
  reader: string;
  service: string;
  /** DENY_ALL => the reader must refuse everything while offline. */
  policy: 'CACHED_ALLOW' | 'DENY_ALL';
  version: number;
  issuedAt: string;
  validUntil: string;
  revocationVersion: number;
  cards: { cn: string; pk: string[]; name: string; exp: string }[];
  revoked: string[];
}

export interface OfflineLogEntry {
  idempotencyKey: string;
  cardNumber: string;
  decision: 'GRANT' | 'DENY';
  reasonCode: string;
  occurredAt: string;
  direction?: 'ENTRY' | 'EXIT' | undefined;
  counter: number;
  manifestVersion: number;
}

const MAX_AGE_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 5 * 60_000;

@Injectable()
export class OfflineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get signerPublicKeyHex(): string {
    return publicKeyHexFromPrivate(this.env.CACHE_SIGNING_KEY);
  }

  /**
   * Signed, versioned, short-lived allow-list for ONE reader. Only services whose offline policy is CACHED_ALLOW
   * receive any cards; everything else gets an explicit DENY_ALL manifest. Only QR public keys are shipped:
   * AES card keys never leave the server, so the tap protocol is online-only. Only the minimum per card is included
   * (card number, public key(s), display name, expiry).
   */
  async manifest(reader: ReaderContext) {
    const service = await this.prisma.service.findUniqueOrThrow({ where: { id: reader.serviceId } });
    const now = new Date();
    const policy = service.offlinePolicy;

    let cards: OfflineManifest['cards'] = [];
    let revoked: string[] = [];
    if (policy === 'CACHED_ALLOW') {
      const rows = await this.prisma.card.findMany({
        where: { status: 'ACTIVE', expiresAt: { gt: now }, student: { accountStatus: 'ACTIVE' } },
        select: {
          cardNumber: true, expiresAt: true, student: { select: { fullName: true } },
          credentials: { where: { kind: 'ED25519_QR', status: 'ACTIVE' }, select: { publicKeyHex: true } },
        },
        orderBy: { cardNumber: 'asc' },
      });
      cards = rows
        .filter((r) => r.credentials.length > 0)
        .map((r) => ({ cn: r.cardNumber, pk: r.credentials.map((c) => c.publicKeyHex!).filter(Boolean), name: r.student.fullName, exp: r.expiresAt.toISOString() }));
      revoked = (await this.prisma.card.findMany({ where: { status: { in: ['LOST', 'BLOCKED'] } }, select: { cardNumber: true } })).map((c) => c.cardNumber).sort();
    }

    const revVersion = (await this.prisma.cardRevocation.aggregate({ _max: { version: true } }))._max.version ?? 0n;
    const last = await this.prisma.readerCacheVersion.findFirst({ where: { readerId: reader.id }, orderBy: { version: 'desc' } });
    const version = Number((last?.version ?? 0n) + 1n);
    const validUntil = new Date(now.getTime() + this.env.OFFLINE_CACHE_TTL_MINUTES * 60_000);

    const manifest: OfflineManifest = {
      v: 1, reader: reader.code, service: reader.serviceCode, policy, version,
      issuedAt: now.toISOString(), validUntil: validUntil.toISOString(), revocationVersion: Number(revVersion), cards, revoked,
    };
    const signature = signMessage(this.env.CACHE_SIGNING_KEY, canonicalJson(manifest));
    await this.prisma.readerCacheVersion.create({
      data: { readerId: reader.id, version: BigInt(version), manifestSig: signature, validUntil, revocationVersion: revVersion },
    });
    return { manifest, signature, signerPublicKeyHex: this.signerPublicKeyHex };
  }

  /**
   * Idempotent reconciliation of decisions a reader made while offline. Safe to retry: the batch key and every entry
   * key are unique. Grants made on a stale cache (card revoked before the entry's time) are flagged and alerted.
   */
  async uploadLogs(reader: ReaderContext, body: { batchKey: string; entries: OfflineLogEntry[] }) {
    if (body.entries.length === 0) throw new BadRequestException({ code: 'EMPTY_BATCH', message: 'Batch has no entries' });

    const existing = await this.prisma.offlineLogBatch.findUnique({ where: { idempotencyKey: body.batchKey } });
    if (existing && existing.readerId !== reader.id) throw new BadRequestException({ code: 'BATCH_KEY_IN_USE', message: 'Batch key already used' });
    if (existing?.reconciledAt) {
      return { duplicate: true, accepted: 0, duplicates: existing.entryCount, rejected: 0, conflicts: existing.conflicts };
    }
    const batch = existing ?? await this.prisma.offlineLogBatch.create({
      data: { readerId: reader.id, idempotencyKey: body.batchKey, entryCount: body.entries.length },
    });

    const now = Date.now();
    const cards = await this.prisma.card.findMany({ where: { cardNumber: { in: [...new Set(body.entries.map((e) => e.cardNumber))] } } });
    const byNumber = new Map(cards.map((c) => [c.cardNumber, c]));
    let accepted = 0, duplicates = 0, rejected = 0, conflicts = 0;

    for (const e of body.entries) {
      const at = new Date(e.occurredAt);
      if (Number.isNaN(at.getTime()) || at.getTime() > now + MAX_FUTURE_MS || at.getTime() < now - MAX_AGE_MS) { rejected++; continue; }
      const card = byNumber.get(e.cardNumber);

      let conflict = false;
      if (e.decision === 'GRANT') {
        if (!card) conflict = true;
        else if (card.status !== 'ACTIVE') {
          const rev = await this.prisma.cardRevocation.findFirst({ where: { cardId: card.id, revokedAt: { lte: at }, OR: [{ reason: { startsWith: 'LOST' } }, { reason: { startsWith: 'BLOCKED' } }] } });
          conflict = rev !== null;
        }
      }
      try {
        await this.prisma.accessLog.create({
          data: {
            occurredAt: at, readerId: reader.id, serviceId: reader.serviceId, venueId: reader.venueId,
            studentId: card?.studentId ?? null, cardId: card?.id ?? null, authMethod: 'QR',
            direction: e.direction ?? 'NONE', decision: e.decision, reasonCode: e.reasonCode,
            message: conflict ? 'Offline grant on a stale cache (card was revoked)' : 'Decided offline by the reader from its signed cache',
            offline: true, idempotencyKey: `${reader.id}:${e.idempotencyKey}`,
            context: { manifestVersion: e.manifestVersion, offlineBatch: batch.id, conflict } as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') { duplicates++; continue; }
        throw err;
      }
      accepted++;
      if (conflict) conflicts++;
      // Keep the server counter ahead of anything accepted offline so the same QR cannot be replayed online later.
      if (card && e.decision === 'GRANT') await this.prisma.card.updateMany({ where: { id: card.id, txCounter: { lt: BigInt(e.counter) } }, data: { txCounter: BigInt(e.counter) } });
    }

    await this.prisma.offlineLogBatch.update({ where: { id: batch.id }, data: { reconciledAt: new Date(), conflicts, entryCount: body.entries.length } });
    if (conflicts > 0) {
      await this.alerts.raise({ kind: 'OFFLINE_STALE_GRANT', severity: 'HIGH', readerId: reader.id, detail: { conflicts, batch: batch.id } });
    }
    return { duplicate: false, accepted, duplicates, rejected, conflicts };
  }
}
