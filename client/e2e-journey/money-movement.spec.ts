import { expect, test, type Page } from '@playwright/test'
import { addAccount, createGoalJar, register, startFromEssentialsTemplate } from './helpers'

/**
 * Money movement through the REAL stack (rules 74, 78, 79, 80): an account never goes below
 * zero and the refusal names the balance and date; income into a jar-backed account asks how
 * much goes to each jar; a payment on a line that is not a jar asks which jar it comes from;
 * and moving jar money into another account is recorded as a confirmed bank transfer.
 * The stubbed suites can only fake the server's answers.
 *
 * Money assertions are symbol-agnostic ("400.00", not "€400.00").
 */

function jarCard(page: Page, name: string) {
  return page.locator('.rounded-2xl').filter({ has: page.getByRole('heading', { name, exact: true }) }).last()
}

function unallocatedRow(page: Page, account: string) {
  return page.getByRole('region', { name: 'Unallocated' }).getByRole('listitem').filter({ hasText: account })
}

async function openAddTransaction(page: Page) {
  await page.getByRole('link', { name: 'Transactions' }).click()
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  return page.getByRole('dialog')
}

test('the account floor refuses an overdraw, income asks for jars, a non-jar line asks which jar, and a cross-account move is a transfer', async ({
  page,
}) => {
  await register(page)
  // The Essentials template gives ordinary expense lines (Groceries) and an income line.
  await startFromEssentialsTemplate(page)

  await addAccount(page, { name: 'Main', opening: '500', openingDate: '2026-01-01' })
  await addAccount(page, { name: 'Stash', opening: '1000', openingDate: '2026-01-01', type: 'Savings' })
  await createGoalJar(page, { name: 'Holiday', target: '2000', heldIn: 'Stash', setAside: '400' })
  await createGoalJar(page, { name: 'Car', target: '5000', heldIn: 'Stash', setAside: '300' })
  await createGoalJar(page, { name: 'Repairs', target: '800', heldIn: 'Main' })
  await expect(unallocatedRow(page, 'Stash')).toContainText('300.00 unallocated')

  // --- Rule 74: a 600.00 payment from Main (500.00) is refused, naming the balance and date ---
  let tx = await openAddTransaction(page)
  await tx.getByLabel('Transaction payee').fill('Big purchase')
  await tx.getByLabel('Transaction amount').fill('600')
  await tx.getByLabel('Transaction account').selectOption({ label: 'Main' })
  await tx.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await expect(tx.getByRole('alert')).toContainText(/Main would be -100\.00 EUR on \d{4}-\d{2}-\d{2}/)
  await tx.getByRole('button', { name: 'Close' }).click()
  await expect(tx).toBeHidden()

  // --- Rule 78: 500.00 income into Stash → Holiday 300, Car 200; unallocated unchanged ---
  tx = await openAddTransaction(page)
  await tx.getByLabel('Transaction type').selectOption({ label: 'Income' })
  await tx.getByLabel('Transaction payee').fill('Bonus')
  await tx.getByLabel('Transaction amount').fill('500')
  await tx.getByLabel('Transaction account').selectOption({ label: 'Stash' })
  await tx.getByLabel('Amount for Holiday').fill('300')
  await tx.getByLabel('Amount for Car').fill('200')
  await expect(tx.getByText(/Stays unallocated: .*0\.00/)).toBeVisible()
  let posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/transactions') && r.ok(),
  )
  await tx.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await posted
  await expect(tx).toBeHidden()

  await page.getByRole('link', { name: 'Jars' }).click()
  await expect(jarCard(page, 'Holiday')).toContainText('700.00')
  await expect(jarCard(page, 'Car')).toContainText('500.00')
  await expect(unallocatedRow(page, 'Stash')).toContainText('300.00 unallocated')

  // --- Rule 79: a 100.00 payment from Stash on Groceries (not a jar line) asks which jar ---
  tx = await openAddTransaction(page)
  await tx.getByLabel('Transaction payee').fill('Road-trip food')
  await tx.getByLabel('Transaction amount').fill('100')
  await tx.getByLabel('Transaction account').selectOption({ label: 'Stash' })
  await tx.getByLabel('Assign transaction to').selectOption({ label: 'Groceries' })
  const paidFrom = tx.getByLabel(/Which jar in Stash does this come from\?/)
  await expect(paidFrom).toHaveValue('') // unallocated by default
  // Option labels carry the jar's balance ("Holiday (€600.00)"), so pick by the option's value.
  const holidayValue = await paidFrom.locator('option', { hasText: 'Holiday' }).getAttribute('value')
  await paidFrom.selectOption(holidayValue as string)
  posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/transactions') && r.ok(),
  )
  await tx.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await posted
  await expect(tx).toBeHidden()

  await page.getByRole('link', { name: 'Jars' }).click()
  await expect(jarCard(page, 'Holiday')).toContainText('600.00')
  await expect(unallocatedRow(page, 'Stash')).toContainText('300.00 unallocated')

  // --- Rule 80: moving 100.00 from Holiday into Repairs (held in Main) is a bank transfer ---
  await page.getByRole('button', { name: 'Move money from Holiday' }).click()
  const move = page.getByRole('dialog')
  await move.getByLabel('Move to').selectOption({ label: 'Repairs' })
  await move.getByLabel('Move amount').fill('100')
  await expect(move.getByText(/recorded as a bank transfer you have made/)).toBeVisible()
  await move.getByLabel('I have made this transfer').check()
  const transferred = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/transactions/transfer') && r.ok(),
  )
  await move.getByRole('button', { name: 'Confirm move' }).click()
  await transferred
  await expect(move).toBeHidden()
  await expect(jarCard(page, 'Holiday')).toContainText('500.00')
  await expect(jarCard(page, 'Repairs')).toContainText('100.00')

  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('link', { name: 'View Stash', exact: true }).click()
  await expect(page.getByLabel(/^Stash balance:/)).toContainText('1,300.00') // 1,000 + 500 − 100 − 100
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('link', { name: 'View Main', exact: true }).click()
  await expect(page.getByLabel(/^Main balance:/)).toContainText('600.00')
})
