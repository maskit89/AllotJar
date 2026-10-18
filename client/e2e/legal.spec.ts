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

// Restyle PR 16: the landing page's chrome around the document — the header row (the wordmark
// home, "Sign in", the theme button), one card holding the h1, the date line and the text, the
// landing's footer — and the theme button really switches the page and keeps the choice.
test.describe('the legal pages in the warm look', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', mockApi)
  })

  test('/privacy: the header, the one card, the footer', async ({ page }) => {
    await page.goto('/privacy')
    const h1 = page.getByRole('heading', { level: 1, name: 'Privacy Policy' })
    await h1.waitFor()

    const header = page.getByRole('banner')
    await expect(header.getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')
    await expect(header.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    await expect(header.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('group', { name: 'Theme' })).toHaveCount(0)
    // One Sign in on the page (the header's); no green room, no line.
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(1)
    await expect(page.getByText('Give every euro a job.')).toHaveCount(0)

    // The card: the h1, then "Last updated", then the prose, inside the one article.
    const card = page.getByRole('main').getByRole('article')
    await expect(card.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
    await expect(card.getByText('Last updated: 1 July 2026')).toBeVisible()
    await expect(card.getByRole('heading', { level: 2, name: 'Who we are' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    const footer = page.getByRole('contentinfo').getByRole('navigation', { name: 'Footer' })
    await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    await expect(footer.getByRole('link')).toHaveCount(2)
    await expect(footer).toContainText(`© ${new Date().getFullYear()} AllotJar`)
  })

  test('/terms: the theme button turns dark mode on and keeps it across a reload and on /privacy', async ({ page }) => {
    await page.goto('/terms')
    await page.getByRole('heading', { level: 1, name: 'Terms of Service' }).waitFor()
    const theme = page.getByRole('button', { name: 'Dark mode' })
    await theme.click()
    await expect(theme).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.reload()
    await page.getByRole('heading', { level: 1, name: 'Terms of Service' }).waitFor()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Privacy' }).click()
    await page.getByRole('heading', { level: 1, name: 'Privacy Policy' }).waitFor()
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('the skip link moves focus into the main content', async ({ page }) => {
    await page.goto('/privacy')
    await page.getByRole('heading', { level: 1, name: 'Privacy Policy' }).waitFor()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main')).toBeFocused()
  })
})
