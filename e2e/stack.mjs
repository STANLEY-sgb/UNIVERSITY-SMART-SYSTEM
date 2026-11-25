// Boots the real backend for browser tests: throw-away PostgreSQL -> migrations -> demo seed -> operator account -> API on :4000.
// Nothing here is mocked. Playwright starts this via webServer and waits for /api/v1/health.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, loadEmbedded, freePort, dbUrl, INITDB_FLAGS } from '../infrastructure/scripts/pg-lib.mjs';

export const OPERATOR = { email: 'e2e-operator@kiu-demo.test', password: 'Demo-Password-2026!' };
export const ADMIN = { email: 'e2e-admin@kiu-demo.test', password: 'Demo-Password-2026!' };

const EmbeddedPostgres = await loadEmbedded();
const port = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiu-e2e-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: tmp, user: 'kiu', password: 'kiu_dev_password', port, persistent: false, initdbFlags: INITDB_FLAGS,
  onLog: () => {}, onError: () => {},
});
await pg.initialise();
await pg.start();
await pg.createDatabase('kiu_e2e');

const env = {
  ...process.env,
  NODE_ENV: 'test', API_PORT: '4000',
  DATABASE_URL: dbUrl(port, 'kiu_e2e'),
  DIRECT_URL: dbUrl(port, 'kiu_e2e'),
  JWT_ACCESS_SECRET: 'e2e-only-jwt-secret-0123456789abcdef0123456789',
  DATA_ENCRYPTION_KEY: 'ZGV2LW9ubHkta2V5LTAxMjM0NTY3ODktYWJjZGVmLWs=',
  CARD_MASTER_KEY: 'c0ffee00c0ffee11c0ffee22c0ffee33',
  CACHE_SIGNING_KEY: '5e2e5e2e5e2e5e2e0123456789abcdef5e2e5e2e5e2e5e2e0123456789abcdef',
  COOKIE_SECURE: 'false',
  CORS_ORIGINS: 'http://localhost:3000,http://localhost:3001,http://localhost:3002',
  THROTTLE_DEFAULT_LIMIT: '100000', THROTTLE_LOGIN_LIMIT: '100000', THROTTLE_READER_LIMIT: '100000', THROTTLE_READER_IP_LIMIT: '100000',
  OFFLINE_CACHE_TTL_MINUTES: '30', SEED_DEMO_ACCOUNTS: 'true',
};

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};
sh('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);
sh('node', ['apps/api/dist/seed/run.js']);

// A non-MFA operator (cards + readers + logs) so browser tests can provision data through the real admin API.
const requireApi = createRequire(path.join(ROOT, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const argon2 = requireApi('argon2');
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const perms = ['students.view', 'cards.view', 'cards.issue', 'cards.block', 'cards.replace', 'readers.view', 'readers.manage', 'access.logs.view', 'alerts.view'];
const role = await prisma.role.create({ data: { code: 'E2E_OPERATOR', name: 'E2E operator', description: 'Browser-test operator (no MFA requirement)' } });
for (const code of perms) {
  const p = await prisma.permission.findUnique({ where: { code } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
}
await prisma.user.create({
  data: {
    email: OPERATOR.email, displayName: 'E2E Operator', userType: 'STAFF',
    passwordHash: await argon2.hash(OPERATOR.password, { type: argon2.argon2id }),
    roles: { create: [{ roleId: role.id }] },
  },
});
// A broad, non-MFA admin role so the console's every page and action can be driven in a browser without a TOTP step.
const adminPerms = ['reports.view', 'students.view', 'students.create', 'students.update', 'cards.view', 'cards.issue', 'cards.block', 'cards.replace', 'readers.view', 'readers.manage', 'rules.view', 'rules.manage', 'services.view', 'access.logs.view', 'alerts.view', 'alerts.manage', 'audit.view', 'users.view', 'users.manage', 'finance.view', 'library.view', 'hostel.view', 'hostel.manage', 'cafeteria.view', 'cafeteria.manage', 'registry.view', 'registry.manage', 'finance.update', 'library.manage', 'integrations.view', 'reports.export', 'exams.view', 'exams.manage', 'exams.attendance.view', 'biometrics.enroll', 'biometrics.view', 'biometrics.revoke', 'biometrics.policy.manage', 'settings.manage', 'access.override'];
const adminRole = await prisma.role.create({ data: { code: 'E2E_ADMIN', name: 'E2E administrator', description: 'Browser-test administrator (no MFA requirement)' } });
for (const code of adminPerms) {
  const p = await prisma.permission.findUnique({ where: { code } });
  await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId: p.id } });
}
await prisma.user.create({
  data: { email: ADMIN.email, displayName: 'E2E Administrator', userType: 'STAFF', passwordHash: await argon2.hash(ADMIN.password, { type: argon2.argon2id }), roles: { create: [{ roleId: adminRole.id }] } },
});
await prisma.$disconnect();

const api = spawn('node', ['apps/api/dist/main.js'], { cwd: ROOT, env, stdio: 'inherit' });
api.on('exit', (code) => { console.error(`API exited (${code})`); void cleanup(1); });

let closing = false;
async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  try { api.kill(); } catch { /* already gone */ }
  try { await pg.stop(); } catch { /* EBUSY on Windows is harmless */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
  process.exit(code);
}
process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());
process.on('exit', () => { try { api.kill(); } catch { /* ignore */ } });
console.log(`E2E stack ready: API http://localhost:4000 (pg on ${port})`);
