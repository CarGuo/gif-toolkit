import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-smoke',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'off', video: 'off', screenshot: 'off' }
});
