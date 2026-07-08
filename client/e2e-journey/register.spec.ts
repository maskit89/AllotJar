import { expect, test } from '@playwright/test'
import { register } from './helpers'

/**
 * Registration → seeded budget → cookie-refresh session restore. The stubbed suites can't cover
 * any of this: it exercises the real /auth/register, the BudgetSeeder writing a jar-backed Savings
 * line (the enforced SavingsId → Jars FK that in-memory tests can't see), and the HttpOnly
 * refresh-cookie flow that rehydrates the session after a full page load.
 */
test('a new user registers and lands on a seeded starter budget', async ({ page }) => {
  await register(page)

  // The seeded month is visible immediately (BudgetSeeder runs at registration). Group + line
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
