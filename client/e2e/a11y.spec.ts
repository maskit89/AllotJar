import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup, FLAGS, mockApi, mockSignedIn, ONBOARDING_EMAIL } from './mocks'

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

    test('import review table has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/import')
      await page.getByRole('heading', { level: 1 }).first().waitFor()
      // Choose an account so transfer marking is available.
      await page.getByLabel(/Add to account/).selectOption('acc0')
      await page.getByLabel('Statement file').setInputFiles({
        name: 'tx.csv', mimeType: 'text/csv', buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
      })
      await page.getByRole('button', { name: 'Review transactions' }).click()
      await page.getByText('AUTOMARKET').waitFor() // the review table is up
      await expectNoViolations(page)

      // Expand a row's split editor and re-scan (selects, amount inputs, remaining hint).
      await page.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }).click()
      await page.getByLabel('Split line 1 amount for AUTOMARKET').waitFor()
      await expectNoViolations(page)

      // Mark the flagged row as a transfer and re-scan (badge + counterparty picker).
      await page.getByRole('button', { name: 'Mark WOLT on 2026-06-15 as a transfer' }).click()
      await page.getByLabel('Transfer account for WOLT on 2026-06-15').waitFor()
      await expectNoViolations(page)
    })

    test('jar add + edit modal has no WCAG A/AA violations', async ({ page }) => {
      await authedSetup(page, theme)
      await page.goto('/jars')
      await page.getByRole('heading', { level: 1 }).first().waitFor()

      // New-jar modal — Recurring by default, so Next due + Repeats render.
      await page.getByRole('button', { name: 'New jar' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Next due date').waitFor()
      await expectNoViolations(page)

      // Switch to Goal → the conditional fields swap to "How to save" + a Deadline.
      // Exact match: "Jar type" would otherwise also catch the "About jar types" info button.
      await dialog.getByLabel('Jar type', { exact: true }).selectOption('1')
      await dialog.getByLabel('Deadline').waitFor()
      await expectNoViolations(page)

      // A target with a mid-month deadline renders the server's schedule preview (the mocked
      // POST /jars/schedule) and the "Include the deadline month" option; scan both (W02).
      await dialog.getByLabel('Target amount').fill('300')
      await dialog.getByLabel('Deadline').fill('2026-12-15')
      await dialog.getByTestId('jar-schedule-preview').waitFor()
      await dialog.getByLabel('Include the deadline month').waitFor()
      await expectNoViolations(page)

      // The fixed-monthly method swaps the Deadline for a Monthly amount.
      await dialog.getByLabel('How to save').selectOption('2')
      await dialog.getByLabel('Monthly amount').waitFor()
      await expectNoViolations(page)

      // Edit an existing jar (opening-balance hint, two-step Archive affordance).
      await dialog.getByRole('button', { name: 'Cancel edit' }).click()
      await page.getByRole('button', { name: 'Edit Home insurance' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Archive Home insurance' }).waitFor()
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

      // Incomplete-link recovery state (no token in the URL).
      await page.goto('/reset-password')
      await page.getByRole('button', { name: 'Request a new link' }).waitFor()
      await expectNoViolations(page)
    })

    // The confirm-email page (public) — success state (mockApi 200s the confirm POST) + the
    // incomplete-link recovery state.
    test('confirm-email page has no WCAG A/AA violations', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('zbb.theme', t as string), theme)
      await page.route('**/api/**', mockApi)

      await page.goto('/confirm-email?email=owner%40example.com&token=tok')
      await page.getByText('Email confirmed').waitFor()
      await expectNoViolations(page)

      await page.goto('/confirm-email')
      await page.getByText("This link isn't complete").waitFor()
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
      await page.getByText(/please confirm your email/i).waitFor()
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
      await page.getByRole('heading', { name: 'Privacy & analytics' }).waitFor()
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
