import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../bootstrap';
import { Env, loadEnv } from '../config/env';
import { seedCore } from '../seed/core';

export const TEST_PASSWORD = 'Correct-Horse-Battery-9!';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    JWT_ACCESS_SECRET: 'test-only-jwt-secret-0123456789abcdef0123456789',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CARD_MASTER_KEY: randomBytes(16).toString('hex'),
    CACHE_SIGNING_KEY: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    LOGIN_MAX_FAILURES: '5',
    LOGIN_LOCK_MINUTES: '15',
    THROTTLE_DEFAULT_LIMIT: '100000',
    THROTTLE_LOGIN_LIMIT: '100000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  app: INestApplication;
  prisma: PrismaClient;
  env: Env;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const env = testEnv(overrides);
  const prisma = new PrismaClient();
  await seedCore(prisma);
  const app = await createApp(env);
  await app.init();
  return {
    app, prisma, env,
    http: () => request(app.getHttpServer()),
    close: async () => { await app.close(); await prisma.$disconnect(); },
  };
}

let counter = 0;
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}@test.invalid`;
}

/** Creates an ACTIVE staff user directly in the DB with the given role codes. */
export async function createStaff(prisma: PrismaClient, roleCodes: string[], opts: { email?: string; password?: string; mfa?: boolean } = {}) {
  const email = opts.email ?? uniqueEmail(roleCodes[0]!.toLowerCase());
  const passwordHash = await argon2.hash(opts.password ?? TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
  const roles = await prisma.role.findMany({ where: { code: { in: roleCodes } } });
  const user = await prisma.user.create({
    data: { email, displayName: `Test ${roleCodes[0]}`, passwordHash, userType: 'STAFF', roles: { create: roles.map((r) => ({ roleId: r.id })) } },
  });
  return { id: user.id, email, password: opts.password ?? TEST_PASSWORD };
}

/** Logs in via the API with token delivery in the body (bearer-style client). */
export async function loginBearer(
  h: Harness, email: string, password = TEST_PASSWORD, mfaCode?: string,
): Promise<{ res: request.Response; token: string | undefined; refresh: string | undefined }> {
  const res = await h.http().post('/api/v1/auth/login').set('X-Token-Delivery', 'body').send({ email, password, ...(mfaCode ? { mfaCode } : {}) });
  return { res, token: res.body.accessToken as string | undefined, refresh: res.body.refreshToken as string | undefined };
}

export const bearer = (token: string | undefined) => ({ Authorization: `Bearer ${token}` });
