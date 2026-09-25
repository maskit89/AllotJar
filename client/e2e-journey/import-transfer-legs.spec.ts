import { expect, test, type Page } from '@playwright/test'
import { register } from './helpers'

/**
 * Own-account transfers across two statements, driven through the live API + real SQL (W07,
 * rules 51/69/71/72):
 *
 *  1. Source statement first: a debit marked as a transfer records a confirmed departure; the
 *     source is debited, the pot is not, and the amount shows in transit. The destination
 *     statement's credit then offers the recorded transfer as a match; choosing it confirms the
 *     receipt on the SAME movement — current −100 / savings +100, never −200/+200 — and a
 *     re-import of the destination statement is a complete no-op.
 *  2. Receipt first: a credit marked as a transfer with no known departure is held for review
 *     with no posted effect on either account (A 500 / B 200 stays A 500 / B 200); supplying
 *     the departure date on the register posts each leg on its own date (A 400 / B 300).
 *
 * Statement dates are in mid-2026 so they precede "today" whenever CI runs; the accounts open on
 * 1 January 2026 so the dated ledger counts them (rule 40).
 */

async function upload(page: Page, statement: string, accountName: string) {
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Import transactions' })).toBeVisible()
  await page.getByLabel('Add to account').selectOption({ label: accountName })
  await page.getByLabel('Statement file').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(statement),
  })
  await page.getByRole('button', { name: 'Review transactions' }).click()
}

async function addAccount(page: Page, name: string, opening: string) {
  await page.goto('/accounts')
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(name)
  await dialog.getByLabel('Account currency').selectOption({ label: 'Euro (€)' })
  await dialog.getByLabel('Opening balance').fill(opening)
  await dialog.getByLabel('Opening date').fill('2026-01-01')
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('link', { name: `View ${name}`, exact: true })).toBeVisible()
}

/** The account-detail hero balance (aria-label "<name> balance: <amount>"). */
async function balance(page: Page, name: string) {
  await page.goto('/accounts')
  await page.getByRole('link', { name: `View ${name}`, exact: true }).click()
  return page.getByLabel(new RegExp(`^${name} balance:`))
}

const SOURCE_STATEMENT = ['Date,Description,Amount,Currency', '2026-06-30,TRANSFER TO POT,-100.00,EUR', ''].join('\n')
const DESTINATION_STATEMENT = ['Date,Description,Amount,Currency', '2026-07-01,TRANSFER FROM MAIN,100.00,EUR', ''].join('\n')

test('both statements of one transfer reconcile to a single movement when the user matches the second side', async ({
  page,
}) => {
  test.slow()
  await register(page)
  await addAccount(page, 'Main', '1000')
  await addAccount(page, 'Pot', '200')

  // --- Source statement: the debit is a confirmed departure; receipt is unknown.
  await upload(page, SOURCE_STATEMENT, 'Main')
  await page.getByRole('button', { name: 'Mark TRANSFER TO POT on 2026-06-30 as a transfer' }).click()
  await page.getByLabel('Transfer account for TRANSFER TO POT on 2026-06-30').selectOption({ label: 'Pot' })
  await expect(page.getByText(/Recorded as departed on/)).toBeVisible()
  await page.getByRole('button', { name: 'Import 1 transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  const transfersTile = page.locator('div', { has: page.getByText('Transfers', { exact: true }) }).last()
  await expect(transfersTile).toContainText('1')

  await expect(await balance(page, 'Main')).toContainText('900.00')
  await expect(page.getByText('In transit', { exact: true }).first()).toBeVisible()
  await expect(await balance(page, 'Pot')).toContainText('200.00') // no arrival date is invented
  await page.goto('/accounts')
  await expect(page.getByText('100.00 in transit out')).toBeVisible()
  await expect(page.getByText('100.00 in transit in')).toBeVisible()

  // --- Destination statement: the credit offers the recorded transfer; the user picks it.
  await upload(page, DESTINATION_STATEMENT, 'Pot')
  await expect(page.getByText('Looks like a transfer')).toBeVisible()
  await page.getByRole('button', { name: 'Mark TRANSFER FROM MAIN on 2026-07-01 as a transfer' }).click()
  const match = page.getByLabel('Match recorded transfer for TRANSFER FROM MAIN on 2026-07-01')
  await expect(match).toBeVisible()
  await expect(match.locator('option')).toHaveCount(2) // "record as new" + the one candidate
  await match.selectOption({ index: 1 })
  // Choosing the candidate fixes the counterparty it names.
  await expect(page.getByLabel('Transfer account for TRANSFER FROM MAIN on 2026-07-01')).toHaveValue(/.+/)
  await expect(page.getByText(/Confirms the other side of the recorded transfer/)).toBeVisible()
  await page.getByRole('button', { name: 'Import 1 transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  await expect(page.getByText('0 transactions added')).toBeVisible() // confirming a leg creates no row
  const matchedTile = page.locator('div', { has: page.getByText('Matched', { exact: true }) }).last()
  await expect(matchedTile).toContainText('1')

  // --- Rule 51: current −100 and savings +100, once.
  await expect(await balance(page, 'Main')).toContainText('900.00')
  await expect(await balance(page, 'Pot')).toContainText('300.00')
  await page.goto('/accounts')
  await expect(page.getByText(/in transit/)).toHaveCount(0)
  await page.goto('/transactions')
  const rows = page.locator('tbody tr').filter({ hasText: 'TRANSFER' })
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByText('In transit')).toHaveCount(0)

  // --- Re-importing the destination statement is a complete no-op on its own leg.
  await upload(page, DESTINATION_STATEMENT, 'Pot')
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
})

test('a receipt-first transfer is held for review with no posted effect until its departure date is supplied', async ({
  page,
}) => {
  test.slow()
  await register(page)
  await addAccount(page, 'Main', '500')
  await addAccount(page, 'Pot', '200')

  // --- Rule 72: the credit is identified as a transfer from Main, departure unknown.
  await upload(page, DESTINATION_STATEMENT, 'Pot')
  await page.getByRole('button', { name: 'Mark TRANSFER FROM MAIN on 2026-07-01 as a transfer' }).click()
  await page.getByLabel('Transfer account for TRANSFER FROM MAIN on 2026-07-01').selectOption({ label: 'Main' })
  await expect(page.getByLabel('Match recorded transfer for TRANSFER FROM MAIN on 2026-07-01')).toHaveCount(0)
  await expect(page.getByText(/Held for review until the departure date is known/)).toBeVisible()
  await page.getByRole('button', { name: 'Import 1 transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  const pendingTile = page.locator('div', { has: page.getByText('Pending review', { exact: true }) }).last()
  await expect(pendingTile).toContainText('1')

  // Neither account moves: A 500 / B 200 must not become A 500 / B 300.
  await expect(await balance(page, 'Main')).toContainText('500.00')
  await expect(await balance(page, 'Pot')).toContainText('200.00')
  await page.goto('/accounts')
  await expect(page.getByText('1 receipt pending review')).toBeVisible()
  await expect(page.getByText(/transfer receipt.* pending review/)).toBeVisible()

  // --- The register flags the row and asks for the departure date.
  await page.goto('/transactions')
  const row = page.locator('tbody tr').filter({ hasText: 'TRANSFER FROM MAIN' })
  await expect(row.getByText('Pending review')).toBeVisible()
  await row.getByRole('button', { name: /^Add departure date:/ }).click()
  await row.getByLabel('Departure date').fill('2026-06-30')
  const confirmed = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/transfer-legs') && r.ok(),
  )
  await row.getByRole('button', { name: 'Save transfer leg' }).click()
  await confirmed
  await expect(row.getByText('Pending review')).toHaveCount(0)
  await expect(row.getByText('In transit')).toHaveCount(0)

  // --- Each bank leg posts on its own date: A 400 / B 300.
  await expect(await balance(page, 'Main')).toContainText('400.00')
  await expect(await balance(page, 'Pot')).toContainText('300.00')
  await page.goto('/accounts')
  await expect(page.getByText(/pending review/)).toHaveCount(0)
})
