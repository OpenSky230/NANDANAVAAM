import { defineConfig, devices } from '@playwright/test';

const BASE_URL = (process.env.BASE_URL ?? 'https://localhost:4173/').trim();

export default defineConfig({
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  },
  testDir: './tests',
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'webkit-iphone-12', use: { ...devices['iPhone 12'] } },
    { name: 'webkit-iphone-14-pro', use: { ...devices['iPhone 14 Pro'] } },
    { name: 'webkit-ipad', use: { ...devices['iPad Pro 11'] } },
    { name: 'chromium-pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'chromium-galaxy-s9', use: { ...devices['Galaxy S9+'] } },
  ],
});
