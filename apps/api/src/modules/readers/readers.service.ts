import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { encryptSecret, randomHex } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReaderContext } from './reader-auth.guard';

const readerSelect = {
  id: true, code: true, name: true, status: true, supportsFace: true, configVersion: true, lastHeartbeatAt: true, createdAt: true,
  service: { select: { code: true, name: true } }, venue: { select: { code: true, name: true } },
} satisfies Prisma.ReaderSelect;

@Injectable()
export class ReadersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private newCredential(readerId: string) {
    const keyId = `rk_${randomHex(8)}`;
    const secret = randomHex(32);
    return { keyId, secret, secretEnc: encryptSecret(secret, this.env.DATA_ENCRYPTION_KEY, `reader:${readerId}`) };
  }

  async list(q: PageQuery) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reader.findMany({ select: readerSelect, orderBy: { code: 'asc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.reader.count(),
    ]);
    return paged(rows, total, q);
  }

  async get(id: string) {
    const r = await this.prisma.reader.findUnique({ where: { id }, select: readerSelect });
    if (!r) throw new NotFoundException({ code: 'READER_NOT_FOUND', message: 'Reader not found' });
    return r;
  }

  /** The signing secret is returned exactly once, here. Only the encrypted form is stored. */
  async create(dto: { code: string; name: string; serviceCode: string; venueCode: string; supportsFace?: boolean }, actor: AuthUser, meta: RequestMeta) {
    const [service, venue] = await Promise.all([
      this.prisma.service.findUnique({ where: { code: dto.serviceCode.toUpperCase() } }),
      this.prisma.venue.findUnique({ where: { code: dto.venueCode } }),
    ]);
    if (!service) throw new NotFoundException({ code: 'SERVICE_NOT_FOUND', message: 'Service not found' });
    if (!venue) throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found' });
    if (await this.prisma.reader.findUnique({ where: { code: dto.code } })) {
      throw new ConflictException({ code: 'READER_CODE_IN_USE', message: 'Reader code already exists' });
    }
    return this.prisma.$transaction(async (tx) => {
      const reader = await tx.reader.create({
        data: { code: dto.code, name: dto.name, serviceId: service.id, venueId: venue.id, status: 'ACTIVE', supportsFace: dto.supportsFace ?? false },
        select: readerSelect,
      });
      const cred = this.newCredential(reader.id);
      await tx.readerCredential.create({ data: { readerId: reader.id, keyId: cred.keyId, secretEnc: cred.secretEnc } });
      await this.audit.record({ actorId: actor.id, action: 'readers.create', entityType: 'Reader', entityId: reader.id, after: { ...reader, keyId: cred.keyId }, requestMeta: meta }, tx);
      return { reader, credentials: { keyId: cred.keyId, secret: cred.secret } };
    });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED' | 'REVOKED', reason: string, actor: AuthUser, meta: RequestMeta) {
    const before = await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.reader.update({ where: { id }, data: { status, configVersion: { increment: 1 } }, select: readerSelect });
      if (status === 'REVOKED') await tx.readerCredential.updateMany({ where: { readerId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: actor.id, action: 'readers.status_change', entityType: 'Reader', entityId: id, before: { status: before.status }, after: { status: r.status }, reason, requestMeta: meta }, tx);
      return r;
    });
  }

  async rotateCredential(id: string, actor: AuthUser, meta: RequestMeta) {
    await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.readerCredential.updateMany({ where: { readerId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      const cred = this.newCredential(id);
      await tx.readerCredential.create({ data: { readerId: id, keyId: cred.keyId, secretEnc: cred.secretEnc } });
      await this.audit.record({ actorId: actor.id, action: 'readers.credential_rotated', entityType: 'Reader', entityId: id, after: { keyId: cred.keyId }, requestMeta: meta }, tx);
      return { credentials: { keyId: cred.keyId, secret: cred.secret } };
    });
  }

  async heartbeat(reader: ReaderContext, body: { queuedLogs?: number; cacheVersion?: number }) {
    await this.prisma.$transaction([
      this.prisma.reader.update({ where: { id: reader.id }, data: { lastHeartbeatAt: new Date() } }),
      this.prisma.readerHeartbeat.create({ data: { readerId: reader.id, queuedLogs: body.queuedLogs ?? 0, cacheVersion: body.cacheVersion ?? null } }),
    ]);
    return { ok: true, serverTime: new Date().toISOString() };
  }
}
