import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mocks'

/** Signed out, in `theme`: the cookie-bootstrap refresh fails (mockApi → 401), so `/` is the landing. */
async function signedOut(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
  await page.route('**/api/**', mockApi)
}

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
    await signedOut(page, theme)
    await page.goto('/')
    // The line is euro always (restyle PR 15): it never follows the browser locale.
    await page.getByRole('heading', { level: 1, name: 'Give every euro a job.' }).waitFor()
    await expectNoViolations(page)
  })
}

// The landing's "Product tour" (31 Oct 2026): the header row with the wordmark, a quiet "Sign in"
// and the theme button; the hero with the line, both buttons side by side and a slice of the app;
// the links to today's targets.
test.describe('public landing page', () => {
  test('both buttons side by side on the first screen, Sign in in the header too', async ({ page }) => {
    await signedOut(page, 'light')
    await page.goto('/')
    const hero = page.getByRole('region', { name: 'Give every euro a job.' })
    const create = hero.getByRole('link', { name: 'Create free account' })
    const signIn = hero.getByRole('link', { name: 'Sign in' })
    await expect(create).toHaveAttribute('href', '/login?register=1')
    await expect(signIn).toHaveAttribute('href', '/login')
    await page.evaluate(() => document.fonts.ready)
    // Side by side, on the first screen (1280x720, Desktop Chrome).
    const c = (await create.boundingBox())!
    const s = (await signIn.boundingBox())!
    expect(Math.abs(c.y - s.y)).toBeLessThan(2)
    expect(s.x).toBeGreaterThan(c.x + c.width)
    expect(s.y + s.height).toBeLessThan(720)
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible()
    // "Sign in" is a link, not a button.
    expect(await page.getByRole('button', { name: 'Sign in' }).count()).toBe(0)
    // Privacy and Terms in the footer.
    await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
  })

  test('the theme button turns dark mode on and keeps it across a reload', async ({ page }) => {
    // Light from the OS (not a stored pick, which the reload would re-seed): the press stores the
    // pick under zbb.theme, and theme-init.js reads it back before the first paint.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.route('**/api/**', mockApi)
    await page.goto('/')
    const theme = page.getByRole('button', { name: 'Dark mode' })
    await expect(theme).toHaveAttribute('aria-pressed', 'false')
    await theme.click()
    await expect(theme).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.reload()
    await page.getByRole('heading', { level: 1 }).waitFor()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('the CTAs open the login page on the right tab', async ({ page }) => {
    await signedOut(page, 'light')
    await page.goto('/')
    const hero = page.getByRole('region', { name: 'Give every euro a job.' })
    await hero.getByRole('link', { name: 'Create free account' }).click()
    await expect(page).toHaveURL(/\/login\?register=1$/)
    await expect(page.getByLabel('First name')).toBeVisible()
    await page.goto('/')
    await hero.getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByLabel('First name')).toHaveCount(0)
  })

  test('Sign in opens the login page in place, without reloading the page', async ({ page }) => {
    await signedOut(page, 'light')
    await page.goto('/')
    // A marker on the window survives an in-app page switch and is lost on a reload.
    await page.evaluate(() => ((window as unknown as { stayed?: boolean }).stayed = true))
    await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Password')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true)
  })
})
