import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * The Account settings page's restyle (PR 12), in a real browser on the mocked API (e2e/mocks.ts):
 * two columns on a wide screen (you and your preferences; Household and Sign-in), one on a phone;
 * the pencil that turns the name into fields; the Change password dialog (focus, Tab trap, Enter,
 * Escape, and the 375x667 bottom sheet); the ⋯ menus (Leave household, Disconnect disabled with
 * its reason) and the Leave dialog; and no WCAG A/AA violations with a menu or a dialog open.
 *
 * The mocked owner is Alex (e2e@allotjar.app): a password, no Google, the currency locked (EUR),
 * two people. `asSam` signs in as Sam instead: an Admin in Alex's household with no budget of his
 * own, who signs in with Google only.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function expectNoViolations(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}`).join('\n')
  expect(violations, summary).toEqual([])
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

/** Sam: Admin in Alex's household, no budget of his own, Google only, currency not locked. */
async function asSam(page: Page, privateAccounts = 0) {
  await page.addInitScript(() => {
    localStorage.setItem('zbb.onboarding:sam@example.eu', JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true }))
  })
  await page.route(/\/api\/auth\/me$/, (route) =>
    route.fulfill(
      json({
        userId: 'u2', email: 'sam@example.eu', displayName: 'Sam', firstName: 'Sam', lastName: null, role: 1, ownerId: 'u1',
        memberId: 'm2', needsConsent: false, preferredCurrency: 'EUR', budgetCurrency: 'EUR', ownBudgetCurrency: 'EUR',
        currencyLocked: false, numberFormat: 'comma-dot', hasPassword: false, hasGoogle: true, emailConfirmed: true,
        households: [{ ownerId: 'u1', label: 'Alex', role: 1, isActive: true, isOwn: false }],
      }),
    ),
  )
  await page.route(/\/api\/households\/leave-preview/, (route) => route.fulfill(json({ privateAccounts })))
}

async function openAccount(page: Page) {
  await page.goto('/account')
  await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign-in', exact: true })).toBeVisible()
  // Widths are measured in the page's own font, not the wider fallback drawn while it loads.
  await page.evaluate(() => document.fonts.ready.then(() => true))
}

test.describe('Account settings', () => {
  test('two columns on a wide screen, one on a phone; one green button, Save', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await openAccount(page)

    const you = page.getByRole('region', { name: 'Your account' })
    const household = page.getByRole('region', { name: 'Household' })
    const signIn = page.getByRole('region', { name: 'Sign-in' })
    await expect(household).toBeVisible()
    const a = (await you.boundingBox())!
    const h = (await household.boundingBox())!
    const s = (await signIn.boundingBox())!
    // Left column wider (the Dashboard's 1.55 : 1), Household above Sign-in on the right.
    expect(h.x).toBeGreaterThan(a.x + a.width)
    expect(a.width / h.width).toBeGreaterThan(1.4)
    expect(Math.abs(h.y - a.y)).toBeLessThan(2)
    expect(s.y).toBeGreaterThan(h.y + h.height)
    // Save is the page's only primary (green) button, named "Save preferences" with the word "Save".
    const save = page.getByRole('button', { name: 'Save preferences' })
    await expect(save).toHaveText('Save')
    const greens = await page.locator('main button, main a').evaluateAll((els) =>
      els.filter((el) => getComputedStyle(el).backgroundColor === getComputedStyle(document.querySelector('[aria-label="Save preferences"]')!).backgroundColor).length,
    )
    expect(greens).toBe(1)

    await page.setViewportSize({ width: 390, height: 844 })
    const a2 = (await you.boundingBox())!
    const h2 = (await household.boundingBox())!
    const s2 = (await signIn.boundingBox())!
    expect(Math.abs(a2.x - h2.x)).toBeLessThan(1)
    expect(h2.y).toBeGreaterThan(a2.y + a2.height)
    expect(s2.y).toBeGreaterThan(h2.y + h2.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // A finger's Save: full width of its card, 44px tall.
    const box = (await save.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
  })

  test('the pencil: the name becomes First name and Last name, focus in First name; Escape puts it back on the pencil', async ({ page }) => {
    await authedSetup(page, 'light')
    await openAccount(page)

    const pencil = page.getByRole('button', { name: 'Edit name' })
    await pencil.click()
    await expect(page.getByLabel('First name')).toBeFocused()
    await expect(page.getByLabel('Last name')).toBeVisible()
    await page.keyboard.type('Sasha')
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('First name')).toHaveCount(0)
    await expect(pencil).toBeFocused()
    await expect(page.getByRole('heading', { level: 2, name: 'Alex' })).toBeVisible()
  })

  test('Change password: focus on Close, Tab stays inside, Enter submits, Escape returns to “Change”', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await authedSetup(page, 'light')
    await openAccount(page)

    const change = page.getByRole('button', { name: 'Change password' })
    await expect(change).toHaveText('Change')
    await change.click()
    const dialog = page.getByRole('dialog', { name: 'Change password' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

    // New password and Confirm sit side by side on a wide screen.
    const next = (await dialog.getByLabel('New password', { exact: true }).boundingBox())!
    const confirm = (await dialog.getByLabel('Confirm new password').boundingBox())!
    expect(Math.abs(next.y - confirm.y)).toBeLessThan(1)

    // Enter in a field submits the dialog's form (its submit sits in the footer), with today's checks.
    await dialog.getByLabel('Current password').fill('oldpassword')
    await dialog.getByLabel('New password', { exact: true }).fill('newpassword1')
    await dialog.getByLabel('Confirm new password').fill('different1')
    await dialog.getByLabel('Confirm new password').press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText('The new passwords do not match.')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(change).toBeFocused()
  })

  // A refused request re-enables the dialog's button; while it worked, the button stayed focusable
  // (aria-disabled), so the focus is still in the dialog: Tab is trapped and Escape closes it.
  test('a refused change keeps the focus in the dialog: Tab stays inside and Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await authedSetup(page, 'light')
    await page.route(/\/api\/auth\/change-password$/, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Your current password is incorrect.' }) }),
    )
    await openAccount(page)

    const change = page.getByRole('button', { name: 'Change password' })
    await change.click()
    const dialog = page.getByRole('dialog', { name: 'Change password' })
    await dialog.getByLabel('Current password').fill('wrong-password')
    await dialog.getByLabel('New password', { exact: true }).fill('Aa1-fresh-key')
    await dialog.getByLabel('Confirm new password').fill('Aa1-fresh-key')
    const submit = dialog.getByRole('button', { name: 'Change password' })
    await submit.click()
    await expect(dialog.getByRole('alert')).toHaveText('Your current password is incorrect.')
    await expect(submit).toBeFocused()
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(change).toBeFocused()
  })

  for (const status of [500, 409]) {
    test(`a refused leave (${status}) keeps the focus in the dialog: Escape closes it`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await authedSetup(page, 'light')
      await asSam(page)
      await page.route(/\/api\/households\/leave$/, (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(status === 409 ? { error: 'You keep 1 private account in this household.', privateAccounts: 1 } : {}),
        }),
      )
      await openAccount(page)

      const more = page.getByRole('button', { name: 'Household: more actions' })
      await more.click()
      await page.getByRole('menuitem', { name: 'Leave household' }).click()
      const dialog = page.getByRole('dialog', { name: 'Leave Alex’s household?' })
      const leave = dialog.getByRole('button', { name: 'Yes, leave' })
      await leave.click()
      await expect(dialog.getByRole('alert')).toContainText(
        status === 409 ? 'You keep 1 private account in this household.' : 'Could not leave this household. Please try again.',
      )
      await expect(leave).toBeFocused()
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(more).toBeFocused()
    })
  }

  // A real name and email on a phone: never cut. A locked currency whose name doesn't fit the
  // phone's half-width field shows its code and symbol instead; a wide screen shows the name.
  test('a phone shows the whole name, the whole email and the locked currency’s symbol', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await authedSetup(page, 'light')
    await page.route(/\/api\/auth\/me$/, (route) =>
      route.fulfill(
        json({
          userId: 'u1', email: 'christopher.muscat89@example.eu', displayName: 'Christopher Muscat', firstName: 'Christopher',
          lastName: 'Muscat', role: 0, ownerId: 'u1', memberId: null, needsConsent: false, preferredCurrency: 'NZD',
          budgetCurrency: 'NZD', ownBudgetCurrency: 'NZD', currencyLocked: true, numberFormat: 'comma-dot', hasPassword: true,
          hasGoogle: false, emailConfirmed: true,
          households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
        }),
      ),
    )
    await page.addInitScript(() => {
      localStorage.setItem('zbb.onboarding:christopher.muscat89@example.eu', JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true }))
    })
    await openAccount(page)

    const fits = (el: Element) => el.scrollWidth <= el.clientWidth
    const name = page.getByRole('heading', { level: 2, name: 'Christopher Muscat' })
    await expect(name).toBeVisible()
    expect(await name.evaluate(fits)).toBe(true)
    // The access level drops under the name rather than cut it.
    const chip = page.getByText('Owner', { exact: true })
    expect((await chip.boundingBox())!.y).toBeGreaterThan((await name.boundingBox())!.y + 10)
    const email = page.getByText('christopher.muscat89@example.eu')
    await expect(email).toBeVisible()
    expect(await email.evaluate(fits)).toBe(true)

    const currency = page.getByLabel('Currency', { exact: true })
    await expect(currency).toHaveValue('NZD (NZ$)')
    expect(await currency.evaluate(fits)).toBe(true)

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(currency).toHaveValue('New Zealand dollar (NZ$)')
    expect(await currency.evaluate(fits)).toBe(true)
    // On a wide screen the name and its access level share the line.
    expect(Math.abs((await chip.boundingBox())!.y - (await name.boundingBox())!.y)).toBeLessThan(8)
  })

  test('Change password fits a 375x667 phone: a bottom sheet, its two buttons in view and 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await authedSetup(page, 'light')
    await openAccount(page)

    await page.getByRole('button', { name: 'Change password' }).click()
    const dialog = page.getByRole('dialog', { name: 'Change password' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeLessThanOrEqual(0.5)
    expect(box.width).toBeGreaterThanOrEqual(374)
    expect(box.y + box.height).toBeLessThanOrEqual(667.5)
    for (const name of ['Cancel', 'Change password']) {
      const button = dialog.getByRole('button', { name })
      await expect(button).toBeInViewport({ ratio: 1 })
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    // Stacked on a phone.
    const next = (await dialog.getByLabel('New password', { exact: true }).boundingBox())!
    const confirm = (await dialog.getByLabel('Confirm new password').boundingBox())!
    expect(confirm.y).toBeGreaterThan(next.y + next.height)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('a member: Leave household behind the Household ⋯ asks first; Escape returns to the ⋯', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await authedSetup(page, 'light')
    await asSam(page, 1)
    await openAccount(page)

    const more = page.getByRole('button', { name: 'Household: more actions' })
    await more.click()
    await page.getByRole('menuitem', { name: 'Leave household' }).click()
    const dialog = page.getByRole('dialog', { name: 'Leave Alex’s household?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toContainText('You keep 1 private account in this household.')
    await expect(dialog.getByRole('button', { name: 'Yes, leave' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(more).toBeFocused()
  })

  test('Google only: Disconnect is disabled in the ⋯ with why; the Password row offers Set a password', async ({ page }) => {
    await authedSetup(page, 'light')
    await asSam(page)
    await openAccount(page)

    await expect(page.getByRole('link', { name: 'Set a password' })).toHaveAttribute('href', '/forgot-password')
    await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Google: more actions' }).click()
    const menu = page.getByRole('menu')
    const disconnect = menu.getByRole('menuitem', { name: 'Disconnect' })
    await expect(disconnect).toHaveAttribute('aria-disabled', 'true')
    await expect(menu.getByText("Google is your only way to sign in, so it can't be disconnected yet. Set a password first.")).toBeVisible()
    await expect(menu).toHaveAccessibleDescription(/only way to sign in/)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Google: more actions' })).toBeFocused()
  })

  test('320px: no sideways scroll, and the row titles are whole (Set a password drops to its own line)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await authedSetup(page, 'light')
    await asSam(page)
    await openAccount(page)

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    for (const name of ['Your own budget', 'Password', 'Google']) {
      const title = page.getByRole('heading', { name, exact: true })
      await expect(title).toBeVisible()
      // Not cut with an ellipsis: the title's text fits its box.
      expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    const link = page.getByRole('link', { name: 'Set a password' })
    await link.scrollIntoViewIfNeeded()
    await expect(link).toBeInViewport({ ratio: 1 })
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  })

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`no WCAG A/AA violations — ${theme}`, () => {
      test('a member’s page, and its Google ⋯ open', async ({ page }) => {
        await authedSetup(page, theme)
        await asSam(page)
        await openAccount(page)
        await expect(page.getByRole('button', { name: 'Start my own budget' })).toBeVisible()
        await expectNoViolations(page)
        await page.getByRole('button', { name: 'Google: more actions' }).click()
        await expect(page.getByRole('menuitem', { name: 'Disconnect' })).toBeVisible()
        await expectNoViolations(page)
      })

      test('the Change password dialog, with an error', async ({ page }) => {
        await authedSetup(page, theme)
        await openAccount(page)
        await page.getByRole('button', { name: 'Change password' }).click()
        const dialog = page.getByRole('dialog', { name: 'Change password' })
        await dialog.getByLabel('Current password').fill('oldpassword')
        await dialog.getByLabel('New password', { exact: true }).fill('newpassword1')
        await dialog.getByLabel('Confirm new password').fill('different1')
        await dialog.getByRole('button', { name: 'Change password' }).click()
        await expect(dialog.getByRole('alert')).toBeVisible()
        await expectNoViolations(page)
      })

      test('the Leave dialog, with its warning', async ({ page }) => {
        await authedSetup(page, theme)
        await asSam(page, 2)
        await openAccount(page)
        await page.getByRole('button', { name: 'Household: more actions' }).click()
        await page.getByRole('menuitem', { name: 'Leave household' }).click()
        await expect(page.getByRole('dialog').getByRole('alert')).toContainText('You keep 2 private accounts')
        await expectNoViolations(page)
      })

      test('the Delete account dialog, its password entered', async ({ page }) => {
        await authedSetup(page, theme)
        await page.route(/\/api\/auth\/delete-preview$/, (route) =>
          route.fulfill(json({ ownsHousehold: true, othersInHousehold: 0, hasPassword: true })),
        )
        await openAccount(page)
        await page.getByRole('button', { name: 'Delete account' }).click()
        const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
        await expect(dialog.getByText('Your sign-in and your budget go for good.')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Delete for good' })).toHaveAttribute('aria-disabled', 'true')
        await dialog.getByLabel('Your password').fill('hunter22')
        await expect(dialog.getByRole('button', { name: 'Delete for good' })).not.toHaveAttribute('aria-disabled')
        await expectNoViolations(page)
      })

      test('the Delete account dialog while others share the budget', async ({ page }) => {
        await authedSetup(page, theme)
        await page.route(/\/api\/auth\/delete-preview$/, (route) =>
          route.fulfill(json({ ownsHousehold: true, othersInHousehold: 1, hasPassword: true })),
        )
        await openAccount(page)
        await page.getByRole('button', { name: 'Delete account' }).click()
        const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
        await expect(dialog.getByRole('link', { name: 'People' })).toBeVisible()
        await expectNoViolations(page)
      })

      test('the name being edited, on a phone', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await authedSetup(page, theme)
        await openAccount(page)
        await page.getByRole('button', { name: 'Edit name' }).click()
        await expect(page.getByLabel('First name')).toBeFocused()
        await expectNoViolations(page)
      })
    })
  }
})
