import { expect, test } from '@playwright/test'
import { register } from './helpers'

/**
 * Registration → optional sample budget → cookie-refresh session restore. The stubbed suites can't
 * cover any of this: it exercises the real /auth/register with and without the sample-figures
 * opt-in, the BudgetSeeder writing a jar-backed Savings line when opted in (the enforced
 * SavingsId → Jars FK that in-memory tests can't see), and the HttpOnly refresh-cookie flow that
 * rehydrates the session after a full page load.
 */
test('a new user starts with an empty budget and builds a first month', async ({ page }) => {
  // Default registration (sample box left unticked): no pre-filled figures anywhere — the
  // dashboard offers the create-month flow instead. register() itself asserts the empty state.
  await register(page)

  // Line names render as textbox VALUES (rename fields), not text — assert by role. A seeded
  // month would have an income-line rename field and the Emergency Fund jar on the shelf.
  await expect(page.getByRole('textbox', { name: 'Income source name', exact: true })).toHaveCount(0)
  await expect(page.getByText('Emergency Fund')).toHaveCount(0)

  // The create-month hero offers a blank start and the quick-start templates (no copy button —
  // a brand-new user has no previous month).
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  await expect(page.getByText('Or start from a template')).toBeVisible()

  // Starting blank lands on a real, empty month: the hero renders, income group only.
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
})

test('opting in to sample figures lands on a seeded starter budget', async ({ page }) => {
  await register(page, { sampleBudget: true })

  // The seeded month is visible immediately (the user opted in on the sign-up form). Group + line
  // names render as editable rename fields, so assert them by their textbox accessible names.
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Housing' })).toHaveValue('Housing')
  // exact — "Income source name" is a substring of the "New income source name" add field.
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Take-home Pay')
  // The starter Savings line is a real jar (the enforced SavingsId → Jars FK), shown on the shelf.
  await expect(page.getByText('Emergency Fund')).toBeVisible()
})

test('the session survives a full page reload via the refresh cookie', async ({ page }) => {
  await register(page)

  // A hard reload drops the in-memory access token; the app must restore the session from the
  // HttpOnly refresh cookie (POST /auth/refresh) rather than bounce to /login.
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Import transactions' })).toBeVisible()
  await expect(page).toHaveURL(/\/import$/)
})
