import { expect, test, type Page } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * The Allocation page's restyle (PR 10), in a real browser on the mocked API (e2e/mocks.ts): the
 * warnings as short strips with their sentence behind an (i), the "+ Link account" picker (a menu,
 * a bottom sheet on a phone), and the two dialogs' focus, Tab trap and Escape, and how the
 * Allocate dialog fits a 375x667 phone as a bottom sheet with a scrolling middle.
 *
 * The mocked month: a pool of €8,000.75 against a budget whose income is €3,000 (the mismatch note)
 * and which leaves €1,700 unassigned while the allocation promises €500 of pocket money and
 * €2,000.75 of savings (the "disagree" warning). Alex saves into Savings Joint (acc1); Sam's
 * account (acc2) isn't in the account list.
 */

/** Sam with no savings account, and Sam Savings among the accounts (the picker's suggestion). */
async function samWithoutSavings(page: Page) {
  await page.route(/\/api\/allocation\/preview\/\d+\/\d+$/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        pool: 8000.75, envelopesTotal: 3500, jarsTotal: 2000, transfersCreated: 0,
        steps: [
          { type: 0, total: 3500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1750 }, { memberId: 'm2', name: 'Sam', amount: 1750 }] },
          { type: 1, total: 2000, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1000 }, { memberId: 'm2', name: 'Sam', amount: 1000 }] },
          { type: 2, total: 500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 250 }, { memberId: 'm2', name: 'Sam', amount: 250 }] },
          { type: 3, total: 2000.75, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1250.47 }, { memberId: 'm2', name: 'Sam', amount: 750.28 }] },
        ],
        members: [
          { memberId: 'm1', name: 'Alex', netIncome: 4200.5, residual: 1250.47, savingsBalance: 30000, savingsAccountId: 'acc1' },
          { memberId: 'm2', name: 'Sam', netIncome: 3800.25, residual: 750.28, savingsBalance: null, savingsAccountId: null },
        ],
      }),
    }),
  )
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 1000, currentBalance: 1200, displayOrder: 0 },
        { id: 'acc1', name: 'Savings Joint', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 5000, displayOrder: 1 },
        { id: 'acc3', name: 'Sam Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 2 },
      ]),
    }),
  )
}

/** Alex's and Sam's savings accounts hold jars, so the Allocate dialog asks how each share is divided. */
async function alexHasJars(page: Page) {
  await page.route(/\/api\/jars\/ledger/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          accountId: 'acc1', accountName: 'Savings Joint', currency: 'EUR', asOf: '2026-06-01', accountBalance: 5000,
          unallocated: 1000, positiveAllocations: 4000, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
          jars: [
            { jarId: 'j1', name: 'Holiday', balance: 1000, isArchived: false },
            { jarId: 'j2', name: 'Car', balance: 1500, isArchived: false },
            { jarId: 'j3', name: 'Emergency fund', balance: 1200, isArchived: false },
            { jarId: 'j4', name: 'Gifts', balance: 300, isArchived: false },
          ],
        },
        {
          accountId: 'acc2', accountName: 'Sam Pot', currency: 'EUR', asOf: '2026-06-01', accountBalance: 3000,
          unallocated: 1000, positiveAllocations: 2000, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
          jars: [
            { jarId: 'j5', name: 'Bike', balance: 800, isArchived: false },
            { jarId: 'j6', name: 'Travel', balance: 1200, isArchived: false },
          ],
        },
      ]),
    }),
  )
}

/** Longer, ordinary names: the accounts, and a person with no savings account. */
async function longNames(page: Page) {
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'acc0', name: 'Joint current account', type: 0, currency: 'EUR', openingBalance: 1000, currentBalance: 1200, displayOrder: 0 },
        { id: 'acc1', name: 'Alex’s rainy-day savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 5000, displayOrder: 1 },
      ]),
    }),
  )
}

/** Is every corner of the open (i)'s popover on screen and on top (not cut off by a scrolling box)? */
async function tooltipFullyShown(page: Page) {
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  return tip.evaluate((t) => {
    const r = t.getBoundingClientRect()
    const hit = (x: number, y: number) => {
      const e = document.elementFromPoint(x, y)
      return !!e && (e === t || t.contains(e))
    }
    return [hit(r.left + 3, r.top + 3), hit(r.right - 3, r.top + 3), hit(r.left + 3, r.bottom - 3), hit(r.right - 3, r.bottom - 3)]
  })
}

async function openAllocation(page: Page) {
  await page.goto('/allocation')
  await page.getByRole('heading', { level: 1, name: 'Allocation' }).waitFor()
  await page.getByRole('list', { name: /^How \w+ is allocated$/ }).waitFor()
}

/** The month the page shows (the Allocate button is named "Allocate {month}"). */
async function allocateButton(page: Page) {
  return page.getByRole('button', { name: /^Allocate \w+$/ })
}

test.describe('Allocation (restyle PR 10)', () => {
  test('each warning is a short strip; its (i) holds the full sentence, opens on hover or focus and closes on Escape', async ({ page }) => {
    await authedSetup(page, 'light')
    await openAllocation(page)

    const disagree = page.locator('[data-strip="disagree"]')
    await expect(disagree).toContainText(/^Budget and allocation disagree by €800\.75/)
    await expect(disagree.getByRole('button', { name: /^Add pocket money to \w+'s budget$/ })).toBeVisible()
    const mismatch = page.locator('[data-strip="mismatch"]')
    await expect(mismatch).toHaveText('Income here doesn’t match the budget')

    // Hover: the full sentence.
    await mismatch.getByRole('button', { name: 'About the income here' }).hover()
    await expect(page.getByRole('tooltip')).toContainText(
      /pooled income here \(€8,000\.75\) doesn’t match \w+’s budgeted income lines \(€3,000\.00\)/,
    )
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    // Keyboard: focus opens it, Escape closes it and keeps focus on the (i).
    const about = disagree.getByRole('button', { name: 'About the budget and the allocation' })
    await about.focus()
    await expect(page.getByRole('tooltip')).toContainText('Your budget and your allocation disagree.')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(about).toBeFocused()

    // Strips aren't live regions (only the "Allocated" and "added" lines and the no-income notice are).
    await expect(disagree).not.toHaveAttribute('role')
  })

  test('the strip and the cards sit in their places: KPIs, Allocate in the top bar, Steps beside Savings', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await authedSetup(page, 'light')
    await openAllocation(page)

    const topBar = page.locator('header[data-tour="topbar"]')
    await expect(topBar.getByRole('button', { name: /^Allocate \w+$/ })).toHaveText('Allocate')
    const steps = await page.getByRole('region', { name: 'Steps' }).boundingBox()
    const savings = await page.getByRole('region', { name: 'Savings' }).boundingBox()
    expect(steps && savings && savings.x > steps.x + steps.width - 1 && Math.abs(savings.y - steps.y) < 2).toBe(true)
  })

  test('Link account: a menu from the dashed chip, named for the person; Escape returns to the chip; the keyboard picks', async ({ page }) => {
    await authedSetup(page, 'light')
    await samWithoutSavings(page)
    let put: unknown = null
    await page.route('**/api/members/m2', async (route) => {
      put = route.request().postDataJSON()
      await route.fulfill({ contentType: 'application/json', body: '{}' })
    })
    await openAllocation(page)

    const row = page.getByRole('list', { name: 'Savings by person' }).getByRole('listitem').filter({ hasText: 'Sam' })
    await expect(row).toContainText('Stays in Joint Current')
    const chip = row.getByRole('button', { name: 'Link account for Sam’s savings' })
    await expect(chip).toHaveText('Link account')

    await chip.click()
    const menu = page.getByRole('menu', { name: 'Savings account for Sam' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['Use “Sam Savings”', 'Savings Joint', 'Joint Current'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(chip).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Use “Sam Savings”' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => put).toMatchObject({ name: 'Sam', personalSavingsAccountId: 'acc3' })
  })

  test('Link account on a phone: the chip opens a bottom sheet titled for the person', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await authedSetup(page, 'light')
    await samWithoutSavings(page)
    await openAllocation(page)

    await page.getByRole('button', { name: 'Link account for Sam’s savings' }).click()
    const sheet = page.getByRole('dialog', { name: 'Savings account for Sam' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Use “Sam Savings”' })).toBeVisible()
    const box = await sheet.boundingBox()
    expect(box && box.y + box.height <= 667 + 1).toBe(true)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  })

  test('the Allocate dialog: focus on Close, Tab stays inside, the title’s (i) closes alone, Escape returns to Allocate', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await authedSetup(page, 'light')
    await openAllocation(page)

    const allocate = await allocateButton(page)
    await allocate.click()
    const dialog = page.getByRole('dialog', { name: /^Record \w+’s transfers$/ })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    // Tab walks the dialog and wraps: it never reaches the page behind.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

    // The (i) after the title: its hint opens on focus, and Escape closes the hint alone.
    await dialog.getByRole('button', { name: 'About recording the transfers' }).focus()
    await expect(page.getByRole('tooltip')).toContainText('stays in transit until you confirm its receipt')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(allocate).toBeFocused()
  })

  test('the Allocate dialog fits a 375x667 phone: a bottom sheet with its actions in view and a scrolling middle', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await authedSetup(page, 'light')
    await alexHasJars(page)
    await openAllocation(page)

    // Below 900px the Allocate pill sits under the KPI row, at the right.
    const allocate = await allocateButton(page)
    await expect(page.locator('header[data-tour="topbar"]').getByRole('button', { name: /^Allocate / })).toHaveCount(0)
    await allocate.click()
    const dialog = page.getByRole('dialog', { name: /^Record \w+’s transfers$/ })
    await expect(dialog).toBeVisible()
    // The grab handle is the sheet's one Close, and it has focus.
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(dialog.getByRole('group', { name: 'Put into jars in Savings Joint' })).toBeAttached()
    await expect(dialog.getByRole('group', { name: 'Put into jars in Sam Pot' })).toBeAttached()

    const box = (await dialog.boundingBox())!
    expect(box.x).toBeLessThanOrEqual(0.5)
    expect(box.width).toBeGreaterThanOrEqual(374)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(667.5)
    // The actions stay in view; the middle scrolls.
    for (const control of [
      dialog.getByRole('button', { name: 'Record transfers' }),
      dialog.getByRole('button', { name: 'Cancel' }),
      dialog.getByRole('checkbox', { name: 'I’ve completed these transfers' }),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 })
    }
    const middle = dialog.locator('.sheet-dlg-body')
    expect(await middle.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await dialog.getByLabel('Amount for Travel').scrollIntoViewIfNeeded()
    await expect(dialog.getByLabel('Amount for Travel')).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Record transfers' })).toBeInViewport({ ratio: 1 })
    // Touch targets: 44px on a phone.
    expect((await dialog.getByRole('button', { name: 'Record transfers' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await dialog.getByLabel('Amount for Gifts').boundingBox())!.height).toBeGreaterThanOrEqual(40)

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(allocate).toBeFocused()
  })

  test('the settings dialog: focus on Close, Escape closes it back to Settings; on a phone it is a sheet that fits', async ({ page }) => {
    await authedSetup(page, 'light')
    await openAllocation(page)

    const settings = page.getByRole('button', { name: 'Allocation settings', exact: true })
    await settings.click()
    const dialog = page.getByRole('dialog', { name: 'Allocation settings' })
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(dialog.getByLabel('Pocket money per member')).toHaveValue('250')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(settings).toBeFocused()

    await page.setViewportSize({ width: 375, height: 667 })
    await settings.click()
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(667.5)
    await expect(dialog.getByRole('button', { name: 'Save allocation settings' })).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByLabel('Balance lean percent')).toBeInViewport()
  })

  test('the Allocate sheet never grows past a narrow phone: long names truncate, and the amounts, jar fields and actions stay in view', async ({ page }) => {
    await authedSetup(page, 'light')
    await longNames(page)
    await alexHasJars(page)
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 700 })
      await openAllocation(page)
      await (await allocateButton(page)).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const box = (await dialog.boundingBox())!
      expect(box.x, `${width}`).toBeGreaterThanOrEqual(-0.5)
      expect(box.width, `${width}`).toBeLessThanOrEqual(width + 0.5)
      expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1), `${width}`).toBe(true)
      // Who moves what: the amounts whole, the long account names cut short instead.
      await expect(dialog.getByRole('list', { name: 'Transfers' }).getByText('€1,250.47', { exact: true })).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByText('Joint current account', { exact: true }).first()).toHaveCSS('text-overflow', 'ellipsis')
      for (const control of [
        dialog.getByRole('button', { name: 'Record transfers' }),
        dialog.getByRole('button', { name: /^Sent today/ }),
        dialog.getByRole('checkbox', { name: 'I’ve completed these transfers' }),
      ]) {
        await expect(control, `${width}`).toBeInViewport({ ratio: 1 })
      }
      const amount = dialog.getByLabel('Amount for Holiday')
      await amount.scrollIntoViewIfNeeded()
      await expect(amount, `${width}`).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  })

  test('an (i) inside a sheet is never cut off by its scrolling middle (the stayer’s reason, the settings hints)', async ({ page }) => {
    await authedSetup(page, 'light')
    await samWithoutSavings(page)
    for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(size)
      await openAllocation(page)
      await (await allocateButton(page)).click()
      const dialog = page.getByRole('dialog', { name: 'Allocate without Sam?' })
      await dialog.getByRole('button', { name: 'About Sam’s share' }).focus()
      await expect(page.getByRole('tooltip')).toContainText('no savings account linked')
      expect(await tooltipFullyShown(page), `stayer ${size.width}`).toEqual([true, true, true, true])
      await expect(page.getByRole('tooltip')).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      await page.getByRole('button', { name: 'Allocation settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Allocation settings' })
      for (const name of ['About the source account', 'About splitting shared costs', 'About the savings split', 'About balance lean']) {
        await settings.getByRole('button', { name }).focus()
        expect(await tooltipFullyShown(page), `${name} ${size.width}`).toEqual([true, true, true, true])
      }
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
    }
  })

  test('on a 375x667 phone the Steps (i) opens clear of the tab bar, and the pocket-money step keeps its whole name', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await authedSetup(page, 'light')
    await openAllocation(page)
    const name = page.getByRole('list', { name: /^How \w+ is allocated$/ }).getByText('Pocket money', { exact: true })
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.getByRole('button', { name: 'About the steps' }).focus()
    const tip = (await page.getByRole('tooltip').boundingBox())!
    const bar = (await page.locator('[data-tabbar]').boundingBox())!
    expect(tip.y + tip.height).toBeLessThanOrEqual(bar.y + 0.5)
    expect(tip.y).toBeGreaterThanOrEqual(0)
  })

  test('Record transfers unticked after scrolling the phone sheet: the message comes into view and the box is marked', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await authedSetup(page, 'light')
    await alexHasJars(page)
    await openAllocation(page)
    await (await allocateButton(page)).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount for Travel').scrollIntoViewIfNeeded()
    expect(await dialog.locator('.sheet-dlg-body').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Record transfers' }).click()
    const alert = dialog.getByRole('alert')
    await expect(alert).toContainText('Confirm that you’ve completed these transfers before recording them.')
    await expect(alert).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByRole('checkbox', { name: 'I’ve completed these transfers' })).toHaveAttribute('aria-invalid', 'true')
  })

  test('in a contrast theme (forced colors) the dialogs’ fields keep an edge, and focus shows an outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await authedSetup(page, 'light')
    await openAllocation(page)
    await page.getByRole('button', { name: 'Allocation settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Allocation settings' })
    const field = dialog.locator('.dlg-in').first()
    await expect(field).toHaveCSS('border-top-style', 'solid')
    await expect(field).toHaveCSS('border-top-width', '1px')
    await dialog.getByLabel('Pocket money per member').focus()
    await expect(field).toHaveCSS('outline-style', 'solid')
    const select = dialog.getByLabel('Source account', { exact: true })
    await expect(select).toHaveCSS('border-top-width', '1px')
    await select.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(select).toBeFocused()
    await expect(select).toHaveCSS('outline-style', 'solid')
  })
})
