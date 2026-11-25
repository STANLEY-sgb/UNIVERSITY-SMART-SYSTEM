import { expect, test } from '@playwright/test';
import { API, activateInWallet, bearer, issueCard, operatorToken, provisionReader, readerVerify, student, walletLogin, walletToken } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('student wallet (real browser, real API)', () => {
  test('signs in, sees an empty state, then activates a card issued by staff and shows a rotating QR', async ({ page, request }) => {
    const s = student(1);
    const op = await operatorToken(request);
    await walletLogin(page, s);

    await page.goto('http://localhost:3001/#/card');
    // No card yet (or an old one retired): wallet must explain what to do, not show a QR.
    await expect(page.getByTestId('idcard')).toHaveCount(0);

    const card = await issueCard(request, op, s.regNo);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Activate your card' })).toBeVisible();
    await expect(page.getByText(card.cardNumber).first()).toBeVisible();

    await activateInWallet(page, card.code);
    await expect(page.getByTestId('card-number')).toHaveText(card.cardNumber);
    await expect(page.getByTestId('qr-canvas')).toBeVisible();
    await expect(page.getByRole('timer')).toBeVisible();

    const first = await walletToken(page);
    expect(first).toMatch(/^KIU1\.[\w-]+\.[\w-]+$/);

    // The code rotates: coming back to the tab mints a fresh one with a new nonce and a higher counter.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => walletToken(page)).not.toBe(first);

    // The private key is non-extractable and only the public half ever went to the server.
    const stored = await page.evaluate(() => new Promise<{ extractable: boolean; type: string } | null>((resolve) => {
      const r = indexedDB.open('kiu-wallet', 1);
      r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('device'); g.onsuccess = () => resolve(g.result ? { extractable: g.result.privateKey.extractable, type: g.result.privateKey.algorithm.name } : null); };
    }));
    expect(stored).toEqual({ extractable: false, type: 'Ed25519' });
  });

  test('wrong activation code is refused with a clear message', async ({ page, request }) => {
    const s = student(2);
    const op = await operatorToken(request);
    await issueCard(request, op, s.regNo);
    await walletLogin(page, s);
    await page.goto('http://localhost:3001/#/card');
    await page.getByLabel('Activation code').fill('AAAA-BBBB-CCCC');
    await page.getByTestId('activate').click();
    await expect(page.getByRole('alert')).toContainText(/invalid or expired/i);
    await expect(page.getByTestId('idcard')).toHaveCount(0);
  });

  test('the QR the browser shows is accepted by a real reader, once', async ({ page, request }) => {
    const s = student(3);
    const op = await operatorToken(request);
    const reader = await provisionReader(request, op, 'GATE', 'GATE-MAIN');
    const card = await issueCard(request, op, s.regNo);
    await walletLogin(page, s);
    await activateInWallet(page, card.code);

    const token = await walletToken(page);
    const ok = await readerVerify(request, reader, token);
    expect(ok.body).toMatchObject({ decision: 'GRANT', student: { reg_no: s.regNo } });
    const replay = await readerVerify(request, reader, token);
    expect(replay.body).toMatchObject({ decision: 'DENY', reason_code: 'NONCE_REPLAY' });
  });

  test('My access explains every unmet condition and where to go (finance, registration)', async ({ page }) => {
    await walletLogin(page, student(10)); // seeded with 40% fees paid, exam not cleared
    await page.goto('http://localhost:3001/#/access');
    await expect(page.getByTestId('eligibility')).toBeVisible();
    await expect(page.getByTestId('svc-GATE')).toHaveAttribute('data-status', 'ELIGIBLE');
    const exam = page.getByTestId('svc-EXAM');
    await expect(exam).toHaveAttribute('data-status', 'NOT_ELIGIBLE'); // the seed always has an upcoming paper for this programme
    await expect(exam).toContainText(/Finance/);
    await expect(exam).toContainText('Finance Office'); // and says where to go
    // wording is words + a chip, never colour alone
    await expect(page.getByTestId('svc-GATE')).toContainText('Available');

    await page.context().clearCookies();
    await page.goto('about:blank'); // a hash-only navigation would not reload the SPA
    await walletLogin(page, student(7)); // seeded as not registered for the semester
    await page.goto('http://localhost:3001/#/access');
    await expect(page.getByTestId('svc-LAB')).toContainText(/Registry/);
    await expect(page.getByTestId('svc-LAB')).toHaveAttribute('data-status', 'NOT_ELIGIBLE');
  });

  test('history and notifications show only this student\'s own records', async ({ page, request }) => {
    const s = student(4);
    const op = await operatorToken(request);
    const reader = await provisionReader(request, op, 'GATE', 'GATE-MAIN');
    const card = await issueCard(request, op, s.regNo);
    await walletLogin(page, s);
    await activateInWallet(page, card.code);
    await readerVerify(request, reader, await walletToken(page));

    await page.goto('http://localhost:3001/#/history');
    await expect(page.getByTestId('history').getByText('GRANT').first()).toBeVisible();
    await expect(page.getByTestId('history')).not.toContainText(student(3).regNo);

    await page.goto('http://localhost:3001/#/notifications');
    await expect(page.getByText('New card issued')).toBeVisible();
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  });

  test('reporting the card lost disables it everywhere and the old QR is refused', async ({ page, request }) => {
    const s = student(5);
    const op = await operatorToken(request);
    const reader = await provisionReader(request, op, 'GATE', 'GATE-MAIN');
    const card = await issueCard(request, op, s.regNo);
    await walletLogin(page, s);
    await activateInWallet(page, card.code);
    const token = await walletToken(page);

    await page.goto('http://localhost:3001/#/account');
    await page.getByTestId('report-lost').click();
    await expect(page.getByTestId('confirm-lost')).toBeDisabled(); // needs a reason
    await page.getByLabel(/What happened/).fill('Phone stolen on the bus');
    await page.getByTestId('confirm-lost').click();
    await expect(page.getByText(/card was disabled/i)).toBeVisible();

    const res = await readerVerify(request, reader, token);
    expect(res.body).toMatchObject({ decision: 'DENY', reason_code: 'CARD_LOST' });
    await page.goto('http://localhost:3001/#/card');
    await expect(page.getByText(/can never be reactivated/i)).toBeVisible();
    expect(await (await request.get(`${API}/cards?regNo=${s.regNo}`, { headers: bearer(op) })).json()).toMatchObject({ data: [{ status: 'LOST' }] });
  });

  test('staff accounts cannot use the student wallet, and sign-out ends the session', async ({ page }) => {
    await page.goto('http://localhost:3001/#/');
    await page.getByLabel('University email').fill('e2e-operator@kiu-demo.test');
    await page.getByLabel('Password').fill('Demo-Password-2026!');
    await page.getByTestId('login').click();
    await expect(page.getByRole('alert')).toContainText(/for students/i);

    await walletLogin(page, student(6));
    await page.goto('http://localhost:3001/#/account');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('login')).toBeVisible(); // cookie session really gone, not just hidden
  });
});
