import { randomBytes } from 'node:crypto';
import { loadEnv } from './env';
import { passwordPolicyError } from '../modules/auth/auth.constants';

const base = () => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CARD_MASTER_KEY: randomBytes(16).toString('hex'),
  CACHE_SIGNING_KEY: randomBytes(32).toString('hex'),
});

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv(base() as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ NODE_ENV: 'development', ACCESS_TOKEN_TTL_SECONDS: 900, COOKIE_SECURE: false, LOGIN_MAX_FAILURES: 5 });
  });

  it('fails fast with every problem listed', () => {
    expect(() => loadEnv({ JWT_ACCESS_SECRET: 'short', DATA_ENCRYPTION_KEY: 'AAAA' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL[\s\S]*JWT_ACCESS_SECRET[\s\S]*DATA_ENCRYPTION_KEY/);
  });

  it('refuses insecure production settings', () => {
    const prod = { ...base(), NODE_ENV: 'production' };
    expect(() => loadEnv(prod as NodeJS.ProcessEnv)).toThrow(/COOKIE_SECURE/);
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'true', SEED_DEMO_ACCOUNTS: 'true' } as NodeJS.ProcessEnv)).toThrow(/SEED_DEMO_ACCOUNTS/);
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'true', JWT_ACCESS_SECRET: 'dev-only-change-me-'.padEnd(40, 'x') } as NodeJS.ProcessEnv)).toThrow(/Placeholder/);
    for (const k of ['0'.repeat(32), '000102030405060708090a0b0c0d0e0f']) {
      expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'true', CARD_MASTER_KEY: k } as NodeJS.ProcessEnv)).toThrow(/CARD_MASTER_KEY/);
    }
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'true', CACHE_SIGNING_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv)).toThrow(/CACHE_SIGNING_KEY/);
    // A genuine random key must be accepted even if it happens to start with 0, 1 or f.
    expect(loadEnv({ ...prod, COOKIE_SECURE: 'true', CARD_MASTER_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' } as NodeJS.ProcessEnv).NODE_ENV).toBe('production');
  });

  it('splits CORS origins', () => {
    expect(loadEnv({ ...base(), CORS_ORIGINS: 'http://a.test, http://b.test' } as NodeJS.ProcessEnv).CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });
});

describe('passwordPolicyError', () => {
  it.each([
    ['short1!', 'at least 12'],
    ['a'.repeat(129), 'at most 128'],
    ['password1234', 'too common'],
    ['aaaaaaaaaaaa', 'repetitive'],
  ])('rejects %s', (pw, msg) => expect(passwordPolicyError(pw)).toMatch(new RegExp(msg)));

  it('rejects passwords containing the email name', () => {
    expect(passwordPolicyError('zebrafish-2026-x', { email: 'zebrafish@kiu.test' })).toMatch(/email name/);
  });

  it('accepts long passphrases without composition rules', () => {
    expect(passwordPolicyError('correct horse battery staple')).toBeNull();
  });
});
