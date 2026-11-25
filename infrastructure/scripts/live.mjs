// One-command live system: persistent PostgreSQL (real data) -> migrations -> catalogue/rules only
// (no fictional people) -> API -> the three web apps, LAN-reachable for the desktop/mobile wrappers.
//   pnpm live
// State lives in ./.dev-db (the same persistent database `pnpm db:dev` points at), so what you
// enter through the admin console survives restarts. This is deliberately separate from
// `pnpm demo`, which only ever touches its own isolated fictional database in ./.demo-data.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, loadEmbedded, dbUrl, INITDB_FLAGS } from './pg-lib.mjs';

const PG_PORT = 54329;
const DB = 'kiu_uscas';
const DATA_DIR = path.join(ROOT, '.dev-db');
const SEEDED_MARKER = path.join(ROOT, '.dev-db.seeded');
const ADMIN_EMAIL = process.env.LIVE_ADMIN_EMAIL ?? 'musinguzialituhastanley5@gmail.com';
const ADMIN_NAME = process.env.LIVE_ADMIN_NAME; // optional; create-admin.js defaults to "System Administrator"
const APPS = [
  { name: 'Admin console', pkg: '@kiu/admin', port: 3000 },
  { name: 'Student wallet', pkg: '@kiu/student-portal', port: 3001 },
  { name: 'Reader', pkg: '@kiu/reader', port: 3002 },
];

const log = (m) => console.log(`\x1b[36m[live]\x1b[0m ${m}`);
let stopAll = async () => {};
const fail = (m) => { console.error(`\n\x1b[31m[live] ${m}\x1b[0m\n`); void stopAll().finally(() => process.exit(1)); };
const inUse = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(true));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
});

// ── preflight ──
for (const p of [4000, 3000, 3001, 3002, PG_PORT]) {
  if (await inUse(p)) fail(`Port ${p} is already in use. Close whatever is using it and run again.`);
}
if (!fs.existsSync(path.join(ROOT, 'apps/api/dist/main.js'))) {
  log('Building the API (first run)...');
  const r = spawnSync('pnpm', ['--filter', '@kiu/api', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('The API build failed. Run `pnpm --filter @kiu/api build` to see the errors.');
}

// ── database (persistent, real) ──
const EmbeddedPostgres = await loadEmbedded();
const fresh = !fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: 'kiu', password: 'kiu_dev_password', port: PG_PORT, persistent: true, initdbFlags: INITDB_FLAGS, onLog: () => {}, onError: () => {} });
log(fresh ? 'Creating the live database...' : 'Starting the live database...');
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DB);
stopAll = async () => { try { await pg.stop(); } catch { /* harmless on Windows */ } };

const env = { ...process.env, DATABASE_URL: dbUrl(PG_PORT, DB), DIRECT_URL: dbUrl(PG_PORT, DB) };
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
};
log('Applying database migrations...');
sh('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);

if (!fs.existsSync(SEEDED_MARKER)) {
  log('Seeding roles, permissions, the service catalogue and default access rules (no demo people)...');
  sh('node', ['apps/api/dist/seed/bootstrap.js']);
  log(`Creating the first administrator (${ADMIN_EMAIL})...`);
  sh('node', ['apps/api/dist/seed/create-admin.js', ADMIN_EMAIL, ...(ADMIN_NAME ? [ADMIN_NAME] : [])]);
  console.log('\x1b[33mStore the one-time password printed above now — it will not be shown again.\x1b[0m\n');
  fs.writeFileSync(SEEDED_MARKER, new Date().toISOString());
} else {
  log('Already bootstrapped on an earlier run; keeping your existing data as-is.');
}

// ── processes ──
const children = [];
const start = (name, cmd, args) => {
  const c = spawn(cmd, args, { cwd: ROOT, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => process.env.LIVE_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  c.stderr.on('data', (d) => process.env.LIVE_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  c.on('exit', (code) => { if (!closing) { console.error(`[live] ${name} stopped (${code}). Shutting down.`); void cleanup(1); } });
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
  fail(`${what} did not start. Re-run with LIVE_VERBOSE=1 to see its output.`);
};
await waitFor('http://localhost:4000/api/v1/health', 'The API');

log('Starting the web apps (LAN-reachable)...');
for (const a of APPS) start(a.name, 'pnpm', ['--filter', a.pkg, 'dev:lan']);
for (const a of APPS) await waitFor(`http://localhost:${a.port}`, a.name);

const lanIp = env.CORS_ORIGINS?.match(/http:\/\/(\d+\.\d+\.\d+\.\d+):3000/)?.[1];
console.log(`
\x1b[32m  KIU-USCAS live system is running\x1b[0m
  Admin console   http://localhost:3000${lanIp ? `   (LAN: http://${lanIp}:3000)` : ''}
  Student wallet  http://localhost:3001${lanIp ? `   (LAN: http://${lanIp}:3001)` : ''}
  Reader          http://localhost:3002${lanIp ? `   (LAN: http://${lanIp}:3002)` : ''}
  Sign in as      ${ADMIN_EMAIL}  (password: see the one-time output from the first run)

  This is your real, persistent data (kept in .dev-db) — not the demo stack.
  If your LAN IP ever changes, update apps/*/.env.lan (VITE_API_URL) and .env (CORS_ORIGINS).
  Press Ctrl+C here to stop.
`);
setInterval(() => {}, 1 << 30);
