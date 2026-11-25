// One-command local demo: persistent PostgreSQL -> migrations -> fictional demo data -> API -> the three web apps.
//   pnpm demo            (or double-click start-demo.bat on Windows)
// State lives in ./.demo-data, so what you create survives restarts. Delete that folder for a fresh start.
// Everything here is DEVELOPMENT ONLY: placeholder secrets, fictional people, no MFA on the demo administrator.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, loadEmbedded, dbUrl, INITDB_FLAGS } from './pg-lib.mjs';

const PG_PORT = 54330;
const DB = 'kiu_demo';
const DATA = path.join(ROOT, '.demo-data');
const PASSWORD = 'Demo-Password-2026!';
const ADMIN = { email: 'demo-admin@kiu-demo.test', password: PASSWORD };
const APPS = [
  { name: 'Admin console', pkg: '@kiu/admin', port: 3000 },
  { name: 'Student wallet', pkg: '@kiu/student-portal', port: 3001 },
  { name: 'Reader', pkg: '@kiu/reader', port: 3002 },
];

const log = (m) => console.log(`\x1b[36m[demo]\x1b[0m ${m}`);
// Once things are running, a failure must stop them too, or the API and database would be left behind.
let stopAll = async () => {};
const fail = (m) => { console.error(`\n\x1b[31m[demo] ${m}\x1b[0m\n`); void stopAll().finally(() => process.exit(1)); };
const inUse = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(true));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
});

// ── preflight ──
for (const p of [4000, 3000, 3001, 3002, PG_PORT]) {
  if (await inUse(p)) fail(`Port ${p} is already in use. Close whatever is using it (an earlier demo, a dev server) and run again.`);
}
const built = ['apps/api/dist/main.js', 'apps/admin/dist/index.html', 'apps/student-portal/dist/index.html', 'apps/reader/dist/index.html'].every((f) => fs.existsSync(path.join(ROOT, f)));
if (!built || process.argv.includes('--build')) {
  log('Building the application (first run takes a few minutes)...');
  const r = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('The build failed. Run `pnpm build` to see the errors.');
}

// ── database (persistent) ──
fs.mkdirSync(DATA, { recursive: true });
const EmbeddedPostgres = await loadEmbedded();
const pgDir = path.join(DATA, 'pg');
const fresh = !fs.existsSync(path.join(pgDir, 'PG_VERSION'));
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'kiu', password: 'kiu_dev_password', port: PG_PORT, persistent: true, initdbFlags: INITDB_FLAGS, onLog: () => {}, onError: () => {} });
log(fresh ? 'Creating the demo database...' : 'Starting the demo database...');
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DB);
stopAll = async () => { try { await pg.stop(); } catch { /* harmless on Windows */ } };

const env = {
  ...process.env,
  NODE_ENV: 'development', API_PORT: '4000', API_PUBLIC_URL: 'http://localhost:4000',
  DATABASE_URL: dbUrl(PG_PORT, DB),
  DIRECT_URL: dbUrl(PG_PORT, DB),
  JWT_ACCESS_SECRET: 'demo-only-jwt-secret-0123456789abcdef0123456789',
  DATA_ENCRYPTION_KEY: 'ZGV2LW9ubHkta2V5LTAxMjM0NTY3ODktYWJjZGVmLWs=',
  CARD_MASTER_KEY: 'c0ffee00c0ffee11c0ffee22c0ffee33',
  CACHE_SIGNING_KEY: 'd3d3d3d3d3d3d3d30123456789abcdefd3d3d3d3d3d3d3d30123456789abcdef',
  COOKIE_SECURE: 'false',
  CORS_ORIGINS: 'http://localhost:3000,http://localhost:3001,http://localhost:3002',
  THROTTLE_DEFAULT_LIMIT: '5000', THROTTLE_LOGIN_LIMIT: '500', THROTTLE_READER_LIMIT: '5000', THROTTLE_READER_IP_LIMIT: '5000',
  OFFLINE_CACHE_TTL_MINUTES: '30', SEED_DEMO_ACCOUNTS: 'true',
};
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
};
log('Applying database migrations...');
sh('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);

const seededMarker = path.join(DATA, 'seeded');
if (!fs.existsSync(seededMarker)) {
  log('Seeding fictional demo data (60 students, staff for every role, services, rules, exams)...');
  sh('node', ['apps/api/dist/seed/run.js']);
  fs.writeFileSync(seededMarker, new Date().toISOString());
}

// A full-permission administrator without MFA so every page can be explored immediately.
const requireApi = createRequire(path.join(ROOT, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const argon2 = requireApi('argon2');
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
if (!(await prisma.user.findUnique({ where: { email: ADMIN.email } }))) {
  const role = await prisma.role.upsert({ where: { code: 'DEMO_ADMIN' }, update: {}, create: { code: 'DEMO_ADMIN', name: 'Demo administrator', description: 'Every permission, no MFA. Demo only.' } });
  for (const p of await prisma.permission.findMany({ where: { code: { not: { startsWith: 'me.' } } } })) {
    await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } }, update: {}, create: { roleId: role.id, permissionId: p.id } });
  }
  await prisma.user.create({
    data: { email: ADMIN.email, displayName: 'Demo Administrator', userType: 'STAFF', passwordHash: await argon2.hash(ADMIN.password, { type: argon2.argon2id }), roles: { create: [{ roleId: role.id }] } },
  });
}
await prisma.$disconnect();

// ── processes ──
const children = [];
const start = (name, cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { cwd: ROOT, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  c.stdout.on('data', (d) => process.env.DEMO_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  c.stderr.on('data', (d) => process.env.DEMO_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  c.on('exit', (code) => { if (!closing) { console.error(`[demo] ${name} stopped (${code}). Shutting down.`); void cleanup(1); } });
  children.push(c);
  return c;
};
let closing = false;
async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  log('Stopping...');
  for (const c of children) {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); else c.kill(); } catch { /* gone */ }
  }
  try { await pg.stop(); } catch { /* harmless on Windows */ }
  process.exit(code);
}
stopAll = () => cleanup(1);
process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());

log('Starting the API...');
start('api', 'node', ['apps/api/dist/main.js']);
const waitFor = async (url, what, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${what} did not start. Re-run with DEMO_VERBOSE=1 to see its output.`);
};
await waitFor('http://localhost:4000/api/v1/health', 'The API');

// ── first-run provisioning through the real API: readers + cards, kept for later runs ──
const credsFile = path.join(DATA, 'credentials.json');
let creds = fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, 'utf8')) : null;
if (!creds) {
  log('Provisioning demo readers and cards...');
  const call = async (method, p, body, token) => {
    const r = await fetch(`http://localhost:4000/api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Token-Delivery': 'body', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) fail(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}
If an earlier start was interrupted, stop everything, delete the .demo-data folder and start again.`);
    return j;
  };
  const token = (await call('POST', '/auth/login', ADMIN)).accessToken;
  const readers = [];
  for (const [code, name, service, venue, face] of [
    ['DEMO-GATE', 'Main gate (face-capable)', 'GATE', 'GATE-MAIN', true],
    ['DEMO-EXAM', 'Exam hall A', 'EXAM', 'EXH-A', false],
    ['DEMO-LIBRARY', 'Library entry', 'LIBRARY_ENTRY', 'LIB-MAIN', false],
    ['DEMO-BORROW', 'Library borrowing desk', 'LIBRARY_BORROW', 'LIB-MAIN', false],
    ['DEMO-CAFE', 'Cafeteria', 'CAFETERIA', 'CAF-MAIN', false],
    ['DEMO-HOSTEL-A', 'Hostel A door', 'HOSTEL', 'HOSTEL-A', false],
  ]) {
    const r = await call('POST', '/readers', { code, name, serviceCode: service, venueCode: venue, supportsFace: face }, token);
    if (face) await fetch(`http://localhost:4000/api/v1/biometrics/devices/${r.reader.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ authorised: true, reason: 'Demo gate approved for face verification' }) });
    readers.push({ code, name, service, readerId: r.reader.id, keyId: r.credentials.keyId, secret: r.credentials.secret });
  }
  const cards = [];
  for (const n of [1, 2, 3, 4]) {
    const regNo = `2026-${['BCS', 'BIT', 'BBA', 'LLB', 'BED'][(n - 1) % 5]}-${String(n).padStart(4, '0')}`;
    const c = await call('POST', '/cards', { regNo }, token);
    cards.push({ student: `student${String(n).padStart(2, '0')}@kiu-demo.test`, regNo, cardNumber: c.card.cardNumber, activationCode: c.activationCode });
  }
  creds = { readers, cards };
  fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2));
}

const roleAccounts = ['super-admin', 'ict-admin', 'card-officer', 'biometric-officer', 'finance-officer', 'registry-officer', 'librarian', 'security-officer', 'invigilator', 'hostel-warden', 'cafeteria-operator', 'management'];
const md = [
  '# KIU-USCAS local demo: your logins and reader credentials', '',
  '_Fictional data, development secrets. Generated by `pnpm demo`; this file is regenerated on each start._', '',
  '## Open these', '',
  '| App | Address | Who uses it |', '|---|---|---|',
  '| Admin console | http://localhost:3000 | staff |', '| Student wallet | http://localhost:3001 | students |', '| Reader | http://localhost:3002 | the person at the door |',
  '| API docs | http://localhost:4000/api/docs | developers |', '',
  '## Logins (password for all: `' + PASSWORD + '`)', '',
  `* **Everything, no MFA:** \`${ADMIN.email}\``,
  '* **One role at a time (to see what each can do):** ' + roleAccounts.map((r) => `\`${r}@kiu-demo.test\``).join(', ') + ' (`super-admin` and `ict-admin` ask for an authenticator-app code on first login)',
  '* **Students:** `student01@kiu-demo.test` … `student12@kiu-demo.test`', '',
  '## Students with a card ready to activate in the wallet', '',
  '| Student login | Reg. no. | Activation code |', '|---|---|---|',
  ...creds.cards.map((c) => `| ${c.student} | ${c.regNo} | \`${c.activationCode}\` |`), '',
  '(Used codes stop working. Issue a new card in the console: Cards.)', '',
  '## Readers: paste these into the Reader app setup screen', '',
  'Server address: `http://localhost:4000`', '',
  '| Reader | Service | Reader ID | Key ID | Secret |', '|---|---|---|---|---|',
  ...creds.readers.map((r) => `| ${r.name} | ${r.service} | \`${r.readerId}\` | \`${r.keyId}\` | \`${r.secret}\` |`), '',
  'See docs/DEMO_GUIDE.md for what to try.', '',
];
fs.writeFileSync(path.join(DATA, 'CREDENTIALS.md'), md.join('\n'));

log('Starting the web apps...');
for (const a of APPS) start(a.name, 'pnpm', ['--filter', a.pkg, 'preview']);
for (const a of APPS) await waitFor(`http://localhost:${a.port}`, a.name);

console.log(`
\x1b[32m  KIU-USCAS demo is running\x1b[0m
  Admin console   http://localhost:3000     login: ${ADMIN.email} / ${PASSWORD}
  Student wallet  http://localhost:3001     login: student01@kiu-demo.test / ${PASSWORD}
  Reader          http://localhost:3002     (setup values are in the credentials file)
  Credentials     ${path.join(DATA, 'CREDENTIALS.md')}
  Walkthrough     docs/DEMO_GUIDE.md

  Press Ctrl+C here to stop. Your data is kept in .demo-data for next time.
`);
if (!process.argv.includes('--no-open')) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', 'http://localhost:3000'], { stdio: 'ignore', detached: true }).unref();
}
setInterval(() => {}, 1 << 30);
