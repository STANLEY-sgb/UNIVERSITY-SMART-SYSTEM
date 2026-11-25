import { CanActivate, ConflictException, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { decryptSecret, safeEqual, signReaderRequest } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';

export const READER_MAX_SKEW_SECONDS = 60;
export const READER_NONCE_TTL_MS = 5 * 60_000;

export interface ReaderContext {
  id: string;
  code: string;
  serviceId: string;
  serviceCode: string;
  venueId: string;
  venueCode: string;
  keyId: string;
}

type ReaderRequest = Request & { reader?: ReaderContext; rawBody?: Buffer };

/**
 * Authenticates a registered reader device (not a person). Every request carries
 * X-Reader-Key-Id, X-Timestamp (unix seconds), X-Nonce and X-Signature = HMAC-SHA256 over
 * method, URL, timestamp, nonce and body hash. Order of checks matters: the signature is verified
 * before the nonce is recorded, so unauthenticated callers cannot fill the nonce table.
 */
@Injectable()
export class ReaderAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ReaderRequest>();
    const h = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n] as string) : undefined);
    const keyId = h('x-reader-key-id'), ts = h('x-timestamp'), nonce = h('x-nonce'), signature = h('x-signature');
    if (!keyId || !ts || !nonce || !signature) {
      throw new UnauthorizedException({ code: 'READER_AUTH_REQUIRED', message: 'Reader authentication headers missing' });
    }

    const cred = await this.prisma.readerCredential.findUnique({
      where: { keyId },
      include: { reader: { include: { service: true, venue: true } } },
    });
    if (!cred) throw new UnauthorizedException({ code: 'READER_UNKNOWN', message: 'Unknown reader credential' });
    const reader = cred.reader;

    if (cred.revokedAt || reader.status !== 'ACTIVE') {
      await this.alerts.raise({ kind: 'REVOKED_READER_USED', severity: 'HIGH', readerId: reader.id, detail: { keyId, status: reader.status } });
      throw new ForbiddenException({ code: 'READER_REVOKED', message: 'Reader is not authorised' });
    }

    const tsNum = Number(ts);
    if (!/^\d{9,12}$/.test(ts) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > READER_MAX_SKEW_SECONDS) {
      throw new UnauthorizedException({ code: 'STALE_TIMESTAMP', message: 'Request timestamp outside the allowed window' });
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
      throw new UnauthorizedException({ code: 'BAD_NONCE', message: 'Malformed nonce' });
    }

    const secret = decryptSecret(cred.secretEnc, this.env.DATA_ENCRYPTION_KEY, `reader:${reader.id}`);
    const expected = signReaderRequest(secret, req.method, req.originalUrl, ts, nonce, req.rawBody ?? '');
    if (!safeEqual(expected, signature.toLowerCase())) {
      await this.alerts.raise({ kind: 'READER_BAD_SIGNATURE', severity: 'MEDIUM', readerId: reader.id, detail: { keyId } });
      throw new UnauthorizedException({ code: 'BAD_HMAC', message: 'Invalid request signature' });
    }

    try {
      await this.prisma.credentialNonce.create({
        data: { nonce: `${keyId}:${nonce}`, scope: 'READER_REQUEST', expiresAt: new Date(Date.now() + READER_NONCE_TTL_MS) },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        await this.alerts.raise({ kind: 'REQUEST_REPLAY', severity: 'HIGH', readerId: reader.id, detail: { keyId } });
        throw new ConflictException({ code: 'NONCE_REPLAY', message: 'Request nonce already used' });
      }
      throw e;
    }
    if (Math.random() < 0.01) void this.purgeExpired();

    req.reader = {
      id: reader.id, code: reader.code, serviceId: reader.serviceId, serviceCode: reader.service.code,
      venueId: reader.venueId, venueCode: reader.venue.code, keyId,
    };
    return true;
  }

  private async purgeExpired(): Promise<void> {
    await this.prisma.credentialNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  }
}
