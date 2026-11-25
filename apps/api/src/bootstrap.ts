import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { buildAppModule } from './app.module';
import { Env, loadEnv } from './config/env';
import { AllExceptionsFilter } from './common/error.filter';

export const API_PREFIX = 'api/v1';

/** Applies pipes/filters/security middleware. Shared by main.ts and the e2e test harness. */
export function configureApp(app: INestApplication, env: Env): void {
  (app as NestExpressApplication).set('trust proxy', 1);
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Token-Delivery', 'X-Request-Id', 'X-Reader-Key-Id', 'X-Timestamp', 'X-Nonce', 'X-Signature'],
    maxAge: 86_400, // cache preflights: browser readers have only ~800 ms before the offline policy applies
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
}

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('KIU-USCAS API')
    .setDescription('KIU Unified Smart Card Access System (prototype). All data is fictional.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('kiu_at')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
}

export async function createApp(env: Env = loadEnv()): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(env), { bodyParser: true, rawBody: true, logger: env.NODE_ENV === 'test' ? ['error'] : undefined });
  app.useBodyParser('json', { limit: '256kb' });
  configureApp(app, env);
  if (env.NODE_ENV !== 'production') setupSwagger(app);
  return app;
}
