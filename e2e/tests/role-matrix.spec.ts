import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MFA_REQUIRED_ROLES, ROLE_DEFINITIONS, type PermissionCode } from '@kiu/shared';
import { ROUTE_META, visibleRoutes } from '../../apps/admin/src/lib/nav';
import { ADMIN_URL, API, PASSWORD, adminUiLogin } from './helpers';

const { authenticator } = createRequire(path.resolve(__dirname, '../../apps/api/package.json'))('otplib') as typeof import('otplib');

/** SUPER_ADMIN/ICT_ADMIN are forced through first-time MFA enrolment (same flow as admin.spec.ts's MFA test) before the console is reachable. */
async function loginMaybeMfa(page: Page, roleCode: string, email: string) {
  if (!MFA_REQUIRED_ROLES.includes(roleCode as (typeof MFA_REQUIRED_ROLES)[number])) {
    return adminUiLogin(page, { email, password: PASSWORD });
  }
  await page.goto(`${ADMIN_URL}/#/`);
  await page.getByLabel('Staff email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByTestId('login').click();
  const setupHeading = page.getByRole('heading', { name: 'Secure your account' });
  const whoami = page.getByTestId('whoami');
  await expect(setupHeading.or(whoami)).toBeVisible({ timeout: 15_000 });
  if (await setupHeading.isVisible()) {
    const secret = ((await page.getByTestId('mfa-secret').textContent()) ?? '').trim();
    await page.getByLabel('6-digit code').fill(authenticator.generate(secret));
    await page.getByTestId('mfa-enable').click();
    await page.getByTestId('secret-done').click();
  }
  await whoami.waitFor();
}

/**
 * Every staff role gets exactly the console sections and API access its permission list grants —
 * no more, no less. One cheap, idempotent GET endpoint per permission (never a mutation), reused both
 * to prove a granted permission works and to prove a withheld one is refused (403).
 */
const PROBE: Partial<Record<PermissionCode, string>> = {
  'students.view': '/students?pageSize=1',
  'cards.view': '/cards?pageSize=1',
  'readers.view': '/readers?pageSize=1',
  'rules.view': '/services/GATE/rule',
  'services.view': '/services',
  'finance.view': '/finance/students?pageSize=1',
  'registry.view': '/lectures',
  'library.view': '/library/loans?pageSize=1',
  'hostel.view': '/hostels',
  'cafeteria.view': '/cafeteria/sittings',
  'exams.view': '/exams/halls',
  'biometrics.view': '/biometrics/devices',
  'access.logs.view': '/logs?pageSize=1',
  'alerts.view': '/alerts?pageSize=1',
  'audit.view': '/audit?pageSize=1',
  'users.view': '/users?pageSize=1',
  'reports.view': '/dashboard/summary',
  'integrations.view': '/imports/jobs?pageSize=1',
  'settings.manage': '/settings/policy',
};

const demoEmail = (code: string) => `${code.toLowerCase().replace(/_/g, '-')}@kiu-demo.test`;

async function login(request: import('@playwright/test').APIRequestContext, email: string) {
  const r = await request.post(`${API}/auth/login`, { headers: { 'X-Token-Delivery': 'body' }, data: { email, password: PASSWORD } });
  if (!r.ok()) throw new Error(`login failed for ${email}: ${r.status()} ${await r.text()}`);
  return (await r.json()).accessToken as string;
}

test.describe.configure({ mode: 'serial' });

// This runs before the browser nav block below: it logs in every role with a plain password (no MFA code), and
// ICT_ADMIN's nav test enrols MFA for real, which would make a plain password login fail afterwards.
//
// SUPER_ADMIN and ICT_ADMIN are excluded from this API-only loop: a password-only login for an MFA-required role is
// deliberately unprivileged (auth.guards.ts blocks every permission-gated route until MFA is actually enrolled —
// see auth.e2e.ts/rbac.e2e.ts, which rely on the same gate), so every probe would 403 regardless of the role's real
// permissions. ICT_ADMIN's permissions are instead proven by the browser nav block below, which completes real MFA
// enrolment before the console pages load their data; SUPER_ADMIN's are proven by admin.spec.ts's own MFA test.
test.describe('role matrix: API permissions are enforced per role (no browser)', () => {
  for (const role of ROLE_DEFINITIONS.filter((r) => r.code !== 'STUDENT' && !MFA_REQUIRED_ROLES.includes(r.code))) {
    test(`${role.code}: granted permissions work, withheld ones are refused`, async ({ request }) => {
      const token = await login(request, demoEmail(role.code));
      const auth = { Authorization: `Bearer ${token}` };

      const grantedPerm = role.permissions.find((p) => PROBE[p]) as PermissionCode | undefined;
      expect(grantedPerm, `${role.code} has no permission with a probe endpoint — add one`).toBeTruthy();
      if (grantedPerm) {
        const res = await request.get(`${API}${PROBE[grantedPerm]}`, { headers: auth });
        expect(res.status(), `${role.code} holds ${grantedPerm} but ${PROBE[grantedPerm]} returned ${res.status()}`).not.toBe(403);
      }

      const deniedPerm = (Object.keys(PROBE) as PermissionCode[]).find((p) => !role.permissions.includes(p));
      expect(deniedPerm, `${role.code} holds every probed permission — nothing to test as denied`).toBeTruthy();
      if (deniedPerm) {
        const res = await request.get(`${API}${PROBE[deniedPerm]}`, { headers: auth });
        expect(res.status(), `${role.code} lacks ${deniedPerm} but ${PROBE[deniedPerm]} returned ${res.status()} instead of 403`).toBe(403);
      }
    });
  }

  test('STUDENT: self-service works, staff endpoints are refused', async ({ request }) => {
    const token = await login(request, 'student01@kiu-demo.test');
    const auth = { Authorization: `Bearer ${token}` };
    const me = await request.get(`${API}/me/eligibility`, { headers: auth });
    expect(me.status()).not.toBe(403);
    const staffOnly = await request.get(`${API}/students?pageSize=1`, { headers: auth });
    expect(staffOnly.status()).toBe(403);
  });
});

test.describe('role matrix: console nav matches permissions (real browser)', () => {
  // SUPER_ADMIN is excluded here: admin.spec.ts's dedicated MFA test runs first (alphabetical file order) and enables
  // TOTP for that exact account, so by the time this file runs its login needs a code this file never saved — and
  // that test already asserts SUPER_ADMIN's nav. ICT_ADMIN is the other MFA-required role; nothing above enrols it
  // (those calls never submit an mfaCode, so they don't reach `/auth/mfa/enable`), so its first-time-enrolment path
  // below is safe, and it runs last so it doesn't disturb the API block above.
  for (const role of ROLE_DEFINITIONS.filter((r) => r.code !== 'STUDENT' && r.code !== 'SUPER_ADMIN')) {
    test(`${role.code}: sees exactly the sections its permissions grant`, async ({ page }) => {
      await loginMaybeMfa(page, role.code, demoEmail(role.code));
      const nav = page.getByRole('navigation', { name: 'Primary' });
      const expected = new Set(visibleRoutes(role.permissions).map((r) => r.label));
      for (const r of ROUTE_META) {
        const link = nav.getByRole('link', { name: r.label });
        if (expected.has(r.label)) await expect(link, `${role.code} should see "${r.label}"`).toBeVisible();
        else await expect(link, `${role.code} should NOT see "${r.label}"`).toHaveCount(0);
      }
      // ICT_ADMIN holds biometrics.policy.manage but needed biometrics.view added too (fixed in permissions.ts) for
      // the Face verification page's own data (enrolments/policy/devices) to load instead of 403ing silently.
      if (role.code === 'ICT_ADMIN') {
        await nav.getByRole('link', { name: 'Face verification' }).click();
        await expect(page.getByRole('heading', { name: 'Face verification' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
      }
    });
  }
});
