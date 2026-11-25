import { expect, test, type BrowserContext } from '@playwright/test';
import { API, PASSWORD, WALLET, adminApiToken, adminUiLogin, bearer, provisionReader, readerSetup, student, walletLogin } from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * The browser has no real camera in CI, so getUserMedia is replaced by an animated <canvas> stream that draws a
 * synthetic "person" (variant A or B, switchable at runtime) with natural lighting flicker. Everything downstream
 * (frame capture, 24x24 thumbnails, signed requests, matching, audit) is the real code path.
 */
async function fakeCamera(context: BrowserContext) {
  await context.addInitScript(() => {
    (window as unknown as { __face: string }).__face = 'A';
    const make = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 320;
      const g = c.getContext('2d')!;
      let t = 0;
      const draw = () => {
        t++;
        const v = (window as unknown as { __face: string }).__face;
        const flick = Math.sin(t / 3) * 6, dx = Math.sin(t / 5) * 2, dy = Math.cos(t / 7) * 2;
        g.fillStyle = v === 'A' ? `rgb(${200 + flick},${200 + flick},${205 + flick})` : `rgb(${40 + flick},${44 + flick},${60 + flick})`;
        g.fillRect(0, 0, 320, 320);
        g.save(); g.translate(dx, dy);
        g.fillStyle = v === 'A' ? '#d9a066' : '#f1d3b0';
        g.beginPath(); g.ellipse(160, 165, 92, 120, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = v === 'A' ? '#2b1a10' : '#c9c9c9';
        g.beginPath(); g.ellipse(160, 80, 100, 52, 0, Math.PI, Math.PI * 2); g.fill();
        g.fillStyle = '#111';
        if (v === 'A') { g.beginPath(); g.arc(125, 150, 11, 0, 7); g.arc(195, 150, 11, 0, 7); g.fill(); g.fillRect(135, 225, 50, 8); }
        else { g.fillRect(100, 168, 120, 14); g.fillRect(120, 205, 80, 30); g.fillRect(150, 140, 20, 40); }
        g.restore();
      };
      setInterval(draw, 33); draw();
      return c.captureStream(30);
    };
    navigator.mediaDevices.getUserMedia = async () => make();
  });
}

test.describe('face verification end to end (real browser, real API, prototype adapter)', () => {
  test('demo 7: consent-based enrolment in the console, instant 1:1 verification at a reader, then the student deletes their face', async ({ page, request, context, browser }) => {
    await fakeCamera(context);
    const s = student(12);
    const adminToken = await adminApiToken(request);
    const gate = await provisionReader(request, adminToken, 'GATE', 'GATE-MAIN', true);
    const plain = await provisionReader(request, adminToken, 'GATE', 'GATE-MAIN', false);
    expect((await request.put(`${API}/biometrics/devices/${gate.id}`, { headers: bearer(adminToken), data: { authorised: true, reason: 'E2E pilot reader' } })).status()).toBe(200);

    // ── enrol in the console: consent is required before the button works ──
    await adminUiLogin(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Face verification' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Face verification' })).toBeVisible();
    await expect(page.getByText('no accuracy or anti-spoofing evidence')).toBeVisible(); // prototype label is always on screen
    await expect(page.getByTestId('face-notice')).toContainText('compulsory');
    await expect(page.getByTestId('face-notice')).toContainText('exemption');
    await page.getByLabel('Registration number').fill(s.regNo);
    await expect(page.getByTestId('face-enrol')).toBeDisabled();
    await page.getByTestId('face-consent').check();
    await expect(page.getByTestId('face-capture')).toHaveAttribute('data-camera', 'live');
    await page.getByTestId('face-enrol').click();
    await expect(page.getByTestId('face-capture')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('face-caption')).toContainText('Enrolled');
    await expect(page.getByTestId('face-enrolments').getByRole('row', { name: new RegExp(s.regNo) })).toContainText('ACTIVE');

    // ── verify at the reader: same face is granted, quickly, with visible feedback ──
    const rpage = await (await browser.newContext({ permissions: [] })).newPage();
    await fakeCamera(rpage.context());
    await readerSetup(rpage, gate);
    await rpage.getByRole('radio', { name: 'SCAN FACE' }).check({ force: true }).catch(() => rpage.getByText('SCAN FACE').click());
    await expect(rpage.getByTestId('face-scan')).toBeVisible();
    await expect(rpage.getByTestId('face-capture')).toHaveAttribute('data-camera', 'live');
    await expect(rpage.getByTestId('face-capture').getByText('PROTOTYPE')).toBeVisible();
    await rpage.getByLabel('Registration number').fill(s.regNo);
    const t0 = Date.now();
    await rpage.getByTestId('face-verify').click();
    await expect(rpage.getByTestId('face-capture')).toHaveAttribute('data-state', 'ok');
    expect(Date.now() - t0).toBeLessThan(3000); // capture + decision, end to end, well under the 800 ms server budget plus capture
    await expect(rpage.getByTestId('face-caption')).toContainText('Granted');
    await expect(rpage.getByText('GRANT').first()).toBeVisible();

    // ── a different face is refused, and the reason is specific ──
    await rpage.evaluate(() => { (window as unknown as { __face: string }).__face = 'B'; });
    await rpage.waitForTimeout(4200); // let the previous result clear
    await rpage.getByTestId('face-verify').click();
    await expect(rpage.getByTestId('face-capture')).toHaveAttribute('data-state', 'fail');
    await expect(rpage.getByTestId('events')).toContainText('FACE_NO_MATCH');

    // ── the student sees "My face" and deletes it; the reader then refuses with a clear reason ──
    const spage = await (await browser.newContext()).newPage();
    await walletLogin(spage, { email: s.email, password: PASSWORD });
    await spage.goto(`${WALLET}/#/account`);
    await expect(spage.getByTestId('face-settings')).toContainText('Face verification on');
    await spage.getByTestId('face-withdraw').click();
    await expect(spage.getByTestId('face-settings')).toContainText('Not enrolled');
    await rpage.evaluate(() => { (window as unknown as { __face: string }).__face = 'A'; });
    await rpage.waitForTimeout(4200);
    await rpage.getByTestId('face-verify').click();
    await expect(rpage.getByTestId('face-capture')).toHaveAttribute('data-state', 'fail');
    await expect(rpage.getByTestId('events')).toContainText('FACE_CONSENT_REVOKED');

    // ── a reader that was never authorised for face refuses it ──
    const pctx = await browser.newContext();
    await fakeCamera(pctx);
    const ppage = await pctx.newPage();
    await readerSetup(ppage, plain);
    await ppage.getByText('SCAN FACE').click();
    await expect(ppage.getByTestId('face-capture')).toHaveAttribute('data-camera', 'live');
    await ppage.getByLabel('Registration number').fill(s.regNo);
    await ppage.getByTestId('face-verify').click();
    await expect(ppage.getByTestId('events')).toContainText('FACE_NOT_ENABLED');
  });
});

test.describe('compulsory enrolment through the console and the wallet (real browser, real API)', () => {
  test('demo 12: the pending list drives enrolment, an exemption removes a student from it, and the student sees the requirement', async ({ page, browser }) => {
    await adminUiLogin(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Face verification' }).click();
    await expect(page.getByText('Enrolment is compulsory for every student')).toBeVisible();
    const pending = page.getByTestId('face-pending');
    await expect(pending.getByTestId('face-pending-summary')).toContainText('still to enrol');
    await expect(pending.getByTestId('face-pending-summary')).toContainText('Compulsory');

    const first = pending.locator('[data-testid^="face-exempt-"]').first();
    const regNo = ((await first.getAttribute('data-testid')) ?? '').replace('face-exempt-', '');
    expect(regNo).toMatch(/^2026-/);
    await first.click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel(/Reason/).fill('short');
    await expect(dlg.getByTestId('reason-confirm')).toBeDisabled(); // exemptions need a real reason (10+ characters)
    await dlg.getByLabel(/Reason/).fill('Uses a wheelchair; the camera cannot be reached');
    await dlg.getByTestId('reason-confirm').click();
    await expect(dlg).toHaveCount(0);
    await expect(pending.getByTestId(`face-exempt-${regNo}`)).toHaveCount(0);

    // the student (if one of the twelve with a login) sees the exemption; another one sees the requirement
    const n = Number(regNo.slice(-4));
    if (n >= 1 && n <= 12) {
      const sp = await (await browser.newContext()).newPage();
      await walletLogin(sp, { email: student(n).email, password: PASSWORD });
      await sp.goto(`${WALLET}/#/account`);
      await expect(sp.getByTestId('face-exempt')).toContainText('excused');
    }
    const other = await (await browser.newContext()).newPage();
    await walletLogin(other, { email: student(1).email, password: PASSWORD });
    await expect(other.getByTestId('face-need-home')).toContainText('compulsory');
  });
});
