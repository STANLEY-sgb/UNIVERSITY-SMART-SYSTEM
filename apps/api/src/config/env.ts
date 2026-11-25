import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes',
  }),
  /** 16-byte AES master key (32 hex chars). Diversified per card; belongs in a KMS/HSM in production. */
  CARD_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{32}$/, 'CARD_MASTER_KEY must be 32 hex characters (16 bytes)'),
  /** Ed25519 seed (64 hex) that signs offline reader manifests; readers pin the matching public key. */
  CACHE_SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'CACHE_SIGNING_KEY must be 64 hex characters (32-byte Ed25519 seed)'),
  OFFLINE_CACHE_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30), // short on purpose: bounds how stale a reader can be
  CARD_VALIDITY_MONTHS: z.coerce.number().int().min(1).max(120).default(36), // placeholder pending KIU policy
  ACTIVATION_CODE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z.string().default('').transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  THROTTLE_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(120), // requests / minute / IP
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().min(1).default(10), // auth attempts / minute / IP
  THROTTLE_READER_LIMIT: z.coerce.number().int().min(1).default(600), // requests / minute / reader key (spec: >=20 students/min x ~3 calls)
  THROTTLE_READER_IP_LIMIT: z.coerce.number().int().min(1).default(6000), // ceiling per IP for all reader traffic (bounds spoofed key ids)
  SEED_DEMO_ACCOUNTS: bool,
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (env.SEED_DEMO_ACCOUNTS) throw new Error('SEED_DEMO_ACCOUNTS must be false in production');
    if (/dev-only|change-me/i.test(env.JWT_ACCESS_SECRET)) throw new Error('Placeholder JWT_ACCESS_SECRET in production');
    const ck = env.CACHE_SIGNING_KEY.toLowerCase();
    if (/^(.)\1{63}$/.test(ck) || ck === 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90') throw new Error('Placeholder CACHE_SIGNING_KEY in production');
    const k = env.CARD_MASTER_KEY.toLowerCase();
    if (/^(.)\1{31}$/.test(k) || k === '000102030405060708090a0b0c0d0e0f') throw new Error('Placeholder CARD_MASTER_KEY in production');
  }
  return env;
}

export const ENV = Symbol('ENV');
