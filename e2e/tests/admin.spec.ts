import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ADMIN_URL, API, PASSWORD, activateInWallet, adminApiToken, adminUiLogin, bearer, operatorToken, provisionReader, readerVerify,
  retireCards, student, walletLogin, walletToken,
} from './helpers';

const { authenticator } = createRequire(path.resolve(__dirname, '../../apps/api/package.json'))('otplib') as typeof import('otplib');

test.describe.configure({ mode: 'serial' });

const reasonDialog = async (page: Page, reason: string) => {
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel(/Reason/).fill(reason);
  await dlg.getByTestId('reason-confirm').click();
  await expect(dlg).toHaveCount(0);
};

test.describe('admin console (real browser, real API)', () => {
  test('overview is driven by live data and refreshes after real decisions', async ({ page, request }) => {
    const op = await operatorToken(request);
    await adminUiLogin(page);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    const num = async (id: string) => Number((await page.getByTestId(`stat-${id}`).locator('.n').textContent()) ?? 'NaN');
    expect(await num('students')).toBeGreaterThanOrEqual(12);
    const grantsBefore = await num('grants');

    // Make a real GRANT happen through the real pipeline, then watch the console pick it up (it polls every 10 s).
    const s = student(1);
    const reader = await provisionReader(request, op, 'GATE', 'GATE-MAIN');
    const card = await (await import('./helpers')).issueCard(request, op, s.regNo);
    const phone = await page.context().browser()!.newContext();
    const wp = await phone.newPage();
    await walletLogin(wp, s);
    await activateInWallet(wp, card.code);
    expect((await readerVerify(request, reader, await walletToken(wp))).body.decision).toBe('GRANT');
    await phone.close();

    await expect.poll(() => num('grants'), { timeout: 20_000 }).toBeGreaterThan(grantsBefore);
    await expect(page.getByTestId('recent-decisions')).toContainText('GRANT');
    await expect(page.getByTestId('by-service')).toContainText('Campus Gate');
    await expect(page.getByTestId('recent-actions')).toContainText('cards.issue');
  });

  test('navigation is role-aware, and a page the role lacks is refused gracefully', async ({ page }) => {
    await adminUiLogin(page, { email: 'management@kiu-demo.test', password: PASSWORD });
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const visible of ['Overview', 'Access logs', 'Alerts', 'Audit trail']) await expect(nav.getByRole('link', { name: visible })).toBeVisible();
    for (const hidden of ['Students', 'Cards', 'Readers', 'Rules', 'Staff & roles']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    await page.goto(`${ADMIN_URL}/#/students`);
    await expect(page.getByText(/do not have access to that page/i)).toBeVisible();

    // Management can read alerts but has no acknowledge button (alerts.manage is missing).
    await page.goto(`${ADMIN_URL}/#/alerts`);
    await expect(page.getByRole('heading', { name: 'Security alerts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  });

  test('MFA: an un-enrolled super admin is forced to enrol, then needs a code to sign in', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/#/`);
    await page.getByLabel('Staff email').fill('super-admin@kiu-demo.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByTestId('login').click();

    await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0); // nothing else is reachable yet
    const secret = ((await page.getByTestId('mfa-secret').textContent()) ?? '').trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    await page.getByLabel('6-digit code').fill('000000');
    await page.getByTestId('mfa-enable').click();
    await expect(page.getByRole('alert')).toBeVisible(); // wrong code refused

    await page.getByLabel('6-digit code').fill(authenticator.generate(secret));
    await page.getByTestId('mfa-enable').click();
    await expect(page.getByTestId('secret-recovery-codes')).toContainText(/[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
    await page.getByTestId('secret-done').click();
    await page.getByTestId('whoami').waitFor();
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Staff & roles' })).toBeVisible();

    await page.getByTestId('signout').click();
    await page.getByLabel('Staff email').fill('super-admin@kiu-demo.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByTestId('login').click();
    await page.getByLabel(/Authenticator or recovery code/).fill(authenticator.generate(secret));
    await page.getByTestId('login').click();
    await page.getByTestId('whoami').waitFor();
  });

  test('journey: issue in the console -> activate in the wallet -> reader GRANT -> block -> unblock -> lost -> alert -> acknowledge -> audit', async ({ page, browser, request }) => {
    const s = student(9);
    const admin = await adminApiToken(request);
    const op = await operatorToken(request);
    await retireCards(request, admin, s.regNo);
    const reader = await provisionReader(request, op, 'GATE', 'GATE-MAIN');

    // 1. Issue from the student's record.
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/students`);
    await page.getByLabel('Search name or registration no.').fill(s.regNo);
    await page.getByTestId('students').getByText(s.regNo).first().click();
    await expect(page.getByTestId('student-detail')).toContainText(s.regNo);
    await expect(page.getByTestId('facts')).toBeVisible();
    await page.getByTestId('issue-card').click();
    const code = ((await page.getByTestId('secret-activation-code').textContent()) ?? '').trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.getByTestId('secret-done').click();
    await page.keyboard.press('Escape');

    // 2. The student activates it in the wallet (a different browser context = another phone).
    const ctx = await browser.newContext();
    const wp = await ctx.newPage();
    await walletLogin(wp, s);
    await activateInWallet(wp, code);
    const cardNumber = ((await wp.getByTestId('card-number').textContent()) ?? '').trim();
    expect((await readerVerify(request, reader, await walletToken(wp))).body.decision).toBe('GRANT');

    // 3. Block it from the Cards page: reason required, reader refuses, then unblock restores.
    await page.goto(`${ADMIN_URL}/#/cards`);
    await page.getByLabel('Search card number or name').fill(cardNumber);
    await page.getByTestId(`block-${cardNumber}`).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('reason-confirm')).toBeDisabled();
    await dlg.getByLabel(/Reason/).fill('Suspected misuse');
    await dlg.getByTestId('reason-confirm').click();
    await expect(page.getByTestId('cards')).toContainText('BLOCKED');
    await wp.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(async () => (await readerVerify(request, reader, await walletToken(wp))).body.reason_code, { timeout: 15_000 }).toBe('CARD_BLOCKED');

    await page.getByRole('button', { name: 'Unblock' }).click();
    await reasonDialog(page, 'Cleared by the dean');
    await expect(page.getByTestId('cards')).toContainText('ACTIVE');
    await wp.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(async () => (await readerVerify(request, reader, await walletToken(wp))).body.decision, { timeout: 15_000 }).toBe('GRANT');

    // 4. Report lost: final. The old phone is refused and an alert is raised.
    await page.getByTestId(`lost-${cardNumber}`).click();
    await reasonDialog(page, 'Student reported the phone stolen');
    await expect(page.getByTestId('cards')).toContainText('LOST');
    await expect(page.getByRole('button', { name: 'Unblock' })).toHaveCount(0); // LOST is final: no way back in the UI
    await wp.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const denied = await readerVerify(request, reader, await walletToken(wp));
    expect(denied.body).toMatchObject({ decision: 'DENY', reason_code: 'CARD_LOST' });
    await ctx.close();

    // 5. Alerts: the lost-card presentation is listed and can be acknowledged with a note.
    await page.goto(`${ADMIN_URL}/#/alerts`);
    const row = page.getByTestId('alerts').locator('tr', { hasText: s.regNo }).filter({ hasText: 'LOST_CARD_PRESENTED' });
    await expect(row.first()).toBeVisible();
    await row.first().getByRole('button', { name: 'Acknowledge' }).click();
    await reasonDialog(page, 'Student contacted, replacement ordered');
    await expect(page.getByTestId('alerts').locator('tr', { hasText: s.regNo }).filter({ hasText: 'LOST_CARD_PRESENTED' })).toHaveCount(0);

    // 6. Audit: every step above is recorded, and the hash chain verifies.
    await page.goto(`${ADMIN_URL}/#/audit`);
    for (const action of ['cards.issue', 'cards.block', 'cards.unblock', 'cards.report_lost', 'alerts.acknowledged']) {
      await page.getByLabel('Action starts with').fill(action);
      await expect(page.getByTestId('audit')).toContainText(action);
    }
    await page.getByTestId('verify-chain').click();
    await expect(page.getByTestId('verify-result')).toContainText(/Hash chain intact/);
  });

  test('readers: provision shows the secret once and it works; rotation and revocation take effect at once', async ({ page, request }) => {
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/readers`);
    await page.getByTestId('new-reader').click();
    const code = `UI-${Date.now().toString(36).toUpperCase()}`.slice(0, 12);
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Reader code').fill(code);
    await dlg.getByLabel('Display name').fill('UI-provisioned gate');
    await dlg.getByLabel('Service').selectOption({ label: 'Campus Gate' });
    await dlg.getByLabel('Venue').selectOption({ label: 'Main Gate' });
    await dlg.getByTestId('reader-create').click();

    const read = async (id: string) => ((await page.getByTestId(`secret-${id}`).textContent()) ?? '').trim();
    const creds = { id: await read('reader-id'), code, keyId: await read('key-id'), secret: await read('secret') };
    expect(creds.secret).toMatch(/^[0-9a-f]{64}$/);
    await page.getByTestId('secret-done').click();
    await expect(page.getByTestId('readers')).toContainText(code);

    // The credentials the console showed really authenticate against the API...
    const ping = async () => request.post(`http://localhost:4000/api/v1/readers/heartbeat`, { data: '{}', headers: await signed(creds, '{}') });
    expect((await ping()).status()).toBe(200);

    // ...rotate: the old secret dies immediately and the new one is shown once.
    await page.getByTestId(`rotate-${code}`).click();
    const next = { ...creds, keyId: await read('key-id'), secret: await read('secret') };
    await page.getByTestId('secret-done').click();
    expect(next.keyId).not.toBe(creds.keyId);
    expect((await ping()).status()).toBe(403);
    const pingNew = async () => request.post(`http://localhost:4000/api/v1/readers/heartbeat`, { data: '{}', headers: await signed(next, '{}') });
    expect((await pingNew()).status()).toBe(200);
    await expect(page.getByTestId('readers').locator('tr', { hasText: code })).toContainText('Online');

    // ...revoke: permanent, and the UI offers no way back.
    await page.getByTestId(`revoke-${code}`).click();
    await reasonDialog(page, 'Device stolen from the gate');
    await expect(page.getByTestId('readers').locator('tr', { hasText: code })).toContainText('REVOKED');
    expect((await pingNew()).status()).toBe(403);
    await expect(page.getByTestId(`rotate-${code}`)).toHaveCount(0);
  });

  test('rules: invalid rules are rejected with precise errors; test, publish and roll back change live decisions', async ({ page, request }) => {
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/rules`);
    await page.getByTestId('edit-SPORTS').click();
    const editor = page.getByTestId('rule-editor');
    const box = editor.getByLabel(/^Definition/);
    await expect(box).toHaveValue(/"schemaVersion": 1/);

    // Broken JSON and a dangerous-looking definition are both refused, with reasons.
    await box.fill('{ not json');
    await editor.getByTestId('rule-save').click();
    await expect(editor.getByTestId('rule-errors')).toContainText(/Not valid JSON/);
    await box.fill(JSON.stringify({ schemaVersion: 1, requirements: { fact: 'x', op: 'eval', value: 'process.exit()', reason: 'X', message: 'm' } }));
    await editor.getByTestId('rule-save').click();
    await expect(editor.getByTestId('rule-errors')).not.toBeEmpty();

    // A valid stricter rule: also require semester registration.
    await page.reload(); // discard the invalid text typed above
    await page.getByTestId('edit-SPORTS').click();
    await expect(page.getByTestId('rule-editor').getByLabel(/^Definition/)).toHaveValue(/"schemaVersion"/); // wait for the rule to load
    const live = JSON.parse(await page.getByTestId('rule-editor').getByLabel(/^Definition/).inputValue());
    live.requirements.all.push({ fact: 'semester_registered', op: 'eq', value: true, reason: 'NOT_REGISTERED', message: 'Register for the semester to use sports facilities.' });
    const ed = page.getByTestId('rule-editor');
    await ed.getByLabel(/^Definition/).fill(JSON.stringify(live, null, 2));
    await ed.getByLabel('Change note').fill('Sports facilities require registration');

    // Dry-run against the real students before publishing: #7 is unregistered, #8 is registered.
    await ed.getByLabel('Registration number').fill(student(7).regNo);
    await ed.getByTestId('rule-test').click();
    await expect(ed.getByTestId('test-result')).toContainText('Would DENY');
    await expect(ed.getByTestId('test-result')).toContainText('NOT_REGISTERED');
    await ed.getByLabel('Registration number').fill(student(8).regNo);
    await ed.getByTestId('rule-test').click();
    await expect(ed.getByTestId('test-result')).toContainText('Would GRANT');

    await ed.getByTestId('rule-save').click();
    await expect(ed.getByTestId('rule-msg')).toContainText(/Draft v2 saved/);
    await ed.getByTestId('rule-publish').click();
    await expect(ed.getByTestId('rule-msg')).toContainText(/Version 2 is now live/);
    await expect(ed.getByTestId('rule-history')).toContainText('PUBLISHED');

    // Roll back to v1 (reason required): a new live version restores the original behaviour.
    await ed.getByTestId('rollback-1').click();
    await reasonDialog(page, 'Registration is not required for sports');
    await expect(ed.getByTestId('rule-msg')).toContainText(/Rolled back/);
    const admin = await adminApiToken(request);
    const hist = await (await request.get(`${API}/services/SPORTS/rule/history`, { headers: bearer(admin) })).json();
    expect(hist.map((v: { status: string }) => v.status)).toEqual(['PUBLISHED', 'ARCHIVED', 'ARCHIVED']);
  });

  test('access logs filter by result and registration number', async ({ page }) => {
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/logs`);
    await expect(page.getByTestId('logs')).toContainText('GRANT');
    await page.getByLabel('Result').selectOption('DENY');
    await expect(page.getByTestId('logs').locator('tbody tr').first()).toContainText('DENY');
    await expect(page.getByTestId('logs')).not.toContainText('GRANT');
    await page.getByLabel('Registration no.').fill(student(9).regNo);
    await expect(page.getByTestId('logs')).toContainText(student(9).regNo);
  });

  test('users: add a staff member, then suspend them: their sessions end and sign-in is refused', async ({ page, request }) => {
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/users`);
    await page.getByTestId('new-user').click();
    const email = `ui.librarian.${Date.now().toString(36)}@kiu-demo.test`;
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Email').fill(email);
    await dlg.getByLabel('Full name').fill('Ui Librarian');
    await dlg.getByLabel('Temporary password').fill('Welcome-Aboard-2026!');
    await dlg.getByRole('checkbox', { name: /Librarian/ }).check();
    await expect(dlg.getByRole('checkbox', { name: /Super Administrator/ })).toHaveCount(0); // a non-super-admin is never offered that role
    await dlg.getByTestId('user-create').click();
    await expect(page.getByTestId('users')).toContainText(email);

    const login = () => request.post(`${API}/auth/login`, { data: { email, password: 'Welcome-Aboard-2026!' }, headers: { 'X-Token-Delivery': 'body' } });
    const first = await login();
    expect(first.status()).toBe(200);
    const token = (await first.json()).accessToken;

    await page.getByTestId('users').locator('tr', { hasText: email }).getByRole('button', { name: 'Suspend' }).click();
    await reasonDialog(page, 'Left the university');
    await expect(page.getByTestId('users').locator('tr', { hasText: email })).toContainText('SUSPENDED');
    expect((await request.get(`${API}/auth/me`, { headers: bearer(token) })).status()).toBe(401); // live session killed immediately
    expect((await login()).status()).toBe(401);
  });

  test('sign-out really ends the session', async ({ page }) => {
    await adminUiLogin(page);
    await page.getByTestId('signout').click();
    await expect(page.getByTestId('login')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('login')).toBeVisible();
  });
});

/** HMAC headers for a reader call made from Node (mirrors @kiu/security). */
async function signed(c: { keyId: string; secret: string }, body: string) {
  const { createHash, createHmac, randomBytes } = await import('node:crypto');
  const url = '/api/v1/readers/heartbeat';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', c.secret).update(['POST', url, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Reader-Key-Id': c.keyId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig };
}
