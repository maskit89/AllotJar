import { expect, test } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * OS-live theme switching (docs/testing/cases/26-ux-states.md, the UX-030 family).
 * The contract split across theme-init.js (pre-paint) and lib/theme.ts (live, shared by every
 * theme control: the top bar's Dark mode button, the account menu's and More sheet's switches):
 *
 *  - while `zbb.theme` is UNSET ("system" mode), the app follows the OS
 *    `prefers-color-scheme` — both at first paint and LIVE mid-session via the
 *    ThemeToggle's matchMedia change listener;
 *  - once the user pins a theme via a real theme control (which persists `zbb.theme`), OS
 *    scheme changes are ignored — live AND across a reload.
 *
 * Driven with page.emulateMedia({ colorScheme }) mid-session (which fires the
 * matchMedia change event in Chromium) and the top bar's real Dark mode button — no direct
 * localStorage pokes for the pinning step. Follows keyboard-a11y.spec.ts's
 * patterns: authedSetup stubs, role-based locators, expect-polling, no sleeps.
 */

const html = (page: import('@playwright/test').Page) => page.locator('html')
// The top bar's theme control on desktop: one toggle button named "Dark mode" (aria-pressed).
const darkMode = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Dark mode', exact: true })

// System mode (no stored choice): the root .dark class tracks the OS scheme
// live — dark stamps it, light removes it, repeatedly, without a reload.
test('system mode follows the OS colour-scheme live (UX-030)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await authedSetup(page, 'system') // leaves zbb.theme unset
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // First paint followed the (light) OS: no .dark on the root, Dark mode not pressed.
  await expect(html(page)).not.toHaveClass(/dark/)
  await expect(darkMode(page)).toHaveAttribute('aria-pressed', 'false')

  // The OS flips to dark mid-session → the app (and the control) follows live.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveClass(/dark/)
  await expect(darkMode(page)).toHaveAttribute('aria-pressed', 'true')

  // And back to light — still following, still no reload.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).not.toHaveClass(/dark/)

  // Nothing was persisted: the user never chose, so system mode remains active.
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBeNull()
})

// Pinning a theme via the real Dark mode button persists the choice; OS flips no
// longer change the applied theme — neither live nor on the next load.
test('a theme pinned via the Dark mode button ignores OS colour-scheme flips (UX-030)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await authedSetup(page, 'system')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await expect(html(page)).not.toHaveClass(/dark/)

  // Pin DARK through the real control (writes zbb.theme = 'dark').
  await darkMode(page).click()
  await expect(html(page)).toHaveClass(/dark/)
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBe('dark')

  // The OS flips to light — the pinned dark choice wins; .dark stays stamped.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveClass(/dark/)
  await expect(darkMode(page)).toHaveAttribute('aria-pressed', 'true')

  // Another flip cycle for good measure — still pinned.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveClass(/dark/)

  // The pin also survives a cold load under a contrary OS scheme: theme-init.js
  // reads the stored 'dark' before first paint and ignores the light OS.
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await expect(html(page)).toHaveClass(/dark/)
})

// The signed-out screens (restyle PR 9) carry the app's own theme button in the green room: one
// "Dark mode" toggle (aria-pressed), as in the top bar. It follows the OS live until pressed, and a
// press pins the choice.
test('the sign-in page Dark mode button follows the OS until a press pins it (UX-013, UX-030)', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'No session.' }) }),
  )
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/login')
  const dark = darkMode(page)
  await expect(dark).toBeVisible()
  await expect(dark).toHaveAttribute('aria-pressed', 'false')

  // Nothing pinned: the OS flips the page and the button with it.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveClass(/dark/)
  await expect(dark).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBeNull()

  // A keyboard press turns dark mode off and pins light; OS flips are ignored from then on.
  await dark.focus()
  await page.keyboard.press('Enter')
  await expect(html(page)).not.toHaveClass(/dark/)
  await expect(dark).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBe('light')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).not.toHaveClass(/dark/)
})
