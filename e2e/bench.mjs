// Measures access-decision latency and throughput against the REAL stack (throw-away PostgreSQL, compiled API, real HTTP,
// real reader HMAC signing and Ed25519 QR verification). Nothing is mocked. Usage: pnpm bench  (after pnpm build)
// The numbers are for this machine only; they are a measurement, not a capacity claim.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadEmbedded, freePort, dbUrl, INITDB_FLAGS } from '../infrastructure/scripts/pg-lib.mjs';

const API_PORT = 4100;
const EmbeddedPostgres = await loadEmbedded();
const pgPort = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiu-bench-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: tmp, user: 'kiu', password: 'kiu_dev_password', port: pgPort, persistent: false, initdbFlags: INITDB_FLAGS, onLog: () => {}, onError: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('kiu_bench');

const env = {
  ...process.env, NODE_ENV: 'test', API_PORT: String(API_PORT), DATABASE_URL: dbUrl(pgPort, 'kiu_bench'), DIRECT_URL: dbUrl(pgPort, 'kiu_bench'),
  JWT_ACCESS_SECRET: 'bench-only-jwt-secret-0123456789abcdef0123456789', DATA_ENCRYPTION_KEY: 'ZGV2LW9ubHkta2V5LTAxMjM0NTY3ODktYWJjZGVmLWs=',
  CARD_MASTER_KEY: 'c0ffee00c0ffee11c0ffee22c0ffee33', CACHE_SIGNING_KEY: '5e2e5e2e5e2e5e2e0123456789abcdef5e2e5e2e5e2e5e2e0123456789abcdef',
  COOKIE_SECURE: 'false', CORS_ORIGINS: 'http://localhost:3000',
  THROTTLE_DEFAULT_LIMIT: '1000000', THROTTLE_LOGIN_LIMIT: '1000000', THROTTLE_READER_LIMIT: '1000000', THROTTLE_READER_IP_LIMIT: '1000000', SEED_DEMO_ACCOUNTS: 'true',
};
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'ignore', shell: true }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`); };
sh('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);
sh('node', ['apps/api/dist/seed/run.js']);

const requireApi = createRequire(path.join(ROOT, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const argon2 = requireApi('argon2');
const { generateQrKeyPair, signQr } = requireApi('@kiu/vcard');
const { signReaderRequest } = requireApi('@kiu/security');
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

const role = await prisma.role.create({ data: { code: 'BENCH', name: 'bench', description: 'bench' } });
for (const code of ['readers.manage', 'readers.view']) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: (await prisma.permission.findUnique({ where: { code } })).id } });
await prisma.user.create({ data: { email: 'bench@kiu-demo.test', displayName: 'Bench', userType: 'STAFF', passwordHash: await argon2.hash('Demo-Password-2026!', { type: argon2.argon2id }), roles: { create: [{ roleId: role.id }] } } });

const hex = (n) => randomBytes(n).toString('hex').toUpperCase();
const students = await prisma.student.findMany({ select: { id: true } });
const cards = [];
for (const s of students) {
  const keys = generateQrKeyPair();
  const cardNumber = `KIU${hex(6)}`;
  await prisma.card.create({ data: { cardNumber, uidHex: hex(7), studentId: s.id, status: 'ACTIVE', regNoHash: hex(32), issuedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000) } })
    .then(async (c) => { await prisma.cardCredential.create({ data: { cardId: c.id, kind: 'ED25519_QR', publicKeyHex: keys.publicKeyHex } }); cards.push({ cardNumber, key: keys.privateKeyHex, counter: 0 }); })
    .catch(() => undefined);
}
await prisma.$disconnect();

const api = spawn('node', ['apps/api/dist/main.js'], { cwd: ROOT, env, stdio: 'ignore' });
const base = `http://127.0.0.1:${API_PORT}`;
for (let i = 0; ; i++) { try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch { /* starting */ } if (i > 120) throw new Error('API did not start'); await new Promise((r) => setTimeout(r, 500)); }

const login = await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token-Delivery': 'body' }, body: JSON.stringify({ email: 'bench@kiu-demo.test', password: 'Demo-Password-2026!' }) })).json();
const made = await (await fetch(`${base}/api/v1/readers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ code: 'BENCH-GATE', name: 'Bench gate', serviceCode: 'GATE', venueCode: 'GATE-MAIN' }) })).json();
const { keyId, secret } = made.credentials;

let nCard = 0;
async function one() {
  const c = cards[nCard++ % cards.length];
  const qr = signQr(c.key, { cardNumber: c.cardNumber, counter: ++c.counter });
  const url = '/api/v1/access/verify';
  c.inside = !c.inside; // alternate ENTRY/EXIT so anti-passback does not turn every request into a cheap denial
  const body = JSON.stringify({ credential: { type: 'QR', token: qr }, direction: c.inside ? 'ENTRY' : 'EXIT' });
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const sig = signReaderRequest(secret, 'POST', url, ts, nonce, body);
  const t0 = performance.now();
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Key-Id': keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig }, body });
  const j = await res.json();
  return { ms: performance.now() - t0, status: res.status, decision: j.decision, reason: j.reason_code ?? j.code, server: j.processing_ms };
}
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
async function run(label, total, concurrency) {
  const lat = [], srv = []; let ok = 0, grant = 0, deny = 0, errors = 0; const reasons = {};
  const t0 = performance.now(); let issued = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (issued < total) {
      issued++;
      try { const r = await one(); if (r.status === 200) { ok++; r.decision === 'GRANT' ? grant++ : deny++; reasons[r.reason] = (reasons[r.reason] ?? 0) + 1; lat.push(r.ms); if (typeof r.server === 'number') srv.push(r.server); } else errors++; } catch { errors++; }
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b); srv.sort((a, b) => a - b);
  return { reasons, label, concurrency, requests: total, ok, grant, deny, errors, rps: Math.round(ok / secs), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1], srvP50: pct(srv, 50), srvP95: pct(srv, 95) };
}

await run('warm-up', 200, 4);
const results = [];
results.push(await run('one reader at a time', 600, 1));
results.push(await run('10 readers at once', 2000, 10));
results.push(await run('50 readers at once', 3000, 50));

api.kill();
await pg.stop().catch(() => undefined);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

const f = (n) => (n === undefined ? '-' : n.toFixed(1));
const lines = [
  `# Measured access-decision performance`, '',
  `Measured ${new Date().toISOString().slice(0, 10)} on ${os.cpus()[0].model.trim()} (${os.cpus().length} logical cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${process.platform}), Node ${process.version}.`,
  'Setup: one compiled API process, an embedded PostgreSQL on the same machine, real HTTP, real reader HMAC signing and Ed25519 QR verification, every request a different signed QR (gate service, alternating ENTRY/EXIT per card; the seeded demo data includes some suspended students, so a minority of requests are denials). Client and server share the machine, so the client\'s own work is in the numbers. **This is a measurement on a developer laptop, not a capacity or production claim.**', '',
  '| Scenario | Requests | OK | GRANT | DENY | Errors | req/s | p50 ms | p95 ms | p99 ms | max ms | server p50 | server p95 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.label} | ${r.requests} | ${r.ok} | ${r.grant} | ${r.deny} | ${r.errors} | ${r.rps} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} | ${f(r.srvP50)} | ${f(r.srvP95)} |`), '',
  'Latency is measured by the client from just before sending to the response body being read ("server" = the API\'s own `processing_ms`). The product target is a decision in about 800 ms (online-first window); compare p95/p99 with that number.', '',
  'What this does **not** show: network latency between a real reader and the server, TLS, a separate database host, many API instances, Redis, a cold cache, or face verification. Re-run with `pnpm bench` after changes.', '',
];
fs.writeFileSync(path.join(ROOT, 'docs', 'PERFORMANCE.md'), lines.join('\n'));
console.log(lines.join(String.fromCharCode(10)));
console.log('REASONS', JSON.stringify(results.map((r) => r.reasons)));
process.exit(0);
