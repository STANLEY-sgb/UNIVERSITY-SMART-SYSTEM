import { expect, test } from '@playwright/test';
import {
  API, PASSWORD, activateInWallet, adminApiToken, adminUiLogin, bearer, issueCard, operatorToken, provisionReader, readerVerify, retireCards,
  student, walletLogin, walletToken,
} from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('university services through the console (real browser, real API)', () => {
  test('demo 3: Finance clears a student in the console and the student sees it straight away', async ({ page, request }) => {
    const s = student(10); // seeded: 40% fees paid, not cleared for examinations
    const login = await request.post(`${API}/auth/login`, { headers: { 'X-Token-Delivery': 'body' }, data: { email: s.email, password: PASSWORD } });
    const studentToken = (await login.json()).accessToken as string;
    const examState = async () => {
      const res = await (await request.get(`${API}/me/eligibility`, { headers: bearer(studentToken) })).json();
      return res.services.find((x: { service: string }) => x.service === 'EXAM') as { status: string; reason_code?: string };
    };
    expect((await examState()).reason_code).toBe('FINANCE_NOT_CLEARED');

    await adminUiLogin(page, { email: 'finance-officer@kiu-demo.test', password: PASSWORD });
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Finance' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Cards' })).toHaveCount(0); // role-aware
    await nav.getByRole('link', { name: 'Finance' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Finance clearance' })).toBeVisible();
    await page.getByLabel('Search name or registration no.').fill(s.regNo);
    const row = page.getByTestId('finance').getByRole('row', { name: new RegExp(s.regNo) });
    await expect(row).toContainText('Not cleared');
    await row.getByTestId(`finance-edit-${s.regNo}`).click();

    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Fees paid (%)').fill('100');
    await dlg.getByTestId('cleared-toggle').check();
    await expect(dlg.getByTestId('finance-save')).toBeDisabled(); // a reason is mandatory
    await dlg.getByLabel(/Reason/).fill('Receipt FIN-2026-0099 verified');
    await dlg.getByTestId('finance-save').click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId('finance').getByRole('row', { name: new RegExp(s.regNo) })).toContainText('Cleared');

    try {
      expect((await examState()).reason_code).not.toBe('FINANCE_NOT_CLEARED'); // the very next decision no longer says so
    } finally {
      // Student 10 is shared with the wallet spec, which expects the seeded state: put it back through the same API.
      const fin = await request.post(`${API}/auth/login`, { headers: { 'X-Token-Delivery': 'body' }, data: { email: 'finance-officer@kiu-demo.test', password: PASSWORD } });
      const ft = (await fin.json()).accessToken as string;
      await request.patch(`${API}/finance/students/${s.regNo}`, { headers: bearer(ft), data: { feesPaidPercent: 40, examCleared: false, reason: 'e2e restore seeded state' } });
    }
  });

  test('demo 4: overdue items block borrowing; the librarian marks them returned and the next scan is granted', async ({ page, request, browser }) => {
    const s = student(9); // seeded: two overdue library loans
    const op = await operatorToken(request);
    await retireCards(request, op, s.regNo);
    const reader = await provisionReader(request, op, 'LIBRARY_BORROW', 'LIB-MAIN');
    const card = await issueCard(request, op, s.regNo);
    const phone = await browser.newContext();
    const wp = await phone.newPage();
    await walletLogin(wp, s);
    await activateInWallet(wp, card.code);

    const firstToken = await walletToken(wp);
    const blocked = (await readerVerify(request, reader, firstToken)).body;
    expect(blocked).toMatchObject({ decision: 'DENY', reason_code: 'LIBRARY_OVERDUE' });

    await adminUiLogin(page, { email: 'librarian@kiu-demo.test', password: PASSWORD });
    await page.goto('http://localhost:3000/#/library');
    await expect(page.getByRole('heading', { level: 1, name: 'Library loans' })).toBeVisible();
    await page.getByLabel('Filter by registration no.').fill(s.regNo);
    const rows = page.getByTestId('loans').getByRole('row', { name: /OVERDUE/ });
    await expect(rows).toHaveCount(2);
    for (const ref of ['BK-9-0', 'BK-9-1']) await page.getByTestId(`return-${ref}`).click();
    await expect(page.getByRole('status').filter({ hasText: 'Borrowing is open again' })).toContainText('Borrowing is open again');

    // A QR is single-use (replay protection), so wait for the wallet to rotate to a fresh one.
    await expect.poll(() => walletToken(wp), { timeout: 40_000 }).not.toBe(firstToken);
    const open = (await readerVerify(request, reader, await walletToken(wp))).body;
    expect(open, JSON.stringify(open)).toMatchObject({ decision: 'GRANT' });
    await phone.close();
  });

  test('hostel: the warden allocates a student in the console and the hostel reader admits them on the next scan', async ({ page, request, browser }) => {
    const s = student(11); // seeded without a hostel allocation
    const op = await operatorToken(request);
    await retireCards(request, op, s.regNo);
    const reader = await provisionReader(request, op, 'HOSTEL', 'HOSTEL-A');
    const card = await issueCard(request, op, s.regNo);
    const phone = await browser.newContext();
    const wp = await phone.newPage();
    await walletLogin(wp, s);
    await activateInWallet(wp, card.code);
    const firstToken = await walletToken(wp);
    expect((await readerVerify(request, reader, firstToken)).body).toMatchObject({ decision: 'DENY', reason_code: 'HOSTEL_NOT_ASSIGNED' });

    await adminUiLogin(page, { email: 'hostel-warden@kiu-demo.test', password: PASSWORD });
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Hostels' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Hostels' })).toBeVisible();
    await page.getByLabel('Registration no.').fill(s.regNo);
    await page.getByLabel('Hostel', { exact: true }).first().selectOption('HA');
    await page.getByLabel(/Reason/).fill('Room allocated by the warden');
    await page.getByTestId('allocate-submit').click();
    await expect(page.getByRole('status').filter({ hasText: 'allocated to HA' })).toBeVisible();

    await expect.poll(() => walletToken(wp), { timeout: 40_000 }).not.toBe(firstToken);
    expect((await readerVerify(request, reader, await walletToken(wp))).body).toMatchObject({ decision: 'GRANT' });
    await phone.close();
  });

  test('imports: preview shows what would change, commit applies it once, and the same file is then refused', async ({ page, request }) => {
    const regNo = '2026-BED-0015'; // seeded: 75% fees paid, not cleared; no other test touches student 15
    const csv = ['reg_no,fees_paid_percent,exam_cleared', regNo + ',100,yes', 'GHOST-0001,100,yes'].join(String.fromCharCode(10));
    await adminUiLogin(page, { email: 'finance-officer@kiu-demo.test', password: PASSWORD });
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Data imports' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Data imports' })).toBeVisible();
    await page.getByLabel('…or paste CSV text').fill(csv);
    await page.getByTestId('import-preview').click();
    const summary = page.getByTestId('import-summary');
    await expect(summary).toContainText('1 will change');
    await expect(summary).toContainText('1 with errors');
    await expect(summary).toContainText('unknown student');
    await expect(summary).toContainText('fees_paid_percent: 75');

    const login = await request.post(API + '/auth/login', { headers: { 'X-Token-Delivery': 'body' }, data: { email: 'finance-officer@kiu-demo.test', password: PASSWORD } });
    const ft = (await login.json()).accessToken as string;
    const state = async () => (await (await request.get(API + '/finance/students?q=' + regNo, { headers: bearer(ft) })).json()).data[0];
    expect(await state()).toMatchObject({ examCleared: false }); // preview changed nothing

    await page.getByTestId('import-commit').click();
    await page.getByRole('dialog').getByLabel(/Reason/).fill('Term payments batch');
    await page.getByRole('dialog').getByTestId('reason-confirm').click();
    await expect(page.getByRole('status').filter({ hasText: 'Import finished: 1 row(s) applied, 1 skipped' })).toBeVisible();
    expect(await state()).toMatchObject({ examCleared: true, feesPaidPercent: 100 });
    await expect(page.getByTestId('import-jobs')).toContainText('COMPLETED WITH ERRORS');

    await page.getByLabel('…or paste CSV text').fill(csv);
    await page.getByTestId('import-preview').click();
    await expect(page.getByText('already imported')).toBeVisible();
    await expect(page.getByTestId('import-commit')).toBeDisabled();
  });
});

test.describe('reports through the console (real browser, real API)', () => {
  test('demo 5: Management runs a report and downloads the audited CSV; a role without export has no download button', async ({ page }) => {
    await adminUiLogin(page, { email: 'management@kiu-demo.test', password: PASSWORD });
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(page.getByTestId('report-totals')).toBeVisible();
    await page.getByTestId('report-run').click();
    await expect(page.getByTestId('report-totals')).toContainText('Decisions');

    const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-export').click()]);
    expect(file.suggestedFilename()).toMatch(/^access-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const path = await file.path();
    const text = (await import('node:fs')).readFileSync(path!, 'utf8');
    expect(text).toContain('occurred_at,decision,reason_code');

    // Finance can view reports but has no export permission, so the button is not offered.
    await page.getByTestId('signout').click();
    await adminUiLogin(page, { email: 'finance-officer@kiu-demo.test', password: PASSWORD });
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByTestId('report-run')).toBeVisible();
    await expect(page.getByTestId('report-export')).toHaveCount(0);
    // office reports: Finance sees only its own report, can run it, but has no CSV button
    const office = page.getByTestId('domain-reports');
    await expect(office).toBeVisible();
    await expect(office.getByLabel('Report').locator('option')).toHaveCount(1);
    await office.getByTestId('domain-run').click();
    await expect(office.getByTestId('domain-result')).toContainText('Not Cleared');
    await expect(office.getByTestId('domain-export')).toHaveCount(0);
  });
});

test.describe('examination scheduling through the console (real browser, real API)', () => {
  test('demo 6: the registry schedules an examination, sees it listed, then cancels it with a reason', async ({ page }) => {
    await adminUiLogin(page, { email: 'registry-officer@kiu-demo.test', password: PASSWORD });
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Examinations' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Examinations' })).toBeVisible();
    await expect(page.getByTestId('exams')).toContainText('CSC1101'); // seeded upcoming paper

    await page.getByLabel('Course code').fill('csc2202');
    await page.getByLabel('Examination hall').selectOption({ label: 'Examination Hall A (300)' });
    await page.getByLabel('Starts').fill('2031-03-03T09:00');
    await page.getByLabel('Ends').fill('2031-03-03T12:00');
    await page.getByLabel(/Reason/).fill('Senate timetable 2031/1');
    await page.getByTestId('exam-create').click();
    await expect(page.getByText('Scheduled CSC2202')).toBeVisible();
    const row = page.getByTestId('exams').getByRole('row', { name: /CSC2202/ });
    await expect(row).toBeVisible();

    await row.getByTestId('seats-CSC2202').click();
    const seats = page.getByRole('dialog');
    await expect(seats.getByTestId('seat-summary')).toContainText('enrolled');
    const auto = seats.getByTestId('seats-auto');
    if (await auto.count()) {
      await seats.getByLabel('Reason (audited)').fill('Seat the hall for the sitting');
      await auto.click();
      await expect(seats.getByTestId('seat-list')).toContainText('A1');
    }
    await seats.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(seats).toHaveCount(0);

    await row.getByTestId('cancel-CSC2202').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel(/Reason/).fill('Rescheduled by senate');
    await dlg.getByRole('button', { name: 'Cancel examination' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId('exams').getByRole('row', { name: /CSC2202/ })).toHaveCount(0);
  });
});

test.describe('settings through the console (real browser, real API)', () => {
  test('demo 8: an administrator changes a policy value, adds a venue and a session, and the changes are audited', async ({ page, request }) => {
    const token = await adminApiToken(request);
    const original = (await (await request.get(`${API}/settings/policy`, { headers: bearer(token) })).json()).values as { fine_limit_ugx: number };
    try {
      await adminUiLogin(page);
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

      await page.getByLabel('Library fine limit for borrowing (UGX)').fill(String(original.fine_limit_ugx + 1000));
      await expect(page.getByTestId('policy-save')).toBeDisabled(); // reason required
      await page.getByLabel('Reason (audited)').first().fill('Senate decision 7/2026');
      await page.getByTestId('policy-save').click();
      await expect(page.getByText('Policy saved')).toBeVisible();
      const now = (await (await request.get(`${API}/settings/policy`, { headers: bearer(token) })).json()).values;
      expect(now.fine_limit_ugx).toBe(original.fine_limit_ugx + 1000);

      const code = `E2E-${Date.now() % 100000}`;
      await page.getByLabel('Code', { exact: true }).fill(code);
      await page.getByLabel('Name', { exact: true }).fill('E2E seminar room');
      await page.getByLabel('Reason (audited)').nth(1).fill('New seminar room');
      await page.getByTestId('venue-add').click();
      await expect(page.getByTestId('venues').getByRole('row', { name: new RegExp(code) })).toBeVisible();

      await page.getByLabel('Session', { exact: true }).fill('2041/2042');
      await page.getByLabel('Starts').first().fill('2041-08-01');
      await page.getByLabel('Ends').first().fill('2042-07-31');
      await page.getByLabel('Reason (audited)').nth(2).fill('Plan ahead');
      await page.getByTestId('session-add').click();
      await expect(page.getByTestId('sessions')).toContainText('2041/2042');
    } finally {
      await request.patch(`${API}/settings/policy`, { headers: bearer(token), data: { fine_limit_ugx: original.fine_limit_ugx, reason: 'Restore after e2e run' } });
    }
  });
});

test.describe('manual overrides through the console (real browser, real API)', () => {
  test('demo 9: an override is refused without a recent denial and demands a written reason', async ({ page }) => {
    await adminUiLogin(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Overrides' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Manual overrides' })).toBeVisible();
    await expect(page.getByText('cannot cover a lost or blocked card')).toBeVisible();
    await page.getByLabel('Registration number').fill(student(3).regNo);
    await expect(page.getByTestId('override-submit')).toBeDisabled();
    await page.getByLabel(/Why is this justified/).fill('Student says the gate refused them');
    await page.getByTestId('override-submit').click();
    await expect(page.getByText(/refusal for this student and service in the last 30 minutes/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent overrides' })).toBeVisible();
  });
});

test.describe('student registration through the console (real browser, real API)', () => {
  test('demo 10: the registry registers a student, duplicates are refused, and the new student starts with nothing cleared', async ({ page, request }) => {
    const regNo = `2026-E2E-${String(Date.now() % 10000).padStart(4, '0')}`;
    await adminUiLogin(page, { email: 'registry-officer@kiu-demo.test', password: PASSWORD });
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Students' }).click();
    await page.getByTestId('student-new').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('student-create')).toBeDisabled();
    await dlg.getByLabel('Registration number').fill(regNo);
    await dlg.getByLabel('Full name').fill('Fictional E2E Student');
    await dlg.getByLabel('Programme').selectOption({ index: 1 });
    await dlg.getByTestId('student-create').click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByText(`Registered ${regNo}`)).toBeVisible();
    await expect(page.getByTestId('students').getByRole('row', { name: new RegExp(regNo) })).toBeVisible();

    await page.getByTestId('student-new').click();
    await dlg.getByLabel('Registration number').fill(regNo);
    await dlg.getByLabel('Full name').fill('Duplicate Person');
    await dlg.getByLabel('Programme').selectOption({ index: 1 });
    await dlg.getByTestId('student-create').click();
    await expect(dlg.getByText(/already exists/)).toBeVisible();
    void request;
  });
});

test.describe('live dashboard (real browser, real API)', () => {
  test('demo 11: the overview updates by itself when a reader decision happens (pushed, not polled)', async ({ page, request }) => {
    const token = await adminApiToken(request);
    const reader = await provisionReader(request, token, 'GATE', 'GATE-MAIN');
    await adminUiLogin(page);
    await expect(page.getByTestId('live-state')).toHaveAttribute('data-live', 'live');
    const denies = async () => Number((await page.getByTestId('stat-denies').locator('.n').textContent()) ?? '0');
    const before = await denies();
    const r = await readerVerify(request, reader, 'KIU1.not-a-real.credential');
    expect(r.body.decision).toBe('DENY');
    // the safety-net poll is 30 s; seeing the change within 8 s can only be the pushed event
    await expect.poll(denies, { timeout: 8000 }).toBe(before + 1);
  });
});
