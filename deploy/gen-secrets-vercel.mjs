// Prints freshly generated secrets for the @kiu/api Vercel project, ready to paste into
// Project Settings -> Environment Variables (or pipe into `vercel env add`).
//   node deploy/gen-secrets-vercel.mjs
// Unlike deploy/gen-secrets.mjs (self-hosted Docker), this does not write a file: Vercel env vars
// are not read from a local .env.production, so there is nothing to keep in sync on disk here.
import { randomBytes } from 'node:crypto';

const values = {
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CARD_MASTER_KEY: randomBytes(16).toString('hex'),
  CACHE_SIGNING_KEY: randomBytes(32).toString('hex'),
};

console.log('Paste these into the Vercel project\'s Environment Variables (Production):\n');
for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
console.log('\nSave a copy in a password manager too — they are not recoverable, and losing them');
console.log('invalidates encrypted MFA secrets / reader secrets / face templates / issued cards.');
