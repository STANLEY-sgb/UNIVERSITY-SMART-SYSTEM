import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ENV, Env, loadEnv } from './config/env';
import { EnvModule } from './config/env.module';
import { PrismaModule } from './prisma/prisma.service';
import { EventsModule } from './modules/events/events.module';
import { AccessModule } from './modules/access/access.module';
import { BiometricsModule } from './modules/biometrics/biometrics.module';
import { AdminModule } from './modules/admin/admin.module';
import { AlertsModule } from './modules/alerts/alerts.service';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard, PermissionsGuard } from './modules/auth/auth.guards';
import { CardsModule } from './modules/cards/cards.module';
import { HealthController } from './modules/health/health.controller';
import { MailModule } from './modules/mail/mail.service';
import { ReadersModule } from './modules/readers/readers.module';
import { RulesModule } from './modules/rules/rules.module';
import { StudentsModule } from './modules/students/students.module';
import { UniversityModule } from './modules/university/university.module';
import { UsersModule } from './modules/users/users.module';

const isReaderRequest = (req: Request): boolean => typeof req.headers['x-reader-key-id'] === 'string';
const AUTH_ABUSE_PATH = /\/auth\/(login|forgot-password|reset-password|refresh|register)$/;

export function buildAppModule(env: Env = loadEnv()) {
  @Module({
    imports: [
      EnvModule.forRoot(env),
      ThrottlerModule.forRootAsync({
        inject: [ENV],
        useFactory: (e: Env) => ({
          throttlers: [
            // People / browsers: per IP. Skipped for device traffic, which has its own budget below.
            { name: 'default', ttl: 60_000, limit: e.THROTTLE_DEFAULT_LIMIT, skipIf: (ctx) => isReaderRequest(ctx.switchToHttp().getRequest<Request>()) },
            {
              name: 'auth', ttl: 60_000, limit: e.THROTTLE_LOGIN_LIMIT,
              skipIf: (ctx) => !AUTH_ABUSE_PATH.test(ctx.switchToHttp().getRequest<Request>().path),
            },
            // Readers: budgeted per reader key (many gates may share one campus NAT address)...
            {
              name: 'reader', ttl: 60_000, limit: e.THROTTLE_READER_LIMIT,
              getTracker: (req) => `reader:${String((req as unknown as Request).headers['x-reader-key-id'])}`,
              skipIf: (ctx) => !isReaderRequest(ctx.switchToHttp().getRequest<Request>()),
            },
            // ...plus a generous per-IP ceiling so rotating fake key ids cannot bypass limiting altogether.
            { name: 'readerIp', ttl: 60_000, limit: e.THROTTLE_READER_IP_LIMIT, skipIf: (ctx) => !isReaderRequest(ctx.switchToHttp().getRequest<Request>()) },
          ],
        }),
      }),
      PrismaModule,
      MailModule,
      AuditModule,
      AlertsModule,
      AuthModule,
      UsersModule,
      StudentsModule,
      ReadersModule,
      RulesModule,
      CardsModule,
      AdminModule,
      UniversityModule,
      EventsModule,
      AccessModule,
      BiometricsModule,
    ],
    controllers: [HealthController],
    // Order matters: rate limit -> authenticate -> authorise (deny by default).
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
          const incoming = req.headers['x-request-id'];
          req.requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
          res.setHeader('x-request-id', req.requestId);
          next();
        })
        .forRoutes('*path');
    }
  }
  return AppModule;
}
