import { expect, test } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * OS-live theme switching (docs/testing/cases/26-ux-states.md, the UX-030 family).
 * The contract split across theme-init.js (pre-paint) and ThemeToggle.tsx (live):
 *
 *  - while `zbb.theme` is UNSET ("system" mode), the app follows the OS
 *    `prefers-color-scheme` — both at first paint and LIVE mid-session via the
 *    ThemeToggle's matchMedia change listener;
 *  - once the user pins Light/Dark via the real ThemeToggle (which persists
 *    `zbb.theme`), OS scheme changes are ignored — live AND across a reload.
 *
 * Driven with page.emulateMedia({ colorScheme }) mid-session (which fires the
 * matchMedia change event in Chromium) and the real toggle buttons — no direct
 * localStorage pokes for the pinning step. Follows keyboard-a11y.spec.ts's
 * patterns: authedSetup stubs, role-based locators, expect-polling, no sleeps.
 */

const html = (page: import('@playwright/test').Page) => page.locator('html')
const themeGroup = (page: import('@playwright/test').Page) =>
  page.getByRole('group', { name: 'Theme' })

// System mode (no stored choice): the root .dark class tracks the OS scheme
// live — dark stamps it, light removes it, repeatedly, without a reload.
test('system mode follows the OS colour-scheme live (UX-030)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await authedSetup(page, 'system') // leaves zbb.theme unset
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // First paint followed the (light) OS: no .dark on the root, toggle shows Light.
  await expect(html(page)).not.toHaveClass(/dark/)
  await expect(themeGroup(page).getByRole('button', { name: 'Light mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // The OS flips to dark mid-session → the app follows live.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveClass(/dark/)
  await expect(themeGroup(page).getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // And back to light — still following, still no reload.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).not.toHaveClass(/dark/)

  // Nothing was persisted: the user never chose, so system mode remains active.
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBeNull()
})

// Pinning a theme via the real ThemeToggle persists the choice; OS flips no
// longer change the applied theme — neither live nor on the next load.
test('a theme pinned via the ThemeToggle ignores OS colour-scheme flips (UX-030)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await authedSetup(page, 'system')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await expect(html(page)).not.toHaveClass(/dark/)

  // Pin DARK through the real control (writes zbb.theme = 'dark').
  await themeGroup(page).getByRole('button', { name: 'Dark mode' }).click()
  await expect(html(page)).toHaveClass(/dark/)
  expect(await page.evaluate(() => localStorage.getItem('zbb.theme'))).toBe('dark')

  // The OS flips to light — the pinned dark choice wins; .dark stays stamped.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveClass(/dark/)
  await expect(themeGroup(page).getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

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
