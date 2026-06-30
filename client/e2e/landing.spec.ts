import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mocks'

// The WCAG 2.x success criteria we assert against (A + AA, through 2.2).
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function expectNoViolations(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}`).join('\n')
  expect(violations, summary).toEqual([])
}

// The public marketing landing page is the front door for anonymous visitors, so
// it must clear the same accessibility bar as the app. Scanned in both themes.
for (const theme of ['light', 'dark'] as const) {
  test(`public landing page has no WCAG A/AA violations — ${theme}`, async ({ page }) => {
    // Signed out: the cookie-bootstrap refresh fails (mockApi → 401), so the root
    // renders the landing page rather than the dashboard.
    await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
    await page.route('**/api/**', mockApi)
    await page.goto('/')
    await page.getByRole('heading', { level: 1, name: /give every euro a job/i }).waitFor()
    await expectNoViolations(page)
  })
}
