import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup, FLAGS, mockApi, mockSignedIn, ONBOARDING_EMAIL } from './mocks'

/** Waits until nothing under `target` is still animating, so axe reads the settled colours. A
 *  cancelled animation (a transition replaced, its node removed) rejects its `finished` promise with
 *  an AbortError, and we only need none still running: allSettled, never all (CI run 963). */
async function animationsSettled(target: Locator) {
  await target.evaluate((el) =>
    Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined),
  )
}

// The WCAG 2.x success criteria we assert against (A + AA, through 2.2).
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function expectNoViolations(page: Page) {
  // Let late content settle, but cap the wait: callers already await the page's key
  // elements before scanning, and an un-mocked third-party beacon (e.g. analytics)
  // can keep the network busy forever, which used to flake this as a 30s timeout.
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}`).join('\n')
  expect(violations, summary).toEqual([])
}

/** Where an open (i) popover sits against its button: inside the screen, centred under it, and right beneath it. */
async function hintPlacement(page: Page, label: string) {
  return page.getByRole('tooltip').evaluate((el, label) => {
    const t = el.getBoundingClientRect()
    const b = document.querySelector(`button[aria-label="${label}"]`)!.getBoundingClientRect()
    return {
      inside: t.left >= 0 && t.top >= 0 && t.right <= window.innerWidth && t.bottom <= window.innerHeight,
      centred: Math.abs(t.left + t.width / 2 - (b.left + b.width / 2)) < 24,
      close: Math.min(Math.abs(t.top - b.bottom), Math.abs(b.top - t.bottom)) < 12,
    }
  }, label)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`a11y — ${theme}`, () => {
    for (const path of AUTHED_ROUTES) {
      test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
        await authedSetup(page, theme)
        await page.goto(path)
        await page.getByRole('heading', { level: 1 }).first().waitFor()
        await expectNoViolations(page)
      })
    }

    // The app frame's menus: the desktop account menu and the phone More sheet, open.
    test('account menu has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      await page.getByRole('button', { name: /account menu/i }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Dark mode' }).waitFor()
      await expectNoViolations(page)
    })

    test('phone More sheet has no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/people')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // Exact: the People cards' ⋯ buttons are named "{name}: more actions".
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('switch', { name: 'Dark mode' }).waitFor()
      // Let the slide-in finish so axe reads the settled colours.
      await animationsSettled(page.getByRole('dialog', { name: 'More', exact: true }))
      await expectNoViolations(page)
    })

    // The Dashboard's row actions (restyle PR 3): a line's ⋯ menu open, and on a phone the
    // line's bottom sheet open.
    test('dashboard line menu has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      await page.getByRole('button', { name: 'Rent: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Mark paid' }).waitFor()
      await expectNoViolations(page)
    })

    test('dashboard phone line sheet has no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      await page.getByRole('button', { name: 'Rent', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'Rent' })
      await sheet.getByRole('button', { name: 'Mark paid' }).waitFor()
      await animationsSettled(sheet)
      await expectNoViolations(page)
    })

    // The review list (restyle PR 14): the rows' editors are sheet dialogs behind each row's ⋯,
    // and the Bank CSV column mapping is the Columns dialog.
    test('import review list has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/import')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // Choose an account so transfer marking is available.
      await page.getByLabel(/Add to account/).selectOption('acc0')
      // The format (i)'s popover opens under its icon, inside the screen (placed against the viewport: a
      // transformed wrapper would carry it off the right edge).
      await page.getByRole('button', { name: 'About file formats' }).focus()
      const formatHint = page.getByRole('tooltip')
      await formatHint.waitFor()
      expect(await hintPlacement(page, 'About file formats')).toEqual({ inside: true, centred: true, close: true })
      await page.keyboard.press('Escape')
      await expect(formatHint).toBeHidden()
      await page.getByLabel('Statement file').setInputFiles({
        name: 'tx.csv', mimeType: 'text/csv', buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
      })
      await page.getByRole('button', { name: 'Review transactions' }).click()
      await page.getByText('AUTOMARKET', { exact: true }).waitFor() // the review list is up
      await expectNoViolations(page)
      // The include box answers a real pointer click on itself (its 40px target sits behind it):
      // unticking a row takes it out of the count, ticking it back puts it in.
      const include = page.getByLabel('Include AUTOMARKET on 2026-06-17')
      await include.uncheck()
      await expect(page.getByRole('button', { name: 'Import 2 transactions' })).toBeVisible()
      await include.check()
      await expect(page.getByRole('button', { name: 'Import 3 transactions' })).toBeVisible()

      // The Columns dialog: the sample table, the mapping selects, More options.
      await page.getByRole('button', { name: 'Columns' }).click()
      const columns = page.getByRole('dialog', { name: 'Columns' })
      await columns.getByRole('table', { name: 'Sample of the uploaded file' }).waitFor()
      await columns.getByText('More options').click()
      await columns.getByLabel('Number format').waitFor()
      await animationsSettled(columns)
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(columns).toBeHidden()

      // A row's split editor (selects, amount inputs, remaining hint), behind its ⋯.
      await page.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Split AUTOMARKET on 2026-06-17' }).click()
      const split = page.getByRole('dialog', { name: 'Split' })
      await split.getByLabel('Split line 1 amount for AUTOMARKET').waitFor()
      await animationsSettled(split)
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(split).toBeHidden()

      // The flagged row marked as a transfer: the Transfer dialog (counterparty picker, the
      // "Already recorded?" radios, the status line), with the row's chip behind it.
      await page.getByRole('button', { name: 'WOLT on 2026-06-15: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Mark as transfer: WOLT on 2026-06-15' }).click()
      const transfer = page.getByRole('dialog', { name: 'Transfer' })
      await transfer.getByLabel('Transfer account for WOLT on 2026-06-15').waitFor()
      await transfer.getByLabel('Match recorded transfer for WOLT on 2026-06-15').waitFor()
      await animationsSettled(transfer)
      await expectNoViolations(page)
    })

    // The Columns sheet on a 375px phone: the sample table is wider than the sheet and scrolls sideways in
    // a box a keyboard can reach (axe's scrollable-region-focusable fires only where the table overflows).
    test('the Columns sheet on a phone has no WCAG A/AA violations, and its sample scrolls by keyboard', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 })
      await authedSetup(page, theme)
      await page.goto('/import')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      await page.getByLabel('Statement file').setInputFiles({
        name: 'tx.csv', mimeType: 'text/csv', buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
      })
      await page.getByRole('button', { name: 'Review transactions' }).click()
      await page.getByText('AUTOMARKET', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Columns' }).click()
      const columns = page.getByRole('dialog', { name: 'Columns' })
      await columns.getByText('More options').click()
      await columns.getByLabel('Number format').waitFor()
      await animationsSettled(columns)
      await expectNoViolations(page)
      const sample = columns.getByRole('region', { name: 'Sample of the uploaded file' })
      await sample.focus()
      await expect(sample).toBeFocused()
      await expect(sample.getByRole('table', { name: 'Sample of the uploaded file' })).toBeVisible()
    })

    test('empty Jars page with its example jars has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.route('**/api/jars', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/jars')
      await page.getByRole('button', { name: /^Car insurance, / }).waitFor()
      await expectNoViolations(page)

      // An example opens the form filled in (jar setup plan, PR 3).
      await page.getByRole('button', { name: /^Summer holiday, / }).click()
      await page.getByRole('dialog').waitFor()
      await expectNoViolations(page)
    })

    test('jar add + edit modal has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/jars')
      await page.getByRole('heading', { level: 1 }).first().waitFor()

      // New-jar modal — the form asks no Type: Repeats starts at "Doesn’t repeat" (a Goal), so
      // Needed by + Repeats (with its "What repeating means" hint) render.
      await page.getByRole('button', { name: 'New jar' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Needed by').waitFor()
      await dialog.getByLabel('Repeats').waitFor()
      await expectNoViolations(page)

      // Pick a cadence → the jar repeats (Recurring), so the date swaps to "Next due".
      await dialog.getByLabel('Repeats').selectOption('12')
      await dialog.getByLabel('Next due date').waitFor()
      await expectNoViolations(page)

      // Just the month: the date swaps for a list of months (the Date / Month choice).
      await dialog.getByRole('radio', { name: 'Month' }).check()
      await dialog.getByLabel('Next due (month)').selectOption('2027-03-01')
      await expectNoViolations(page)
      await dialog.getByRole('radio', { name: 'Date' }).check()

      // Back to one that doesn't repeat: a target with a mid-month "Needed by" date renders the
      // server's schedule preview (the mocked POST /jars/schedule) and, under "More options",
      // the "Include the deadline month" tick box; scan both (W02).
      await dialog.getByLabel('Repeats').selectOption('0')
      await dialog.getByLabel('Target amount').fill('300')
      await dialog.getByLabel('Needed by').fill('2026-12-15')
      await dialog.getByTestId('jar-schedule-preview').waitFor()
      await dialog.getByRole('button', { name: 'More options' }).click()
      await dialog.getByLabel('Include the deadline month').waitFor()
      await expectNoViolations(page)

      // Choosing a fixed amount swaps the date (and Repeats) for a Monthly amount, filled from the plan.
      await dialog.getByLabel('Set aside a fixed amount each month').check()
      await dialog.getByLabel('Monthly amount').waitFor()
      await expectNoViolations(page)

      // Edit an existing jar (opening-balance hint, two-step Archive affordance), from its ⋯
      // menu (restyle PR 4), scanned open.
      await dialog.getByRole('button', { name: 'Cancel edit' }).click()
      await page.getByRole('button', { name: 'Home insurance: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit' }).waitFor()
      await expectNoViolations(page)
      await page.getByRole('menuitem', { name: 'Edit' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Archive jar' }).waitFor()
      await expectNoViolations(page)
    })

    test('a jar\'s ⋯ sheet on a phone has no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/jars')
      await page.getByRole('button', { name: 'Home insurance: more actions' }).click()
      const sheet = page.getByRole('dialog', { name: 'Home insurance' })
      await sheet.getByRole('button', { name: 'Edit' }).waitFor()
      await animationsSettled(sheet)
      await expectNoViolations(page)
    })

    test('currency conversion (Enter amount + paid in another currency) has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/transactions')
      await page.getByRole('heading', { level: 1 }).first().waitFor()

      // W08: a row waiting for its budget-currency amount, with a suggestion filled in.
      await page.getByRole('button', { name: 'Enter amount in EUR: London Cab' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Suggest' }).click()
      await dialog.getByText(/ECB reference rate/).waitFor()
      await expectNoViolations(page)
      await dialog.getByRole('button', { name: 'Cancel' }).click()

      // The add form's "Paid in another currency" fields with a suggested Amount.
      await page.getByRole('button', { name: 'Add transaction' }).click()
      const add = page.getByRole('dialog')
      await add.getByLabel('Paid in another currency').check()
      await add.getByLabel('Currency paid in').fill('USD')
      await add.getByLabel('Amount paid in that currency').fill('20')
      await add.getByRole('button', { name: 'Suggest' }).click()
      await add.getByText(/ECB reference rate/).waitFor()
      await expectNoViolations(page)
    })

    // The Transactions list (restyle PR 5): a row's ⋯ open, the search with and without a match,
    // and the row's inline editors open.
    test('transactions row menu, search and inline editors have no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/transactions')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add transaction, in the top bar.
      await expect(page.getByRole('button', { name: 'Add transaction' })).toHaveCount(1)

      await page.getByRole('button', { name: 'Welbees Supermarket: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit transaction: Welbees Supermarket' }).waitFor()
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)

      await page.getByRole('button', { name: 'Search transactions' }).click()
      await page.getByRole('searchbox', { name: 'Search transactions' }).fill('grocer')
      await expect(page.getByTestId('tx-row')).toHaveCount(1)
      await expectNoViolations(page)
      await page.getByRole('searchbox', { name: 'Search transactions' }).fill('nothing like it')
      await page.getByText('No match for “nothing like it”.').waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'Clear search' }).click()

      await page.getByRole('button', { name: 'Welbees Supermarket: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit transaction: Welbees Supermarket' }).click()
      await page.getByLabel('Edit payee').waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'Cancel edit' }).click()

      await page.getByRole('button', { name: 'Unknown Shop: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Split transaction: Unknown Shop' }).click()
      await page.getByLabel('Split line 1 amount').waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'Cancel split' }).click()

      await page.getByRole('button', { name: 'Assign Unknown Shop' }).click()
      await page.getByRole('combobox', { name: 'Assign Unknown Shop' }).waitFor()
      await expectNoViolations(page)
    })

    test('a transaction\'s sheet on a phone has no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/transactions')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add transaction, under the KPIs.
      await expect(page.getByRole('button', { name: 'Add transaction' })).toHaveCount(1)
      await page.getByRole('button', { name: 'Welbees Supermarket', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'Welbees Supermarket' })
      await sheet.getByRole('button', { name: 'Edit transaction: Welbees Supermarket' }).waitFor()
      await animationsSettled(sheet)
      await expectNoViolations(page)
    })

    // The Accounts page (restyle PR 6): an account's ⋯ menu open (with its note), a jar caption's
    // (i) open, and the inline editor open in its card.
    test('an account\'s ⋯ menu, a jar caption\'s hint and the account editor have no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/accounts')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add account, in the top bar.
      await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(1)

      await page.getByRole('button', { name: 'Savings Joint: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit Savings Joint' }).waitFor()
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)

      await page.getByRole('button', { name: 'About the money not in jars in Savings Joint' }).focus()
      await page.getByRole('tooltip').waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'About the money not in jars in Savings Joint' }).blur()

      await page.getByRole('button', { name: 'Joint Current: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit Joint Current' }).click()
      await page.getByLabel('Name for Joint Current').waitFor()
      await expectNoViolations(page)
    })

    test('an account\'s ⋯ sheet and the account editor on a phone have no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/accounts')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add account, under the KPIs.
      await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(1)
      await page.getByRole('button', { name: 'Savings Joint: more actions' }).click()
      const sheet = page.getByRole('dialog', { name: 'Savings Joint' })
      await sheet.getByRole('button', { name: 'Edit Savings Joint' }).waitFor()
      await animationsSettled(sheet)
      await expectNoViolations(page)

      await sheet.getByRole('button', { name: 'Edit Savings Joint' }).click()
      await page.getByLabel('Name for Savings Joint').waitFor()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expectNoViolations(page)
    })

    // An account's page (restyle PR 11): the back chevron, the In jars (i) open, and a row dated
    // before the opening date with its (i) open (the account's opening date is moved so the
    // mocked register has some), on a desktop and on a phone.
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      test(`an account's page at ${size.width}px, its In jars (i) and a "Before opening" (i) have no WCAG A/AA violations`, async ({ page }) => {
        await page.setViewportSize(size)
        await authedSetup(page, theme)
        await page.route('**/api/accounts', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              { id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 1000, openingDate: '2026-06-17', currentBalance: 1200, displayOrder: 0 },
              { id: 'acc1', name: 'Savings Joint', type: 1, currency: 'EUR', openingBalance: 0, openingDate: '2026-01-01', currentBalance: 5000, displayOrder: 1 },
            ]),
          }),
        )
        await page.goto('/accounts/acc1')
        await page.getByRole('heading', { level: 1, name: 'Savings Joint' }).waitFor()
        await expect(page.getByRole('link', { name: 'Back to Accounts' })).toHaveCount(1)
        await page.getByRole('button', { name: 'About the money not in jars in Savings Joint' }).focus()
        await page.getByRole('tooltip').waitFor()
        await expectNoViolations(page)

        await page.goto('/accounts/acc0')
        await page.getByText('Welbees Supermarket').waitFor()
        const hint = page.getByRole('button', { name: /: before opening$/ }).first()
        await hint.focus()
        await page.getByRole('tooltip').waitFor()
        await expectNoViolations(page)
      })
    }

    // The People page (restyle PR 8): a person's ⋯ menu open (with its note), a sign-in's ⋯ menu,
    // a share plate's (i) open, and the editor open in its card.
    test('a person\'s ⋯ menu, a sign-in\'s ⋯, the share (i) and the person editor have no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/people')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add person, in the top bar.
      await expect(page.getByRole('button', { name: 'Add person' })).toHaveCount(1)

      await page.getByRole('button', { name: 'Alex: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit Alex' }).waitFor()
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)

      await page.getByRole('button', { name: 'Sign-in guest@example.eu: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Remove guest@example.eu' }).waitFor()
      await expectNoViolations(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)

      await page.getByRole('button', { name: 'About Alex’s share of income' }).focus()
      await page.getByRole('tooltip').waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'About Alex’s share of income' }).blur()

      await page.getByRole('button', { name: 'Alex: more actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit Alex' }).click()
      await page.getByLabel('Name for Alex').waitFor()
      await expectNoViolations(page)
    })

    test('a person\'s ⋯ sheet, a sign-in\'s sheet and the person editor on a phone have no WCAG A/AA violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await authedSetup(page, theme)
      await page.goto('/people')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // One Add person, under the KPIs.
      await expect(page.getByRole('button', { name: 'Add person' })).toHaveCount(1)
      await page.getByRole('button', { name: 'Sam: more actions' }).click()
      const sheet = page.getByRole('dialog', { name: 'Sam' })
      await sheet.getByRole('button', { name: 'Edit Sam' }).waitFor()
      await animationsSettled(sheet)
      await expectNoViolations(page)

      await sheet.getByRole('button', { name: 'Edit Sam' }).click()
      await page.getByLabel('Name for Sam').waitFor()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'Cancel edit' }).click()

      await page.getByRole('button', { name: 'Sign-in guest@example.eu: more actions' }).click()
      const signIn = page.getByRole('dialog', { name: 'guest@example.eu' })
      await signIn.getByRole('button', { name: 'Remove guest@example.eu' }).waitFor()
      await animationsSettled(signIn)
      await expectNoViolations(page)
    })

    test('login has no WCAG A/AA violations', async ({ page }) => {
      // Signed out: no token, so the login page renders.
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)
      await page.goto('/login')
      await page.getByLabel('Email').waitFor()
      await expectNoViolations(page)

      // Also scan the registration form (extra fields: names, currency, format, consent checkbox).
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.getByLabel('First name').waitFor()
      await expectNoViolations(page)

      // And with the currency (i) open (its tooltip over the form).
      await page.getByRole('button', { name: 'About these settings' }).focus()
      await page.getByRole('tooltip').waitFor()
      await expectNoViolations(page)

      // The session-expired line, with its (i) open.
      await page.goto('/login?reason=expired')
      await page.getByRole('button', { name: 'Why you were signed out' }).focus()
      await page.getByRole('tooltip').waitFor()
      await expectNoViolations(page)
    })

    // Two-factor sign-in (fix 14): the passkey step after a right password, and its recovery-code form.
    test('the passkey step has no WCAG A/AA violations', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)
      await page.route(/\/api\/auth\/login$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ passkeyRequired: true, ticket: 't1', options: '{"challenge":"AA","rpId":"localhost"}' }),
        }),
      )
      await page.goto('/login')
      await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()
      await page.getByLabel('Email').fill('e2e@allotjar.app')
      await page.getByLabel('Password').fill('password123')
      await page.locator('button[type="submit"]').click()
      await expect(page.getByRole('heading', { name: 'Confirm with your passkey' })).toBeVisible()
      await expectNoViolations(page)

      await page.getByRole('button', { name: 'Use a recovery code' }).click()
      await page.getByLabel('Recovery code').waitFor()
      await expectNoViolations(page)
    })

    // The invite landing (public, restyle PR 9's frame): the signed-out accept form and the
    // missing-code state.
    test('accept-invite page has no WCAG A/AA violations', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)
      await page.goto('/accept-invite?code=abc')
      await page.getByLabel('Your name (optional)').waitFor()
      await expectNoViolations(page)

      await page.goto('/accept-invite')
      await page.getByRole('alert').waitFor()
      await expectNoViolations(page)
    })

    // REG-066 — the password-reset pages are public auth chrome like /login: scan the
    // forgot form + its non-enumerating confirmation, and the reset form + its
    // incomplete-link recovery state.
    test('forgot/reset password pages have no WCAG A/AA violations', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)

      await page.goto('/forgot-password')
      await page.getByLabel('Email').waitFor()
      await expectNoViolations(page)

      // The confirmation panel (the forgot endpoint 204s; mockApi answers everything 200-ish).
      await page.getByLabel('Email').fill('owner@example.com')
      await page.getByRole('button', { name: 'Email me a reset link' }).click()
      await page.getByRole('status').waitFor()
      await expectNoViolations(page)

      await page.goto('/reset-password?email=owner%40example.com&token=tok')
      // exact — "Confirm new password" substring-matches "New password" otherwise.
      await page.getByLabel('New password', { exact: true }).waitFor()
      await expectNoViolations(page)

      // The mismatch: the confirm field marked invalid and described by the alert.
      await page.getByLabel('New password', { exact: true }).fill('password123')
      await page.getByLabel('Confirm new password').fill('password124')
      await page.getByRole('button', { name: 'Set new password' }).click()
      await page.getByRole('alert').waitFor()
      await expectNoViolations(page)

      // Incomplete-link recovery state (no token in the URL).
      await page.goto('/reset-password')
      await page.getByRole('button', { name: 'Request a new link' }).waitFor()
      await expectNoViolations(page)
    })

    // The confirm-email page (public, restyle PR 16: in the sign-in pages' frame) — its four
    // states: done (mockApi 200s the confirm POST), expired (a 400), incomplete (no token) with
    // its (i) open, and working (the request never answers).
    test('confirm-email page has no WCAG A/AA violations', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)

      await page.goto('/confirm-email?email=owner%40example.com&token=tok')
      await page.getByRole('heading', { level: 1, name: 'Email confirmed' }).waitFor()
      await expectNoViolations(page)

      await page.route(/\/api\/auth\/confirm-email$/, (route) =>
        route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired token.' }) }),
      )
      await page.goto('/confirm-email?email=owner%40example.com&token=dead')
      await page.getByRole('heading', { level: 1, name: 'This link has expired' }).waitFor()
      await expectNoViolations(page)

      await page.goto('/confirm-email')
      await page.getByRole('heading', { level: 1, name: "This link isn't complete" }).waitFor()
      await expectNoViolations(page)
      await page.getByRole('button', { name: 'Why' }).focus()
      await page.getByRole('tooltip').waitFor()
      await expectNoViolations(page)

      await page.route(/\/api\/auth\/confirm-email$/, () => new Promise(() => {}))
      await page.goto('/confirm-email?email=owner%40example.com&token=slow')
      await page.getByRole('heading', { level: 1, name: 'Confirming your email…' }).waitFor()
      await expectNoViolations(page)
    })

    // The persistent "confirm your email" banner (shown in-app while unverified).
    test('verify-email banner has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      // /auth/me reports the login as unverified so the banner renders.
      await page.route('**/api/auth/me', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            userId: 'u1',
            email: 'e2e@allotjar.app',
            displayName: 'Alex',
            role: 0,
            ownerId: 'u1',
            memberId: null,
            needsConsent: false,
            emailConfirmed: false,
            households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
          }),
        }),
      )
      await page.goto('/')
      await page.getByText('Confirm your email: check your inbox for the link.').waitFor()
      await expectNoViolations(page)
    })

    test('analytics consent banner + Help control have no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      // Turn the analytics flag on so the consent banner and the Help privacy control both render
      // (no real GA loads — there's no measurement ID in the e2e build).
      await page.route('**/api/features', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FLAGS, analytics: true }),
        }),
      )
      await page.goto('/help')
      await page.getByRole('region', { name: 'Analytics consent' }).waitFor()
      await page.getByRole('heading', { name: 'Privacy' }).waitFor()
      await page.getByRole('switch', { name: 'Google Analytics' }).waitFor()
      await expectNoViolations(page)
    })

    test('onboarding welcome, tour and checklist have no WCAG A/AA violations', async ({ page }) => {
      // A brand-new user (no onboarding record) so the welcome auto-opens.
      await page.addInitScript(
        ({ t }) => {
          localStorage.setItem('zbb.theme', t)
          localStorage.setItem('zbb.token', 'e2e-token')
        },
        { t: theme },
      )
      await page.route('**/api/**', mockApi)
      await mockSignedIn(page, ONBOARDING_EMAIL)
      await page.goto('/')

      // Welcome dialog.
      await page.getByRole('heading', { name: 'Welcome to AllotJar' }).waitFor()
      await expectNoViolations(page)

      // Spotlight tour — first step (a real element is spotlit).
      await page.getByRole('button', { name: 'Take the tour' }).click()
      const tour = page.getByRole('dialog')
      await page.getByText('Step 1 of').waitFor()
      await expectNoViolations(page)

      // Advance through every page-by-page step to the final (centred) one.
      for (let i = 0; i < 20; i++) {
        const next = tour.getByRole('button', { name: 'Next' })
        if (!(await next.isVisible())) break
        await next.click()
      }
      await tour.getByRole('button', { name: 'Finish' }).waitFor()
      await expectNoViolations(page)

      // Finish → the getting-started checklist appears in the corner.
      await tour.getByRole('button', { name: 'Finish' }).click()
      await page.getByRole('region', { name: 'Getting started' }).waitFor()
      await expectNoViolations(page)
    })
  })
}
