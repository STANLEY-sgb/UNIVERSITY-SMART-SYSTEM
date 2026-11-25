import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { axe, layoutProblems, WALLET, READER, activateInWallet, issueCard, operatorToken, provisionReader, readerSetup, scan, student, walletLogin, walletToken } from './helpers';

test.describe.configure({ mode: 'serial' });

const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
const SHOTS = path.resolve(__dirname, '../../docs/evidence/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

test.describe('responsive layout and accessibility (6 widths, wallet + reader)', () => {
  test('wallet: card, access, history and account pages', async ({ page, request }) => {
    const s = student(1);
    const op = await operatorToken(request);
    const card = await issueCard(request, op, s.regNo);
    await page.setViewportSize({ width: 1280, height: 900 });
    await walletLogin(page, s);
    await activateInWallet(page, card.code);
    await page.getByTestId('qr-canvas').waitFor();

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const [route, ready] of [['card', 'idcard'], ['access', 'eligibility'], ['history', 'Access history'], ['account', 'logout']] as const) {
        await page.goto(`${WALLET}/#/${route}`);
        if (route === 'history') await page.getByRole('heading', { level: 1, name: ready }).waitFor();
        else await page.getByTestId(ready).waitFor();
        await page.waitForTimeout(150);
        const where = `wallet/${route}@${w}`;
        expect(await layoutProblems(page), `${where} layout`).toEqual([]);
        if (w === 360 || w === 1440 || route === 'card') expect(await axe(page), `${where} axe`).toEqual([]);
        await page.screenshot({ path: path.join(SHOTS, `wallet-${route}-${w}.png`), fullPage: true });
      }
    }
  });

  test('wallet: sign-in screen', async ({ page }) => {
    for (const w of [360, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto(`${WALLET}/#/`);
      await page.getByTestId('login').waitFor();
      expect(await layoutProblems(page), `login@${w}`).toEqual([]);
      expect(await axe(page), `login axe@${w}`).toEqual([]);
      await page.screenshot({ path: path.join(SHOTS, `wallet-login-${w}.png`) });
    }
  });

  test('reader: setup, ready, GRANT and DENY states', async ({ page, browser, request }) => {
    const op = await operatorToken(request);
    const creds = await provisionReader(request, op, 'GATE', 'GATE-MAIN');

    // a "phone" to produce a real code
    const s = student(2);
    const card = await issueCard(request, op, s.regNo);
    const ctx = await browser.newContext();
    const ph = await ctx.newPage();
    await walletLogin(ph, s);
    await activateInWallet(ph, card.code);

    for (const w of [360, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(READER);
      await page.evaluate(async () => { for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name); });
      await page.reload();
      await page.getByTestId('connect').waitFor();
      expect(await layoutProblems(page), `reader setup@${w}`).toEqual([]);
      expect(await axe(page), `reader setup axe@${w}`).toEqual([]);
      await page.screenshot({ path: path.join(SHOTS, `reader-setup-${w}.png`) });
    }

    await readerSetup(page, creds);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      expect(await layoutProblems(page), `reader ready@${w}`).toEqual([]);
      if (w === 360 || w === 1440) expect(await axe(page), `reader ready axe@${w}`).toEqual([]);
      await page.screenshot({ path: path.join(SHOTS, `reader-ready-${w}.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 390, height: 900 });
    await ph.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await scan(page, await walletToken(ph));
    await page.getByTestId('result').waitFor();
    expect(await layoutProblems(page), 'reader grant@390').toEqual([]);
    expect(await axe(page), 'reader grant axe').toEqual([]);
    await page.screenshot({ path: path.join(SHOTS, 'reader-grant-390.png'), fullPage: true });

    await scan(page, 'KIU1.bad.bad');
    await expect(page.getByTestId('result')).toHaveAttribute('data-decision', 'DENY');
    expect(await layoutProblems(page), 'reader deny@390').toEqual([]);
    expect(await axe(page), 'reader deny axe').toEqual([]);
    await page.screenshot({ path: path.join(SHOTS, 'reader-deny-390.png'), fullPage: true });
    await ctx.close();
  });

  test('respects reduced motion and keeps keyboard focus visible', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${WALLET}/#/`);
    await page.getByTestId('login').waitFor();
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.kiu-card')!).animationName);
    expect(['none', '']).toContain(anim);
    await page.keyboard.press('Tab');
    const focusShadow = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
    expect(focusShadow).not.toBe('none');
  });
});
