import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the REAL-BACKEND journey tests (distinct from playwright.config.ts, which
 * stubs the API for axe scans). These specs drive complete user journeys — register, import,
 * invite/accept — through a live .NET API and a real SQL Server, so they catch the whole-stack
 * bugs the handler-level and stubbed-UI suites cannot (FK crashes, dedup, cookie refresh, the
 * preview→commit contract).
 *
 * Two web servers are booted and torn down automatically:
 *   1. the API on :5099 (Development env so the refresh cookie works over plain http; a throwaway
 *      SQL Server DB via ConnectionStrings__DefaultConnection; a relaxed auth rate limit), and
 *   2. the Vite dev server on :4173, which proxies /api → the API (single-origin cookie auth,
 *      exactly like a real deployment behind a reverse proxy).
 *
 * Journeys share one database and the per-IP auth rate-limit window, so they run serially.
 */

const API_URL = 'http://localhost:5099'
const APP_URL = 'http://localhost:4173'

// A dedicated throwaway database, never the dev DB. CI overrides this to point at the mssql
// service container via JOURNEY_TEST_CONNECTION.
const CONNECTION =
  process.env.JOURNEY_TEST_CONNECTION ??
  'Server=(localdb)\\MSSQLLocalDB;Database=AllotJar_Journey;Trusted_Connection=True;MultipleActiveResultSets=true;TrustServerCertificate=True'

// HS256 needs ≥ 32 bytes. Not a secret — it only ever signs tokens for a throwaway test DB.
const JWT_KEY = process.env.JOURNEY_JWT_KEY ?? 'journey-e2e-signing-key-not-a-secret-0123456789'

export default defineConfig({
  testDir: './e2e-journey',
  // One DB + one rate-limit window shared across specs → run serially for determinism.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The html report is uploaded as a CI artifact on failure (playwright-report/).
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : 'list',
  // Journeys drive real HTTP + migrations on first boot; be generous. The 15s expect covers a
  // cold-runner first register (EF warmup + the fail-open HIBP breached-password network call).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: APP_URL,
    // Pin the locale so the money-format assertions are deterministic regardless of the runner.
    locale: 'en-GB',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // `dotnet run` builds if needed; CI pre-builds so this is a fast start. Development env →
      // the refresh cookie is not Secure, so it survives over http; migrations auto-apply to the
      // fresh DB on boot; the relaxed rate limit keeps a serial run from tripping the auth cap.
      command: 'dotnet run -c Release --no-launch-profile --project ../src/AllotJar.Api',
      url: `${API_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ASPNETCORE_ENVIRONMENT: 'Development',
        ASPNETCORE_URLS: API_URL,
        ConnectionStrings__DefaultConnection: CONNECTION,
        Jwt__Key: JWT_KEY,
        RateLimiting__AuthPermitLimit: '1000',
        // Emailed links (password reset) point at the journey app origin, so a spec can follow
        // the exact link a real recipient would click (read back via GET /api/dev/emails).
        Email__AppBaseUrl: APP_URL,
        // Google sign-in: the Development-only fake validator (accepts fake-google:{json}
        // credentials) so a journey can drive the whole server+client session lifecycle without
        // Google's interactive consent screen. Double-gated — needs this AND the Development host.
        Google__UseFakeValidator: 'true',
        // Quieten the API's Development Info/SQL logging so it doesn't flood the test output.
        Logging__LogLevel__Default: 'Warning',
      },
    },
    {
      command: 'npm run dev -- --port 4173 --strictPort',
      url: APP_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { API_PROXY_TARGET: API_URL },
    },
  ],
})
