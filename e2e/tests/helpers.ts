import { createHmac, createHash, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

export const API = 'http://localhost:4000/api/v1';
export const WALLET = 'http://localhost:3001';
export const READER = 'http://localhost:3002';
export const PASSWORD = 'Demo-Password-2026!';
export const OPERATOR = { email: 'e2e-operator@kiu-demo.test', password: PASSWORD };

const PROGS = ['BCS', 'BIT', 'BBA', 'LLB', 'BED'];
/** Seeded demo student n (1..12): login email and registration number. */
export const student = (n: number) => ({
  n,
  email: `student${String(n).padStart(2, '0')}@kiu-demo.test`,
  regNo: `2026-${PROGS[(n - 1) % 5]}-${String(n).padStart(4, '0')}`,
  password: PASSWORD,
});

export async function operatorToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${API}/auth/login`, { headers: { 'X-Token-Delivery': 'body' }, data: OPERATOR });
  if (!r.ok()) throw new Error(`operator login failed: ${r.status()}`);
  return (await r.json()).accessToken;
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Retires any existing card for the student, then issues a fresh PENDING one through the real API. */
export async function issueCard(request: APIRequestContext, token: string, regNo: string) {
  const list = await (await request.get(`${API}/cards?regNo=${regNo}&pageSize=50`, { headers: bearer(token) })).json();
  for (const c of list.data) {
    if (['ACTIVE', 'BLOCKED', 'PENDING'].includes(c.status)) await request.post(`${API}/cards/${c.id}/report-lost`, { headers: bearer(token), data: { reason: 'e2e reset' } });
  }
  const r = await request.post(`${API}/cards`, { headers: bearer(token), data: { regNo } });
  if (r.status() !== 201) throw new Error(`issue failed ${r.status()} ${await r.text()}`);
  const b = await r.json();
  return { id: b.card.id as string, cardNumber: b.card.cardNumber as string, code: b.activationCode as string };
}

export interface ReaderCreds { id: string; code: string; keyId: string; secret: string }
export async function provisionReader(request: APIRequestContext, token: string, serviceCode: string, venueCode: string, supportsFace = false): Promise<ReaderCreds> {
  const code = `E2E-${randomBytes(3).toString('hex').toUpperCase()}`;
  const r = await request.post(`${API}/readers`, { headers: bearer(token), data: { code, name: `E2E ${serviceCode}`, serviceCode, venueCode, ...(supportsFace ? { supportsFace } : {}) } });
  if (r.status() !== 201) throw new Error(`reader provisioning failed ${r.status()} ${await r.text()}`);
  const b = await r.json();
  return { id: b.reader.id, code, keyId: b.credentials.keyId, secret: b.credentials.secret };
}

/** Signed reader call from Node (used to verify what the browser stored/uploaded). */
export async function readerVerify(request: APIRequestContext, c: ReaderCreds, token: string) {
  const url = '/api/v1/access/verify';
  const body = JSON.stringify({ credential: { type: 'QR', token } });
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', c.secret).update(['POST', url, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  const r = await request.post(`http://localhost:4000${url}`, { data: body, headers: { 'Content-Type': 'application/json', 'X-Reader-Key-Id': c.keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig } });
  return { status: r.status(), body: await r.json() };
}

export async function walletLogin(page: Page, s: { email: string; password: string }) {
  await page.goto(`${WALLET}/#/`);
  await page.getByLabel('University email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByTestId('login').click();
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
}

/** Activates the card in the browser and returns the freshly shown QR token text. */
export async function activateInWallet(page: Page, code: string) {
  await page.goto(`${WALLET}/#/card`);
  await page.getByLabel('Activation code').fill(code);
  await page.getByTestId('activate').click();
  await page.getByTestId('idcard').waitFor();
}

export const walletToken = (page: Page) => page.getByTestId('qr-token').textContent().then((t) => (t ?? '').trim());

export async function readerSetup(page: Page, c: ReaderCreds) {
  await page.goto(READER);
  await page.getByLabel('Server address').fill('http://localhost:4000');
  await page.getByLabel('Reader ID').fill(c.id);
  await page.getByLabel('Key ID').fill(c.keyId);
  await page.getByLabel('Secret').fill(c.secret);
  await page.getByTestId('connect').click();
  await page.getByTestId('reader-id').waitFor();
}

export async function scan(page: Page, token: string) {
  await page.getByTestId('manual-code').fill(token);
  await page.getByTestId('manual-verify').click();
}

/** Layout contract from DESIGN_SYSTEM.md: no horizontal page scroll, targets >= 44x44, nothing clipped off-screen. */
/** Waits for finite CSS animations (fade/scale-in) so measurements see the settled state. Infinite ones (loading shimmer) are ignored. */
export async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
    .map((a) => a.finished.catch(() => undefined))));
}

export async function layoutProblems(page: Page): Promise<string[]> {
  await settle(page);
  return page.evaluate(() => {
    const problems: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) problems.push(`horizontal overflow: scrollWidth ${de.scrollWidth} > ${de.clientWidth}`);
    const interactive = document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), select, textarea, [role=radio]');
    for (const el of interactive) {
      const hit = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') ?? el) : el;
      const r = hit.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.id ?? el.tagName).trim().slice(0, 30);
      if (r.height < 43.5) problems.push(`target too short (${Math.round(r.height)}px): ${label}`);
      if (r.right > window.innerWidth + 1 || r.left < -1) problems.push(`target off-screen: ${label}`);
      // inline links inside paragraphs are exempt from the 44px width rule; controls are not
      if (r.width < 43.5 && !(el.tagName === 'A' && el.closest('p'))) problems.push(`target too narrow (${Math.round(r.width)}px): ${label}`);
    }
    return problems;
  });
}

export async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')} — ${v.help}`);
}


export const ADMIN_URL = 'http://localhost:3000';
export const ADMIN_USER = { email: 'e2e-admin@kiu-demo.test', password: PASSWORD };

export async function adminUiLogin(page: Page, creds: { email: string; password: string } = ADMIN_USER) {
  await page.goto(ADMIN_URL + '/#/');
  await page.getByLabel('Staff email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByTestId('login').click();
  await page.getByTestId('whoami').waitFor();
}

export async function adminApiToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(API + '/auth/login', { headers: { 'X-Token-Delivery': 'body' }, data: ADMIN_USER });
  if (!r.ok()) throw new Error('admin login failed: ' + r.status());
  return (await r.json()).accessToken;
}

/** Puts a student into a card-less state (all live cards reported lost) so a UI flow can issue a fresh one. */
export async function retireCards(request: APIRequestContext, token: string, regNo: string) {
  const list = await (await request.get(API + '/cards?regNo=' + regNo + '&pageSize=50', { headers: bearer(token) })).json();
  for (const c of list.data) {
    if (['ACTIVE', 'BLOCKED', 'PENDING'].includes(c.status)) await request.post(API + '/cards/' + c.id + '/report-lost', { headers: bearer(token), data: { reason: 'e2e reset' } });
  }
}
