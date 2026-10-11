import { expect, test, type Page } from '@playwright/test'
import { groupAction, register, txRows } from './helpers'

/**
 * Non-EUR end-to-end regression for the first-month currency rule (#216): the first-ever budget
 * month used to hardcode EUR while a new user's accounts took their sign-up currency, so the
 * account-currency invariant (#210) rejected EVERY account-linked transaction for a non-EUR
 * household — the add-transaction modal just stuck open on "Could not add that transaction."
 * Since W08 the sign-up currency is the budget currency (rule 85) and every account uses it.
 *
 * The rest of the suite registers in EUR (the helpers pin it), so without this spec the non-EUR
 * path — the one that actually broke — would have no journey coverage. Registers a GBP user,
 * starts a blank budget, and logs an expense pinned to an account: month, account and
 * transaction must all coherently be GBP.
 */

async function addExpenseGroup(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add a group', exact: true }).click()
  await page.getByRole('textbox', { name: 'New category group name' }).fill(name)
  const reconciled = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/budget/categories' && r.ok(),
  )
  await page.getByRole('button', { name: 'Add category group', exact: true }).click()
  await reconciled
  await expect(page.getByRole('textbox', { name: `Rename group ${name}`, exact: true })).toBeVisible()
}

async function addLine(page: Page, group: string, name: string) {
  // The add row opens from the group's ⋯ ("Add line").
  await groupAction(page, group, 'Add line')
  await page.getByRole('textbox', { name: `Add a line to ${group}`, exact: true }).fill(name)
  const reconciled = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /^\/api\/budget\/categories\/[^/]+\/items$/.test(new URL(r.url()).pathname) &&
      r.ok(),
  )
  await page.keyboard.press('Enter')
  await reconciled
  await expect(page.getByRole('textbox', { name: `Rename ${name}`, exact: true })).toBeVisible()
}

test('a non-EUR registrant can budget and log account-linked spending — the first month takes their currency', async ({
  page,
}) => {
  await register(page, { currency: 'GBP' })

  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  // The blank month was created in the registrant's currency, not a hardcoded EUR.
  await expect(page.getByLabel('Remaining to budget: £0.00')).toBeVisible()

  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')

  // Every account is in the budget currency (rule 63): GBP, the same as the month.
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const accountDialog = page.getByRole('dialog')
  await accountDialog.getByLabel('Account name').fill('Joint')
  // Rule 74: the 40.00 expense below must be covered — an account never goes below zero.
  await accountDialog.getByLabel('Opening balance').fill('500')
  await accountDialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(accountDialog).toBeHidden()
  await expect(page.getByText('Joint', { exact: true })).toBeVisible()

  // The previously-failing path: an expense on a line AND an account. The modal closes only on a
  // successful POST — under the EUR-month bug it stayed open on a 400.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Transaction payee').fill('Tesco')
  await dialog.getByLabel('Transaction amount').fill('40')
  await dialog.getByLabel('Transaction account').selectOption({ label: 'Joint' })
  await dialog.getByLabel('Assign transaction to').selectOption({ label: 'Groceries' })
  await dialog.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await expect(dialog).toBeHidden()

  const row = txRows(page).first() // the only row
  await expect(row).toContainText('Tesco')
  await expect(row).toContainText('40.00')
  await expect(row).toContainText('Joint')
})
