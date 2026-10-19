import { expect, test, type Page } from '@playwright/test'
import { authedSetup, FLAGS } from './mocks'

/**
 * The banners and blocking prompts in the approved warm look (restyle PR 17): one line each on a
 * status tone, the analytics consent banner above the phone tab bar and within the desktop content
 * column, and the two blocking prompts that nothing but their own actions can close.
 */

const ME = {
  userId: 'u1', email: 'e2e@allotjar.app', displayName: 'Alex', role: 0, ownerId: 'u1', memberId: null,
  needsConsent: false, emailConfirmed: true, preferredCurrency: 'EUR', budgetCurrency: 'EUR', currencyLocked: true,
  households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
}

async function signedIn(page: Page, me: Record<string, unknown> = {}) {
  await authedSetup(page, 'light')
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...ME, ...me }) }),
  )
}

/** The banner's text is a single sentence (no second one), and it stands on a tone. */
async function expectOneLine(page: Page, text: string, tone: string) {
  const line = page.getByText(text, { exact: true })
  await expect(line).toBeVisible()
  const banner = line.locator('xpath=ancestor::*[@data-tone][1]')
  await expect(banner).toHaveAttribute('data-tone', tone)
  const words = (await banner.innerText()).replace(/\s+/g, ' ').trim()
  expect(words.startsWith(text), `${words} is more than the one line`).toBe(true)
}

test.describe('the app banners: one line each on a tone', () => {
  test('verify email (warn), the address behind the (i), Resend as a quiet action', async ({ page }) => {
    await signedIn(page, { emailConfirmed: false })
    await page.goto('/')
    await expectOneLine(page, 'Confirm your email: check your inbox for the link.', 'warn')
    await expect(page.getByText('e2e@allotjar.app')).toHaveCount(0)
    await page.getByRole('button', { name: 'About confirming your email' }).focus()
    await expect(page.getByRole('tooltip')).toContainText('e2e@allotjar.app')
    const resend = page.getByRole('button', { name: 'Resend' })
    await expect(resend).toBeVisible()
    // Quiet: not the page's green primary.
    const bg = await resend.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  })

  test('the household greeting (ok, dismissible) and the read-only line (info, with its (i))', async ({ page }) => {
    await signedIn(page, { role: 3, households: [{ ownerId: 'u2', label: 'Sam', role: 3, isActive: true, isOwn: false }] })
    await page.goto('/?joined=1')
    await expectOneLine(page, 'You’ve joined the household.', 'ok')
    await expect(page).toHaveURL(/\/$/)
    await expectOneLine(page, 'Read-only access: you can view everything, not change it.', 'info')
    await page.getByRole('button', { name: 'About your access' }).focus()
    await expect(page.getByRole('tooltip')).toContainText('nothing here can be added, changed or deleted by you')
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByText('You’ve joined the household.')).toHaveCount(0)
    await expect(page.getByText('Read-only access: you can view everything, not change it.')).toBeVisible()
  })

  test('the limited line (warn) and the sharing review (info) with its sheet dialog', async ({ page }) => {
    await signedIn(page, { role: 2, sharingReviewPending: true, households: [{ ownerId: 'u2', label: 'Sam', role: 2, isActive: true, isOwn: false }] })
    await page.route('**/api/accounts/sharing-review', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: true,
          accounts: [
            { id: 'acc1', name: 'Savings Joint', isPrivate: false, sharingBlockedReason: null },
            { id: 'acc3', name: 'Holiday pot', isPrivate: false, sharingBlockedReason: 'A jar uses this account, so everyone sees it.' },
          ],
        }),
      }),
    )
    await page.goto('/')
    await expectOneLine(page, 'Limited access: you can record transactions, mark bills paid and run allocation.', 'warn')
    await expectOneLine(page, 'Review who sees your accounts.', 'info')
    await page.getByRole('button', { name: 'Review sharing' }).click()
    const dialog = page.getByRole('dialog', { name: 'Who sees your accounts' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('A private account is seen only by you')).toHaveCount(0)
    await expect(dialog.getByRole('checkbox', { name: 'Keep Savings Joint private' })).toBeEnabled()
    await expect(dialog.getByRole('checkbox', { name: 'Keep Holiday pot private' })).toBeDisabled()
    await expect(dialog.getByText('A jar uses this account, so everyone sees it.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await expect(dialog).toHaveCount(0)
  })
})

test.describe('the analytics consent banner', () => {
  // The analytics flag on (after authedSetup's catch-all route, so this one answers /features).
  const withAnalytics = (page: Page) =>
    page.route('**/api/features', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...FLAGS, analytics: true }) }),
    )

  test('on a phone it sits above the tab bar, never over it, and lets the tabs be tapped', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signedIn(page)
    await withAnalytics(page)
    await page.goto('/')
    const region = page.getByRole('region', { name: 'Analytics consent' })
    await expectOneLine(page, 'We use Google Analytics for anonymous usage only; change it under Help.', 'info')
    const card = region.locator('[data-tone]')
    const tabbar = page.locator('[data-tabbar]')
    // Measure only once Hanken Grotesk has swapped in: the line re-wraps when it does (CI 937's race).
    await page.evaluate(() => document.fonts.ready.then(() => true))
    const cardBox = (await card.boundingBox())!
    const tabBox = (await tabbar.boundingBox())!
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(tabBox.y)
    // The tab bar is still usable under the pinned wrapper.
    await tabbar.getByRole('link', { name: 'Jars' }).click()
    await expect(page).toHaveURL(/\/jars$/)
    await expect(region).toBeVisible()
    // The room it publishes for the Help page is the whole wrapper, the tab bar's room included.
    // --consent-h follows the box on the next ResizeObserver callback, so poll until they agree.
    await page.evaluate(() => document.fonts.ready.then(() => true))
    await expect
      .poll(async () => {
        const box = (await region.boundingBox())!
        const published = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--consent-h'))
        return published === `${Math.ceil(box.height)}px`
      })
      .toBe(true)
    const regionBox = (await region.boundingBox())!
    expect(regionBox.height).toBeGreaterThan(cardBox.height + tabBox.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('on a desktop it keeps to the content column, clear of the sidebar and its Help item', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await signedIn(page)
    await withAnalytics(page)
    await page.goto('/')
    const region = page.getByRole('region', { name: 'Analytics consent' })
    const card = region.locator('[data-tone]')
    await expect(card).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => true))
    const cardBox = (await card.boundingBox())!
    const sidebar = (await page.locator('[data-sidebar]').boundingBox())!
    expect(cardBox.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width)
    const help = page.locator('[data-sidebar]').getByRole('link', { name: 'Help' })
    await expect(help).toBeVisible()
    await help.click()
    await expect(page).toHaveURL(/\/help$/)
    // Neither button is a green primary (the Dashboard has its own).
    for (const name of ['Decline', 'Accept']) {
      const bg = await region.getByRole('button', { name }).evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(bg, name).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    }
  })
})

test.describe('the blocking prompts', () => {
  for (const [name, me, title, primary] of [
    ['consent', { needsConsent: true }, 'Accept the terms', 'I agree'],
    ['password', { mustChangePassword: true }, 'Choose a new password', 'Email me the link'],
  ] as const) {
    test(`${name}: a sheet nothing closes but its own actions, on a phone and a desktop`, async ({ page }) => {
      await signedIn(page, me)
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: title })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: /^close$/i })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: primary })).toBeFocused()
      await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      // The scrim: a click at the top-left corner of the screen, outside the sheet.
      await page.mouse.click(8, 8)
      await expect(dialog).toBeVisible()
      // The why sits behind the (i), and the body is one short line.
      await dialog.getByRole('button', { name: 'Why you are asked' }).focus()
      await expect(page.getByRole('tooltip')).toBeVisible()

      await page.setViewportSize({ width: 390, height: 844 })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: /^close$/i })).toHaveCount(0)
      await page.mouse.click(8, 8)
      await expect(dialog).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    })
  }

  test('consent: the legal links open the pages in a new tab, where the prompt steps aside', async ({ page }) => {
    await signedIn(page, { needsConsent: true })
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: 'Accept the terms' })
    await expect(dialog.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('target', '_blank')
    await page.goto('/terms')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
