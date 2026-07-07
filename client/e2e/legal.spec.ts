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

// The public /privacy and /terms pages are crawlable trust pages, so they must
// clear the same accessibility bar as the rest of the app. Scanned in both themes.
const LEGAL = [
  { path: '/privacy', heading: /privacy policy/i },
  { path: '/terms', heading: /terms of service/i },
] as const

for (const theme of ['light', 'dark'] as const) {
  for (const { path, heading } of LEGAL) {
    test(`${path} has no WCAG A/AA violations — ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)
      await page.goto(path)
      await page.getByRole('heading', { level: 1, name: heading }).waitFor()
      await expectNoViolations(page)
    })
  }
}
