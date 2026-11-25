// Runs a command against a real PostgreSQL with migrations applied.
//   node with-db.mjs jest --runInBand
// Uses TEST_DATABASE_URL when set (CI / Docker). Otherwise boots a throw-away embedded instance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadEmbedded, freePort, dbUrl, run, INITDB_FLAGS } from './pg-lib.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: with-db.mjs <command...>'); process.exit(2); }

let pg = null;
let tmp = null;
let url = process.env.TEST_DATABASE_URL;

if (!url) {
  const EmbeddedPostgres = await loadEmbedded();
  const port = await freePort();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiu-pg-'));
  // Expected constraint violations are asserted by the tests; keep server noise out of the output.
  const quiet = process.env.PG_VERBOSE ? {} : { onLog: () => {}, onError: () => {} };
  pg = new EmbeddedPostgres({ databaseDir: tmp, user: 'kiu', password: 'kiu_dev_password', port, persistent: false, initdbFlags: INITDB_FLAGS, ...quiet });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kiu_uscas_test');
  url = dbUrl(port, 'kiu_uscas_test');
}

const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, TEST_DATABASE_URL: url };
let code = await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env });
if (code === 0) code = await run(cmd, args, { env, cwd: process.cwd() });

if (pg) {
  // In non-persistent mode embedded-postgres also deletes its data dir and, on Windows, can throw EBUSY while
  // the server releases file handles. That must not turn a passing test run into a failure.
  try { await pg.stop(); } catch (e) { if (process.env.PG_VERBOSE) console.warn('pg.stop():', e?.code ?? e); }
  await new Promise((r) => setTimeout(r, 500));
}
if (tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch { console.warn(`(could not remove temp database dir ${tmp}; safe to delete)`); }
}
process.exit(code);
