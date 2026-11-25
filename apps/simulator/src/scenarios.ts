import { randomBytes } from 'node:crypto';
import { VirtualCard, generateQrKeyPair } from '@kiu/vcard';
import { ApiClient, ApiResponse, ReaderClient } from './api';
import { SimWallet } from './wallet';

export interface StudentLogin { regNo: string; email: string; password: string }
export interface ScenarioContext {
  api: ApiClient;
  /** A staff token holding cards.* and readers.* permissions (Super Admin). */
  adminToken: string;
  /** Student accounts to use (each scenario group takes one). Their current cards are retired first. */
  students: StudentLogin[];
}
export interface ScenarioResult { id: string; title: string; expected: string; observed: string; passed: boolean }

const brief = (r: ApiResponse) => (r.body?.decision ? `${r.body.decision}/${r.body.reason_code}` : `HTTP ${r.status}/${r.body?.code ?? r.body?.reason_code ?? ''}`);

/** A throw-away GATE reader, so the scenarios never touch production readers or credentials. */
export async function createSimReader(ctx: ScenarioContext): Promise<{ reader: ReaderClient; id: string }> {
  const code = `SIM-${randomBytes(4).toString('hex').toUpperCase()}`;
  const r = await ctx.api.call('POST', '/readers', { code, name: 'Simulator gate', serviceCode: 'GATE', venueCode: 'GATE-MAIN' }, ctx.adminToken);
  if (r.status !== 201) throw new Error(`could not create simulator reader: ${r.status} ${r.body?.code}`);
  return { reader: new ReaderClient(ctx.api, r.body.credentials), id: r.body.reader.id };
}

/** Real issuance + activation flow for a student; retires any card they already hold (lost-card path). */
export async function freshWallet(ctx: ScenarioContext, s: StudentLogin): Promise<SimWallet> {
  const token = await ctx.api.login(s.email, s.password);
  const existing = await ctx.api.call('GET', `/cards?regNo=${encodeURIComponent(s.regNo)}&pageSize=50`, undefined, ctx.adminToken);
  for (const c of existing.body.data ?? []) {
    if (['ACTIVE', 'BLOCKED', 'PENDING'].includes(c.status)) await ctx.api.call('POST', `/cards/${c.id}/report-lost`, { reason: 'Simulator reset' }, ctx.adminToken);
  }
  const issued = await ctx.api.call('POST', '/cards', { regNo: s.regNo }, ctx.adminToken);
  if (issued.status !== 201) throw new Error(`issue failed for ${s.regNo}: ${issued.status} ${issued.body?.code}`);
  return SimWallet.activate(ctx.api, token, issued.body.activationCode, issued.body.card.cardNumber, issued.body.card.id);
}

type Check = (observed: string) => boolean;
const is = (...ok: string[]): Check => (o) => ok.includes(o);

export async function runScenarios(ctx: ScenarioContext, onResult?: (r: ScenarioResult) => void): Promise<ScenarioResult[]> {
  if (ctx.students.length < 4) throw new Error('need at least 4 student accounts for the scenarios');
  const results: ScenarioResult[] = [];
  const record = async (id: string, title: string, expected: string, check: Check, fn: () => Promise<string>) => {
    let observed: string;
    try { observed = await fn(); } catch (e) { observed = `ERROR ${(e as Error).message}`; }
    const r = { id, title, expected, observed, passed: check(observed) };
    results.push(r);
    onResult?.(r);
  };

  const { reader } = await createSimReader(ctx);
  const [sMain, sBlocked, sLost, sCounter] = ctx.students as [StudentLogin, StudentLogin, StudentLogin, StudentLogin];
  const w = await freshWallet(ctx, sMain);

  // ── baselines: the legitimate paths must work, or the rejections below prove nothing ──
  await record('BASE-QR', 'Legitimate rotating QR', 'GRANT/OK', is('GRANT/OK'), async () => brief(await reader.verify({ type: 'QR', token: w.qr() })));
  await record('BASE-TAP', 'Legitimate AES tap (mutual auth + protected read)', 'GRANT/OK', is('GRANT/OK'), async () => {
    const t = await w.tap(reader);
    return t.ok ? brief(await reader.verify(t.credential)) : `FAILED at ${t.stage}`;
  });

  // ── attacks ──
  await record('ATK-01', 'Copied card UID, random key', 'rejected at auth', is('rejected at auth'), async () => {
    const clone = new VirtualCard(w.card.uidHex, randomBytes(16), w.cardNumber);
    const t = await w.tap(reader, clone);
    return t.ok ? 'ACCEPTED' : `rejected at ${t.stage}`;
  });
  await record('ATK-02', 'Wrong AES authentication key (one bit off)', 'rejected at auth', is('rejected at auth'), async () => {
    const k = Buffer.from(w.aesKeyHex, 'hex'); k[0] = k[0]! ^ 1;
    const t = await w.tap(reader, new VirtualCard(w.card.uidHex, k, w.cardNumber));
    return t.ok ? 'ACCEPTED' : `rejected at ${t.stage}`;
  });
  await record('ATK-03', 'Replayed QR token', 'DENY/NONCE_REPLAY', is('DENY/NONCE_REPLAY'), async () => {
    const qr = w.qr();
    await reader.verify({ type: 'QR', token: qr });
    return brief(await reader.verify({ type: 'QR', token: qr }));
  });
  await record('ATK-04', 'Expired QR token', 'DENY/CREDENTIAL_EXPIRED', is('DENY/CREDENTIAL_EXPIRED'), async () =>
    brief(await reader.verify({ type: 'QR', token: w.qr({ nowSeconds: Math.floor(Date.now() / 1000) - 120 }) })));
  await record('ATK-05', 'Modified QR payload (extended expiry)', 'DENY/CREDENTIAL_INVALID', is('DENY/CREDENTIAL_INVALID'), async () => {
    const [p, pl, sig] = w.qr().split('.') as [string, string, string];
    const body = JSON.parse(Buffer.from(pl, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...body, exp: body.exp + 3600 })).toString('base64url');
    return brief(await reader.verify({ type: 'QR', token: `${p}.${forged}.${sig}` }));
  });
  await record('ATK-06', 'QR signed with an attacker key', 'DENY/CREDENTIAL_INVALID', is('DENY/CREDENTIAL_INVALID'), async () =>
    brief(await reader.verify({ type: 'QR', token: w.qr({ keyHex: generateQrKeyPair().privateKeyHex }) })));
  await record('ATK-07', 'Reused request nonce (captured request replayed)', 'HTTP 409/NONCE_REPLAY', is('HTTP 409/NONCE_REPLAY'), async () => {
    const o = { nonce: randomBytes(16).toString('hex'), timestamp: String(Math.floor(Date.now() / 1000)) };
    const qr = w.qr();
    await reader.verify({ type: 'QR', token: qr }, {}, o);
    return brief(await reader.verify({ type: 'QR', token: qr }, {}, o));
  });
  await record('ATK-08', 'Replayed AES tap read (spent session)', 'DENY/NONCE_REPLAY', is('DENY/NONCE_REPLAY'), async () => {
    const t = await w.tap(reader);
    if (!t.ok) return `FAILED at ${t.stage}`;
    await reader.verify(t.credential);
    return brief(await reader.verify(t.credential));
  });
  await record('ATK-09', 'Revoked reader', 'HTTP 403/READER_REVOKED', is('HTTP 403/READER_REVOKED'), async () => {
    const other = await createSimReader(ctx);
    await ctx.api.call('PATCH', `/readers/${other.id}/status`, { status: 'REVOKED', reason: 'Simulator: revoked reader scenario' }, ctx.adminToken);
    return brief(await other.reader.verify({ type: 'QR', token: w.qr() }));
  });

  // ── scenarios that change card state use their own students/wallets ──
  const wb = await freshWallet(ctx, sBlocked);
  await record('ATK-10', 'Blocked card', 'DENY/CARD_BLOCKED', is('DENY/CARD_BLOCKED'), async () => {
    await ctx.api.call('POST', `/cards/${wb.cardId}/block`, { reason: 'Simulator: blocked card scenario' }, ctx.adminToken);
    return brief(await reader.verify({ type: 'QR', token: wb.qr() }));
  });
  const wl = await freshWallet(ctx, sLost);
  await record('ATK-11', 'Lost card (old credential after replacement)', 'DENY/CARD_LOST then GRANT/OK', is('DENY/CARD_LOST then GRANT/OK'), async () => {
    await ctx.api.call('POST', `/cards/${wl.cardId}/report-lost`, { reason: 'Simulator: lost card scenario' }, ctx.adminToken);
    const oldQr = brief(await reader.verify({ type: 'QR', token: wl.qr() }));
    const oldTap = await wl.tap(reader);
    const fresh = await freshWallet(ctx, sLost);
    const newQr = brief(await reader.verify({ type: 'QR', token: fresh.qr() }));
    // The old AES key still authenticates cryptographically, but the pipeline must deny it afterwards.
    const tapAfter = oldTap.ok ? brief(await reader.verify(oldTap.credential)) : `rejected at ${oldTap.stage}`;
    return oldQr === 'DENY/CARD_LOST' && tapAfter === 'DENY/CARD_LOST' ? `${oldQr} then ${newQr}` : `old QR ${oldQr}, old tap ${tapAfter}, new ${newQr}`;
  });
  const wc = await freshWallet(ctx, sCounter);
  await record('ATK-12', 'Invalid (regressed) transaction counter', 'DENY/COUNTER_INVALID', is('DENY/COUNTER_INVALID'), async () => {
    await reader.verify({ type: 'QR', token: wc.qr({ counter: 50 }) });
    return brief(await reader.verify({ type: 'QR', token: wc.qr({ counter: 49 }) }));
  });
  
  return results;
}
