import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_URL, adminUiLogin, axe, layoutProblems, student } from './helpers';

test.describe.configure({ mode: 'serial' });

const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
const SHOTS = path.resolve(__dirname, '../../docs/evidence/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const PAGES: [route: string, heading: string][] = [
  ['', 'Overview'], ['students', 'Students'], ['cards', 'Cards'], ['readers', 'Readers'], ['rules', 'Eligibility rules'],
  ['finance', 'Finance clearance'], ['library', 'Library loans'], ['hostels', 'Hostels'], ['meals', 'Meal sittings'], ['timetable', 'Lecture timetable'], ['imports', 'Data imports'], ['reports', 'Reports'], ['exams', 'Examinations'], ['face', 'Face verification'], ['settings', 'Settings'], ['overrides', 'Manual overrides'], ['logs', 'Access logs'], ['alerts', 'Security alerts'], ['audit', 'Audit trail'], ['users', 'Staff accounts'],
];

test.describe('admin console: responsive layout and accessibility', () => {
  test('every page at six widths: no overflow, 44 px targets; axe WCAG A/AA at the extremes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminUiLogin(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const [route, heading] of PAGES) {
        await page.goto(`${ADMIN_URL}/#/${route}`);
        await page.getByRole('heading', { level: 1, name: heading }).waitFor();
        await page.waitForTimeout(250); // let the page's data arrive
        const where = `admin/${route || 'overview'}@${w}`;
        expect(await layoutProblems(page), `${where} layout`).toEqual([]);
        if (w === 360 || w === 1440) expect(await axe(page), `${where} axe`).toEqual([]);
        if (w === 360 || w === 1280 || (route === '' && (w === 768 || w === 1024))) await page.screenshot({ path: path.join(SHOTS, `admin-${route || 'overview'}-${w}.png`), fullPage: true });
      }
    }
  });

  test('mobile drawer: opens, shows permitted links, navigates and closes', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await adminUiLogin(page);
    const side = page.getByLabel('Sidebar');
    await expect(side).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden(); // off-canvas links are not reachable while closed
    await page.getByTestId('menu-btn').click();
    await expect(side).toHaveAttribute('data-open', 'true');
    await expect.poll(() => side.evaluate((el) => el.getBoundingClientRect().left), { message: 'drawer finished sliding in' }).toBeGreaterThanOrEqual(0);
    expect(await layoutProblems(page), 'drawer open layout').toEqual([]);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Cards' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Cards' })).toBeVisible();
    await expect(side).toHaveAttribute('data-open', 'false');
    await page.screenshot({ path: path.join(SHOTS, 'admin-drawer-360.png') });
  });

  test('dialogs and the rule editor are usable on a phone and on desktop', async ({ page }) => {
    for (const w of [360, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      await adminUiLogin(page);

      await page.goto(`${ADMIN_URL}/#/students`);
      await page.getByLabel('Search name or registration no.').fill(student(2).regNo);
      await page.getByTestId('students').getByText(student(2).regNo).first().click();
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByTestId('student-detail')).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished.catch(() => undefined)))); // measure the settled size, not the 200 ms scale-in
      expect(await layoutProblems(page), `student dialog@${w}`).toEqual([]);
      expect(await axe(page), `student dialog axe@${w}`).toEqual([]);
      await page.screenshot({ path: path.join(SHOTS, `admin-student-dialog-${w}.png`) });
      await page.keyboard.press('Escape'); // keyboard users can always dismiss
      await expect(dlg).toHaveCount(0);

      await page.goto(`${ADMIN_URL}/#/rules`);
      await page.getByTestId('edit-GATE').click();
      await expect(page.getByTestId('rule-editor')).toBeVisible();
      expect(await layoutProblems(page), `rule editor@${w}`).toEqual([]);
      expect(await axe(page), `rule editor axe@${w}`).toEqual([]);
      await page.screenshot({ path: path.join(SHOTS, `admin-rules-editor-${w}.png`), fullPage: true });
      await page.getByTestId('signout').click();
    }
  });

  test('focus is trapped inside a dialog and returns to the opener on close', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminUiLogin(page);
    await page.goto(`${ADMIN_URL}/#/readers`);
    const opener = page.getByTestId('new-reader');
    await opener.focus();
    await opener.press('Enter');
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `focus escaped on Tab #${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});
