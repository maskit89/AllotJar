import { expect, test } from '@playwright/test'
import { register } from './helpers'

/**
 * Registration → empty household (rule 81) → first month from a template → cookie-refresh session
 * restore. The stubbed suites can't cover any of this: it exercises the real /auth/register (which
 * seeds nothing and offers no sample-data opt-in), the template create through the real
 * /api/budget, the first-run checklist, and the HttpOnly refresh-cookie flow that rehydrates the
 * session after a full page load.
 */
test('a new user starts with an empty budget and builds a first month', async ({ page }) => {
  // Registration seeds nothing: no pre-filled figures anywhere — the dashboard offers the
  // create-month flow instead. register() itself asserts the empty state.
  await register(page)

  // Line names render as textbox VALUES (rename fields), not text — assert by role. Nothing is
  // seeded: no income-line rename field, no jar on the shelf, no sign-up sample checkbox existed.
  await expect(page.getByRole('textbox', { name: 'Income source name', exact: true })).toHaveCount(0)
  await expect(page.getByText('Emergency Fund')).toHaveCount(0)
  // The first-run checklist (rule 81) shows all three steps open: accounts → month → jar, the
  // jar step disabled until an account exists.
  const setup = page.getByRole('region', { name: 'Set up your budget' })
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('link', { name: 'Go to accounts' })).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Add a jar from an account' })).toBeDisabled()

  // The create-month hero offers a blank start and the quick-start templates (no copy button —
  // a brand-new user has no previous month).
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  await expect(page.getByText('Or start from a template')).toBeVisible()

  // Starting blank lands on a real, empty month: the hero renders, income group only.
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
})

test('starting from the Essentials template builds a month with named lines and no savings lines', async ({ page }) => {
  await register(page, { starterBudget: true })

  // Group + line names render as editable rename fields, so assert them by their textbox
  // accessible names.
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Housing' })).toHaveValue('Housing')
  // exact — "Income source name" is a substring of the "New income source name" add field.
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Take-home Pay')
  // Rule 81: templates carry no savings lines and mint no jars — jars come only from the jar form.
  await expect(page.getByRole('textbox', { name: 'Rename group Savings' })).toHaveCount(0)
  await expect(page.getByText('Emergency Fund')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your jars' })).toHaveCount(0)
  // The checklist ticks the month step and keeps the account + jar steps open.
  const setup = page.getByRole('region', { name: 'Set up your budget' })
  await expect(setup.getByText("Create this month's budget")).toBeVisible()
  await expect(setup.getByRole('link', { name: 'Go to accounts' })).toBeVisible()
})

test('the session survives a full page reload via the refresh cookie', async ({ page }) => {
  await register(page)

  // A hard reload drops the in-memory access token; the app must restore the session from the
  // HttpOnly refresh cookie (POST /auth/refresh) rather than bounce to /login.
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Import transactions' })).toBeVisible()
  await expect(page).toHaveURL(/\/import$/)
})
