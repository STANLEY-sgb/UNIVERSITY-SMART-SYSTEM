// Helpers for running a real PostgreSQL without Docker (dev + CI-less test runs).
// Docker Compose remains the documented path; this is the zero-install fallback.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Force UTF-8 so behaviour matches the Docker image (initdb otherwise inherits the Windows
// code page, e.g. WIN1252, which silently rejects/garbles non-Latin names).
export const INITDB_FLAGS = ['--encoding=UTF8', '--locale=C'];

export const ROOT =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadEmbedded() {
  // Resolves from this file upward to the workspace-root node_modules.
  const mod = await import('embedded-postgres');
  return mod.default;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export function dbUrl(port, db, user = 'kiu', password = 'kiu_dev_password') {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${db}?schema=public`;
}
