// Persistent local PostgreSQL for development without Docker.
//   pnpm db:dev          -> starts on 127.0.0.1:54329, data in ./.dev-db
// Then: set DATABASE_URL and DIRECT_URL (both printed below, same value here), run `pnpm db:deploy && pnpm db:seed`.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEmbedded, dbUrl, INITDB_FLAGS } from './pg-lib.mjs';

const PORT = Number(process.env.DEV_DB_PORT ?? 54329);
const DB = 'kiu_uscas';
const dir = path.join(ROOT, '.dev-db');
const EmbeddedPostgres = await loadEmbedded();
const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'kiu', password: 'kiu_dev_password', port: PORT, persistent: true, initdbFlags: INITDB_FLAGS,
});
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DB);

console.log(`\nPostgreSQL ready.\n  DATABASE_URL=${dbUrl(PORT, DB)}\n  DIRECT_URL=${dbUrl(PORT, DB)}\nPress Ctrl+C to stop.\n`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
