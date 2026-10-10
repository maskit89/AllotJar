import { expect, test, type Page } from '@playwright/test'
import { groupAction, register } from './helpers'

/**
 * The cross-month acknowledge flow, end to end over the real API: assigning a previous-month
 * transaction to a current-month line is rejected by the server (crossMonth), the client offers
 * the "Budget to a different month?" confirm, and the confirmed retry re-sends the assignment
 * WITH the acknowledgment and succeeds.
 *
 * This exact wire was broken once: the API's request contracts silently dropped
 * `acknowledgeCrossMonth`, so the confirmed retry failed with the same 400 it was
 * acknowledging — invisible to the mocked component tests on both sides.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function previousMonth() {
  const now = new Date()
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  const month = now.getMonth() === 0 ? 12 : now.getMonth()
  return { year, month, label: `${MONTH_NAMES[month - 1]} ${year}` }
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

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

test('assigning a previous-month transaction to this month prompts, and the confirmed retry succeeds', async ({
  page,
}) => {
  const prev = previousMonth()

  await register(page)
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')

  // A previous-month expense, left unassigned at creation.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Transaction date').fill(iso(prev.year, prev.month, 15))
  await dialog.getByLabel('Transaction payee').fill('Cinema')
  await dialog.getByLabel('Transaction amount').fill('12')
  await dialog.getByLabel('Assign transaction to').selectOption({ label: 'Unassigned' })
  await dialog.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Assign it to the CURRENT month's Groceries line: the server rejects it as cross-month,
  // and the confirm dialog appears instead of a generic error.
  const row = page.locator('tbody tr').filter({ hasText: 'Cinema' })
  await row.getByRole('button', { name: 'Assign Cinema', exact: true }).click()
  await row.getByRole('combobox', { name: 'Assign Cinema' }).selectOption({ label: 'Groceries' })
  await expect(page.getByText('Budget to a different month?')).toBeVisible()

  // Confirm: the acknowledged retry must SUCCEED (this is the wire that once dropped the flag).
  await page.getByRole('button', { name: 'Budget it anyway' }).click()
  await expect(page.getByText('Budget to a different month?')).toBeHidden()
  await expect(row.getByRole('button', { name: 'Reassign Cinema', exact: true })).toContainText('Groceries')

  // The register marks the deliberate mismatch so it stays visible later.
  await expect(row).toContainText('Budgeted to')
})
