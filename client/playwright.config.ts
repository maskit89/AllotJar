import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the accessibility (axe-core) checks. Runs the Vite dev
 * server and drives a headless Chromium; the specs stub the API so every page
 * renders without a backend.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    // The app's prefers-reduced-motion block (index.css) collapses CSS transitions to ~0ms.
    // Without it, axe can scan mid-transition under CI contention and report phantom
    // colour-contrast blends (seen on the login mode toggle) — flaky, not real.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
