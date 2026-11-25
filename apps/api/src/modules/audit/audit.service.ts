import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { GENESIS_HASH, chainHash } from '@kiu/security';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditInput {
  actorId?: string | null;
  actorType?: 'USER' | 'READER' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestMeta?: { ip?: string; userAgent?: string; requestId?: string } | null;
}

/** Advisory-lock key serialising audit appends so the hash chain cannot fork. */
const AUDIT_LOCK_KEY = 7_001_001;
const SENSITIVE_KEY = /pass(word)?|secret|token|mfa|private|recovery|authorization|cookie/i;

/** Strips credentials from values before they are persisted in the audit trail. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

/** JSON round-trip so hashed content equals what Postgres JSONB returns later. */
function normalise<T>(value: T): T | null {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function auditPayload(e: {
  id: string; at: string; actorId: string | null; actorType: string; action: string;
  entityType: string; entityId: string | null; before: unknown; after: unknown;
  reason: string | null; requestMeta: unknown;
}) {
  return {
    id: e.id, at: e.at, actorId: e.actorId, actorType: e.actorType, action: e.action,
    entityType: e.entityType, entityId: e.entityId, before: e.before ?? null, after: e.after ?? null,
    reason: e.reason, requestMeta: e.requestMeta ?? null,
  };
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends an audit entry. Pass `tx` to make the entry atomic with the business change it
   * describes; without it the entry is written in its own transaction.
   */
  async record(input: AuditInput, tx?: Prisma.TransactionClient): Promise<{ id: string; seq: bigint }> {
    if (tx) return this.append(tx, input);
    return this.prisma.$transaction((t) => this.append(t, input));
  }

  private async append(tx: Prisma.TransactionClient, input: AuditInput) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
    const last = await tx.auditTrail.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;

    const id = randomUUID();
    const at = new Date();
    const entry = {
      id,
      at: at.toISOString(),
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? 'USER',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: normalise(redact(input.before)),
      after: normalise(redact(input.after)),
      reason: input.reason ?? null,
      requestMeta: normalise(input.requestMeta ?? null),
    };
    const hash = chainHash(prevHash, auditPayload(entry));

    const row = await tx.auditTrail.create({
      data: {
        id, at, actorId: entry.actorId, actorType: entry.actorType, action: entry.action,
        entityType: entry.entityType, entityId: entry.entityId,
        before: (entry.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        after: (entry.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        reason: entry.reason,
        requestMeta: (entry.requestMeta ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        prevHash, hash,
      },
      select: { id: true, seq: true },
    });
    return row;
  }

  /** Re-computes the whole chain. Returns the seq of the first broken entry, if any. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtSeq: string | null }> {
    let prev = GENESIS_HASH;
    let checked = 0;
    let cursor: bigint | undefined;
    for (;;) {
      const rows = await this.prisma.auditTrail.findMany({
        orderBy: { seq: 'asc' }, take: 500,
        ...(cursor !== undefined ? { where: { seq: { gt: cursor } } } : {}),
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const expected = chainHash(prev, auditPayload({
          id: r.id, at: r.at.toISOString(), actorId: r.actorId, actorType: r.actorType, action: r.action,
          entityType: r.entityType, entityId: r.entityId, before: r.before, after: r.after,
          reason: r.reason, requestMeta: r.requestMeta,
        }));
        if (r.prevHash !== prev || r.hash !== expected) {
          return { ok: false, checked, brokenAtSeq: r.seq.toString() };
        }
        prev = r.hash;
        checked++;
        cursor = r.seq;
      }
    }
    return { ok: true, checked, brokenAtSeq: null };
  }
}
