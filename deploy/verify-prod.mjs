// Starts the COMPILED API exactly as production would (NODE_ENV=production, generated secrets, no demo data) against a
// throw-away PostgreSQL and checks the properties that matter for going live. This is the part of the deployment that
// can be verified without Docker. Run after `pnpm build`:   node deploy/verify-prod.mjs
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadEmbedded, freePort, dbUrl, INITDB_FLAGS } from '../infrastructure/scripts/pg-lib.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const EmbeddedPostgres = await loadEmbedded();
const pgPort = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiu-prod-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: tmp, user: 'kiu', password: 'kiu_prod_check', port: pgPort, persistent: false, initdbFlags: INITDB_FLAGS, onLog: () => {}, onError: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('kiu_prod_check');

const API_PORT = await freePort();
const secrets = () => ({
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CARD_MASTER_KEY: randomBytes(16).toString('hex'), CACHE_SIGNING_KEY: randomBytes(32).toString('hex'),
});
const prodEnv = (over = {}) => ({
  ...process.env, NODE_ENV: 'production', API_PORT: String(API_PORT), DATABASE_URL: dbUrl(pgPort, 'kiu_prod_check', 'kiu', 'kiu_prod_check'),
  DIRECT_URL: dbUrl(pgPort, 'kiu_prod_check', 'kiu', 'kiu_prod_check'),
  COOKIE_SECURE: 'true', SEED_DEMO_ACCOUNTS: 'false', CORS_ORIGINS: '', ...secrets(), ...over,
});
const run = (args, env) => spawnSync('node', args, { cwd: ROOT, env, encoding: 'utf8', shell: false });

// 1. the API refuses to start with unsafe settings
const bad = (name, over, pattern) => {
  const r = run(['apps/api/dist/main.js'], prodEnv(over));
  check(name, r.status !== 0 && pattern.test(`${r.stderr}${r.stdout}`), `exit ${r.status}`);
};
bad('refuses a placeholder JWT secret', { JWT_ACCESS_SECRET: 'dev-only-change-me-access-secret-0123456789abcdef' }, /Placeholder JWT_ACCESS_SECRET/);
bad('refuses the published development card master key', { CARD_MASTER_KEY: '000102030405060708090a0b0c0d0e0f' }, /Placeholder CARD_MASTER_KEY/);
bad('refuses the published development signing key', { CACHE_SIGNING_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' }, /Placeholder CACHE_SIGNING_KEY/);
bad('refuses insecure cookies', { COOKIE_SECURE: 'false' }, /COOKIE_SECURE must be true/);
bad('refuses demo accounts', { SEED_DEMO_ACCOUNTS: 'true' }, /SEED_DEMO_ACCOUNTS must be false/);
bad('refuses a too-short JWT secret', { JWT_ACCESS_SECRET: 'short' }, /JWT_ACCESS_SECRET/);

// 2. migrate, seed roles only, create the first administrator
const env = prodEnv();
const mig = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: ROOT, env, encoding: 'utf8', shell: true });
check('migrations apply on an empty database', mig.status === 0);
const seed = run(['apps/api/dist/seed/run.js'], env);
check('seed in production creates roles only, no demo data', seed.status === 0 && /skipped demo data/.test(seed.stdout), seed.stdout.trim().split('\n').pop());
const admin = run(['apps/api/dist/seed/create-admin.js', 'first.admin@university.example', 'First Admin'], env);
const password = /password[^:]*:\s*(\S+)/.exec(admin.stdout)?.[1];
check('create-admin makes a super administrator with a random one-time password', admin.status === 0 && !!password && password.length >= 20);
check('create-admin refuses the reserved demo domain', run(['apps/api/dist/seed/create-admin.js', 'x@kiu-demo.test'], env).status !== 0);
check('create-admin refuses a duplicate', run(['apps/api/dist/seed/create-admin.js', 'first.admin@university.example'], env).status !== 0);

// 3. start it for real
const api = spawn('node', ['apps/api/dist/main.js'], { cwd: ROOT, env, stdio: 'ignore' });
const base = `http://127.0.0.1:${API_PORT}`;
let up = false;
for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/api/v1/health`)).ok; } catch { /* starting */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
check('API starts in production mode and answers /health', up);

if (up) {
  const j = (p, o = {}) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', 'X-Token-Delivery': 'body', ...(o.headers ?? {}) } });
  const docs = await j('/api/docs');
  check('API documentation (swagger) is not exposed', docs.status === 404, `HTTP ${docs.status}`);
  const h = await j('/api/v1/health');
  check('security headers are set (nosniff, frame-ancestors none)', h.headers.get('x-content-type-options') === 'nosniff' && /frame-ancestors 'none'/.test(h.headers.get('content-security-policy') ?? ''));
  check('protected routes need a login', (await j('/api/v1/students')).status === 401);
  const demo = await j('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'student01@kiu-demo.test', password: 'Demo-Password-2026!' }) });
  check('no demo logins exist', demo.status === 401, `HTTP ${demo.status}`);
  const login = await j('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'first.admin@university.example', password }) });
  const body = await login.json().catch(() => ({}));
  check('the first administrator can sign in', login.status === 200 && !!body.accessToken);
  check('and is forced to set up an authenticator app before anything else', body.mfaSetupRequired === true);
  const gated = await j('/api/v1/students', { headers: { Authorization: `Bearer ${body.accessToken}` } });
  check('until then even their own permissions are refused', gated.status === 403, `HTTP ${gated.status}`);
  const cookies = login.headers.getSetCookie?.() ?? [];
  check('session cookies are Secure and HttpOnly', cookies.length > 0 && cookies.filter((c) => /kiu_(at|rt)/.test(c)).every((c) => /Secure/i.test(c) && /HttpOnly/i.test(c)));
  const bad = await j('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'first.admin@university.example', password: 'wrong-password-123' }) });
  check('a wrong password is refused', bad.status === 401);
  const cors = await j('/api/v1/health', { headers: { Origin: 'https://evil.example' } });
  check('no cross-origin access is granted to other sites', !cors.headers.get('access-control-allow-origin'));
}

api.kill();
await pg.stop().catch(() => undefined);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
