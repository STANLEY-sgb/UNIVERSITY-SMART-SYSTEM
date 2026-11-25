#!/usr/bin/env node
import { ApiClient, ApiTransport } from './api';
import { StudentLogin, freshWallet, runScenarios, createSimReader } from './scenarios';

/** fetch-based transport: the CLI talks to a running KIU-USCAS API, never to its internals. */
const fetchTransport = (base: string): ApiTransport => ({
  async request(method, path, opts = {}) {
    const res = await fetch(`${base}${path}`, { method, headers: opts.headers, ...(opts.bodyText !== undefined ? { body: opts.bodyText } : {}) });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: res.status, body };
  },
});

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : process.env[`KIU_${name.toUpperCase().replace(/-/g, '_')}`] ?? fallback;
}

const DEMO_PASSWORD = 'Demo-Password-2026!';
const demoStudents = (n: number): StudentLogin[] =>
  Array.from({ length: n }, (_, i) => {
    const nn = String(i + 1).padStart(2, '0');
    // Student accounts 01..12 map to the first twelve seeded registration numbers (programme rotates BCS,BIT,BBA,LLB,BED).
    const prog = ['BCS', 'BIT', 'BBA', 'LLB', 'BED'][i % 5]!;
    return { regNo: `2026-${prog}-${String(i + 1).padStart(4, '0')}`, email: `student${nn}@kiu-demo.test`, password: DEMO_PASSWORD };
  });

async function main() {
  const cmd = process.argv[2] ?? 'help';
  const api = new ApiClient(fetchTransport(arg('api', 'http://localhost:4000')!));
  if (cmd === 'help' || !['scenarios', 'demo'].includes(cmd)) {
    console.log('kiu-sim <scenarios|demo> [--api URL] [--admin-email E] [--admin-password P] [--mfa-code 123456]\n' +
      '  Needs a seeded API (SEED_DEMO_ACCOUNTS=true). The admin must hold cards.* and readers.* (super-admin@kiu-demo.test, MFA enrolled).');
    return;
  }
  const adminToken = await api.login(arg('admin-email', 'super-admin@kiu-demo.test')!, arg('admin-password', DEMO_PASSWORD)!, arg('mfa-code'));
  const ctx = { api, adminToken, students: demoStudents(4) };

  if (cmd === 'scenarios') {
    console.log('KIU-USCAS security scenarios (isolated simulator reader; real API, real database)\n');
    const results = await runScenarios(ctx, (r) => console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        expected: ${r.expected}\n        observed: ${r.observed}`));
    const failed = results.filter((r) => !r.passed).length;
    console.log(`\n${results.length - failed}/${results.length} behaved as expected`);
    process.exitCode = failed ? 1 : 0;
  } else {
    const { reader } = await createSimReader(ctx);
    const w = await freshWallet(ctx, ctx.students[0]!);
    console.log(`Card ${w.cardNumber} issued and activated for ${ctx.students[0]!.regNo}\n`);
    const qr = await reader.verify({ type: 'QR', token: w.qr() });
    console.log(`QR  -> ${qr.body.decision} ${qr.body.reason_code} (${qr.body.processing_ms} ms) ${qr.body.student?.full_name ?? ''}`);
    const t = await w.tap(reader);
    for (const e of t.events) console.log(`  [${e.step}] ${e.command ?? ''} -> ${e.response ?? ''}${e.ms !== undefined ? ` (${e.ms} ms)` : ''}`);
    if (t.ok) {
      const tap = await reader.verify(t.credential);
      console.log(`TAP -> ${tap.body.decision} ${tap.body.reason_code} (${tap.body.processing_ms} ms)`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
