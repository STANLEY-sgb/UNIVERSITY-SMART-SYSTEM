import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the REAL stack: embedded PostgreSQL + compiled API (e2e/stack.mjs) and the production
 * builds of the wallet (:3001) and reader (:3002). Only the camera is not exercised (headless has no QR to point at);
 * the decode path is covered by unit tests and every reader flow also works through the "enter the code" field.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './.results',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    { command: 'node e2e/stack.mjs', cwd: '..', url: 'http://localhost:4000/api/v1/health', timeout: 240_000, reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe' },
    { command: 'pnpm --filter @kiu/admin build && pnpm --filter @kiu/admin preview', cwd: '..', url: 'http://localhost:3000', timeout: 180_000, reuseExistingServer: false },
    { command: 'pnpm --filter @kiu/student-portal build && pnpm --filter @kiu/student-portal preview', cwd: '..', url: 'http://localhost:3001', timeout: 180_000, reuseExistingServer: false },
    { command: 'pnpm --filter @kiu/reader build && pnpm --filter @kiu/reader preview', cwd: '..', url: 'http://localhost:3002', timeout: 180_000, reuseExistingServer: false },
  ],
});
