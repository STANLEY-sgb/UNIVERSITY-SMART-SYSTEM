import { expect, test, type Page } from '@playwright/test';
import { API, activateInWallet, bearer, issueCard, operatorToken, provisionReader, readerSetup, scan, student, walletLogin, walletToken, type ReaderCreds } from './helpers';

test.describe.configure({ mode: 'serial' });

/** Opens the wallet in its own browser context (a different "phone") and returns a function that mints fresh QR tokens. */
async function phone(browser: import('@playwright/test').Browser, request: import('@playwright/test').APIRequestContext, n: number) {
  const s = student(n);
  const op = await operatorToken(request);
  const card = await issueCard(request, op, s.regNo);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await walletLogin(page, s);
  await activateInWallet(page, card.code);
  const fresh = async () => {
    const before = await walletToken(page);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => walletToken(page)).not.toBe(before);
    return walletToken(page);
  };
  return { s, card, fresh, close: () => ctx.close() };
}

const result = (page: Page) => page.getByTestId('result');

test.describe('reader (real browser, real API)', () => {
  let creds: ReaderCreds;
  test.beforeAll(async ({ request }) => { creds = await provisionReader(request, await operatorToken(request), 'GATE', 'GATE-MAIN'); });

  test('onboarding rejects bad credentials, then connects, downloads and verifies the signed list', async ({ page }) => {
    await page.goto('http://localhost:3002');
    await page.getByLabel('Server address').fill('http://localhost:4000');
    await page.getByLabel('Reader ID').fill(creds.id);
    await page.getByLabel('Key ID').fill(creds.keyId);
    await page.getByLabel('Secret').fill('f'.repeat(64));
    await page.getByTestId('connect').click();
    await expect(page.getByRole('alert')).toContainText(/signature|credentials|refused/i);

    await readerSetup(page, creds);
    await expect(page.getByTestId('reader-id')).toContainText(`${creds.code} · GATE`);
    await expect(page.getByTestId('conn')).toHaveAttribute('data-online', 'true');
    await page.getByText('Diagnostics').click();
    await expect(page.getByTestId('diagnostics')).toContainText('CACHED_ALLOW');
    await expect(page.getByTestId('list-version')).not.toHaveText('—');

    // The secret must not be stored in readable form anywhere in the browser.
    const leaked = await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), creds.secret);
    expect(leaked).toBe(false);
  });

  test('GRANT: shows the student, opens the door for 3 s, records the event, offers sound-free feedback in words', async ({ page, browser, request }) => {
    const w = await phone(browser, request, 8);
    await readerSetup(page, creds);
    await scan(page, await w.fresh());

    await expect(result(page)).toHaveAttribute('data-decision', 'GRANT');
    await expect(page.getByTestId('result-name')).not.toBeEmpty();
    await expect(page.getByTestId('result-message')).toHaveText('Access granted.');
    await expect(page.locator('.kiu-door')).toHaveAttribute('data-open', 'true');
    await expect(page.locator('.kiu-door')).toHaveAttribute('data-open', 'false', { timeout: 6000 }); // closes after ~3 s
    await expect(page.getByTestId('events').getByText('GRANT')).toHaveCount(1);
    await expect(page.getByTestId('latency')).toContainText(/Decision in \d+ ms/);
    await w.close();
  });

  test('DENY: replayed code, tampered code and garbage are refused with the exact reason; the door stays locked', async ({ page, browser, request }) => {
    const w = await phone(browser, request, 9);
    await readerSetup(page, creds);
    const token = await w.fresh();
    await scan(page, token);
    await expect(result(page)).toHaveAttribute('data-decision', 'GRANT');

    await page.waitForTimeout(5300); // the reader ignores an identical code scanned within 5 s (camera double-reads)
    await scan(page, token);
    await expect(result(page)).toHaveAttribute('data-reason', 'NONCE_REPLAY');
    await expect(result(page)).toHaveAttribute('data-decision', 'DENY');
    await expect(page.locator('.kiu-door')).toHaveAttribute('data-open', 'false');

    const [p, pl, sig] = (await w.fresh()).split('.');
    await scan(page, `${p}.${pl}.${sig!.slice(0, -4)}AAAA`);
    await expect(result(page)).toHaveAttribute('data-reason', 'CREDENTIAL_INVALID');

    await scan(page, 'not-a-kiu-code');
    await expect(result(page)).toHaveAttribute('data-reason', 'CREDENTIAL_INVALID');
    await w.close();
  });

  test('duplicate scans of the same code within 5 s produce one event (camera double-read protection)', async ({ page, browser, request }) => {
    const w = await phone(browser, request, 11);
    await readerSetup(page, creds);
    const token = await w.fresh();
    await scan(page, token);
    await expect(result(page)).toHaveAttribute('data-decision', 'GRANT');
    await scan(page, token);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('events').locator('tbody tr')).toHaveCount(1);
    await w.close();
  });

  test('TC-07 in the browser: network drops -> local signed-list decision -> queued -> reconnect -> reconciled', async ({ page, context, browser, request }) => {
    const w = await phone(browser, request, 12);
    const op = await operatorToken(request);
    await readerSetup(page, creds);
    await page.getByText('Diagnostics').click();
    await page.getByTestId('sync').click(); // make sure the list includes the newly activated card
    await expect(page.getByTestId('list-cards')).not.toHaveText('—');

    const token = await w.fresh();
    await context.setOffline(true); // real network emulation: every fetch now fails
    await scan(page, token);

    await expect(result(page)).toHaveAttribute('data-decision', 'GRANT');
    await expect(page.getByText('Decided offline')).toBeVisible();
    await expect(page.getByTestId('conn')).toHaveAttribute('data-online', 'false');
    await expect(page.getByTestId('queue')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('latency')).toContainText('(local)');

    // Offline, the same code is refused locally (nonce store lives in IndexedDB).
    await page.waitForTimeout(5300);
    await scan(page, token);
    await expect(result(page)).toHaveAttribute('data-reason', 'NONCE_REPLAY');

    // A malformed/unknown credential offline is refused, never granted.
    await scan(page, 'KIU1.bogus.bogus');
    await expect(result(page)).toHaveAttribute('data-decision', 'DENY');

    await context.setOffline(false);
    await page.getByTestId('sync').click();
    await expect(page.getByTestId('queue')).toHaveAttribute('data-count', '0', { timeout: 15_000 });
    await expect(page.getByTestId('conn')).toHaveAttribute('data-online', 'true');

    // The server now has the offline records, flagged as offline, attached to the right student.
    const logs = await (await request.get(`${API}/logs?regNo=${student(12).regNo}&pageSize=20`, { headers: bearer(op) })).json();
    const offlineRows = logs.data.filter((l: { offline: boolean }) => l.offline);
    expect(offlineRows.length).toBeGreaterThanOrEqual(2);
    expect(offlineRows.map((l: { decision: string }) => l.decision)).toEqual(expect.arrayContaining(['GRANT', 'DENY']));
    await w.close();
  });

  test('the queued records survive a page reload while offline (IndexedDB, not memory)', async ({ page, context, browser, request }) => {
    const w = await phone(browser, request, 6);
    await readerSetup(page, creds);
    await page.reload(); // let the service worker take control and cache the app shell
    await page.waitForFunction(async () => { const c = await caches.open('kiu-reader-shell-v1'); return (await c.keys()).length >= 4; }, undefined, { timeout: 20_000 });
    await page.getByText('Diagnostics').click();
    await page.getByTestId('sync').click();
    const token = await w.fresh();
    await context.setOffline(true);
    await scan(page, token);
    await expect(page.getByTestId('queue')).toHaveAttribute('data-count', '1');
    await page.goto('http://localhost:3002'); // service worker / cache serves the shell while offline
    await expect(page.getByTestId('queue')).toHaveAttribute('data-count', '1');
    await context.setOffline(false);
    await w.close();
  });

  test('a revoked reader is refused by the server and the screen says so (no offline fallback for a refusal)', async ({ page, browser, request }) => {
    const op = await operatorToken(request);
    const own = await provisionReader(request, op, 'GATE', 'GATE-MAIN');
    const w = await phone(browser, request, 6);
    await readerSetup(page, own);
    await request.patch(`${API}/readers/${own.id}/status`, { headers: bearer(op), data: { status: 'REVOKED', reason: 'e2e: device stolen' } });
    await scan(page, await w.fresh());
    await expect(result(page)).toHaveAttribute('data-decision', 'DENY');
    await expect(result(page)).toHaveAttribute('data-reason', 'READER_REVOKED');
    await expect(page.getByText('Decided offline')).toHaveCount(0);
    await w.close();
  });

  test('exam readers fail closed offline (DENY_ALL policy), even for an eligible student', async ({ page, context, browser, request }) => {
    const op = await operatorToken(request);
    const exam = await provisionReader(request, op, 'EXAM', 'EXH-A');
    const w = await phone(browser, request, 8);
    await readerSetup(page, exam);
    const token = await w.fresh();
    await context.setOffline(true);
    await scan(page, token);
    await expect(result(page)).toHaveAttribute('data-decision', 'DENY');
    await expect(result(page)).toHaveAttribute('data-reason', 'OFFLINE_NOT_PERMITTED');
    await context.setOffline(false);
    await w.close();
  });

  test('VIRTUAL TAP is disabled with an explanation; SCAN FACE is available but labelled as an optional prototype, and denied camera access degrades gracefully', async ({ page }) => {
    await readerSetup(page, creds);
    await expect(page.getByRole('radio', { name: 'SCAN QR' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'VIRTUAL TAP' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'SCAN FACE' })).toBeEnabled();
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    await page.reload();
    await page.getByRole('radio', { name: 'SCAN FACE' }).click();
    await expect(page.getByTestId('face-scan')).toContainText(/prototype/i);
    await expect(page.getByTestId('face-capture')).toHaveAttribute('data-camera', 'blocked');
    await expect(page.getByTestId('face-verify')).toBeDisabled();
    await expect(page.getByText(/use the card \/ QR code instead/i)).toBeVisible();
  });

  test('camera permission denied is handled gracefully; the manual field still works', async ({ page }) => {
    await readerSetup(page, creds);
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    await page.reload();
    await page.getByTestId('start-camera').click();
    await expect(page.getByText(/Camera access was blocked|Camera permission denied/).first()).toBeVisible();
    await expect(page.getByTestId('manual-code')).toBeEnabled();
  });
});
