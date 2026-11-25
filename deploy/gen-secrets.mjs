// Writes .env.production with freshly generated random secrets. Refuses to overwrite an existing file.
//   node deploy/gen-secrets.mjs admin.example.org wallet.example.org reader.example.org
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env.production');
if (fs.existsSync(target)) { console.error(`${target} already exists; not overwriting. Delete it first if you really want new secrets (that invalidates data encrypted with the old ones).`); process.exit(1); }

const [admin = 'admin.example.org', wallet = 'wallet.example.org', reader = 'reader.example.org'] = process.argv.slice(2);
const example = fs.readFileSync(path.join(root, 'deploy', '.env.production.example'), 'utf8');
const values = {
  ADMIN_HOST: admin, WALLET_HOST: wallet, READER_HOST: reader,
  POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CARD_MASTER_KEY: randomBytes(16).toString('hex'),
  CACHE_SIGNING_KEY: randomBytes(32).toString('hex'),
};
const out = example.split('\n').map((l) => { const m = /^([A-Z_]+)=/.exec(l); return m && m[1] in values ? `${m[1]}=${values[m[1]]}` : l; }).join('\n');
fs.writeFileSync(target, out, { mode: 0o600 });
console.log(`Wrote ${target} (permissions 600). Keep a copy in a password manager or vault; it is not recoverable.`);
