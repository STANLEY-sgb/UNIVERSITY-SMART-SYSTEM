// Takes screenshots of the running demo (admin, wallet, reader) at desktop and phone sizes, for visual review.
//   node e2e/shots.mjs <outDir>
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'shots';
fs.mkdirSync(out, { recursive: true });
const PW = 'Demo-Password-2026!';
const browser = await chromium.launch();
const shot = async (page, name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false }); console.log('saved', name); };

for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000');
  await shot(page, `${label}-admin-login`);
  await page.getByLabel('Email').fill('demo-admin@kiu-demo.test').catch(() => page.getByLabel(/email/i).fill('demo-admin@kiu-demo.test'));
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByRole('navigation', { name: 'Primary' }).waitFor({ state: 'attached' });
  await shot(page, `${label}-admin-overview`);
  await page.goto('http://localhost:3000/#/students'); await shot(page, `${label}-admin-students`);
  await page.goto('http://localhost:3000/#/reports'); await shot(page, `${label}-admin-reports`);
  await ctx.close();

  const w = await browser.newContext({ viewport: vp });
  const wp = await w.newPage();
  await wp.goto('http://localhost:3001/#/');
  await shot(wp, `${label}-wallet-login`);
  await wp.getByLabel('University email').fill('student01@kiu-demo.test');
  await wp.getByLabel('Password').fill(PW);
  await wp.getByTestId('login').click();
  await wp.getByRole('navigation', { name: 'Primary' }).waitFor();
  await shot(wp, `${label}-wallet-home`);
  await wp.goto('http://localhost:3001/#/card'); await shot(wp, `${label}-wallet-card`);
  await w.close();

  const r = await browser.newContext({ viewport: vp });
  const rp = await r.newPage();
  await rp.goto('http://localhost:3002');
  await shot(rp, `${label}-reader-setup`);
  await r.close();
}
await browser.close();
