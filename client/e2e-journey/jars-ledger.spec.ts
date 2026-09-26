import { expect, test, type Page } from '@playwright/test'
import { addAccount, createGoalJar, register } from './helpers'

/**
 * The jar ledger through the REAL stack (rules 1–6, 9, 26, 68, 70, 77, 79): a jar is
 * created in its designated account with money already set aside (an allocation that
 * divides the account's money, never a deposit), a payment assigned to the jar's budget
 * line draws from the jar, "Move money" reallocates between the account's unallocated
 * funds and the jar without changing the account balance, and archiving is refused while
 * the jar holds money. The stubbed suites can only fake these balances.
 *
 * Money assertions are symbol-agnostic ("400.00", not "€400.00").
 */

/** From the create-month hero (a fresh registration), start a blank month. */
async function startBlankBudget(page: Page) {
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/** The jar card (the innermost rounded Card around the jar's heading) on the Jars page. */
function jarCard(page: Page, name: string) {
  return page.locator('.rounded-2xl').filter({ has: page.getByRole('heading', { name, exact: true }) }).last()
}

/** The Jars page's per-account "Unallocated" summary row for an account. */
function unallocatedRow(page: Page, account: string) {
  return page.getByRole('region', { name: 'Unallocated' }).getByRole('listitem').filter({ hasText: account })
}

test('a jar divides its account, a payment on its line draws from it, Move money reallocates, and archiving is refused while it holds money', async ({
  page,
}) => {
  await register(page)
  // A month first, so the jar's contribution line is planted in it and a payment can be
  // assigned to that line (rule 79).
  await startBlankBudget(page)

  // --- Account "Savings" opening 1,000.00 on 2026-01-01 ---
  await addAccount(page, { name: 'Savings', opening: '1000', openingDate: '2026-01-01', type: 'Savings' })

  // --- Jar "Holiday" held in Savings with 400.00 already set aside (rule 77 / 9) ---
  await createGoalJar(page, { name: 'Holiday', target: '1000', heldIn: 'Savings', setAside: '400' })
  await expect(jarCard(page, 'Holiday')).toContainText('400.00')
  await expect(jarCard(page, 'Holiday')).toContainText('Held in Savings')
  // The allocation divided the account: 600.00 remains unallocated; the account is unchanged.
  await expect(unallocatedRow(page, 'Savings')).toContainText('600.00 unallocated')
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Savings balance:|^Total balance:/).first()).toContainText('1,000.00')

  // --- A 150.00 expense from Savings on the Holiday line draws from the jar (rule 79) ---
  await page.getByRole('link', { name: 'Transactions' }).click()
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const tx = page.getByRole('dialog')
  await tx.getByLabel('Transaction payee').fill('Hotel deposit')
  await tx.getByLabel('Transaction amount').fill('150')
  await tx.getByLabel('Transaction account').selectOption({ label: 'Savings' })
  await tx.getByLabel('Assign transaction to').selectOption({ label: 'Holiday' })
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/transactions') && r.ok(),
  )
  await tx.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await posted
  await expect(tx).toBeHidden()

  await page.getByRole('link', { name: 'Jars' }).click()
  await expect(jarCard(page, 'Holiday')).toContainText('250.00')
  // Unallocated is untouched: the payment came out of the jar, and the account fell to 850.
  await expect(unallocatedRow(page, 'Savings')).toContainText('600.00 unallocated')

  // --- Move 100.00 from unallocated funds into Holiday (rule 6) ---
  await page.getByRole('button', { name: 'Move money from Holiday' }).click()
  const move = page.getByRole('dialog')
  await expect(move.getByLabel('Money held in Savings')).toContainText('600.00')
  await move.getByLabel('Move from').selectOption({ label: 'Unallocated funds' })
  await move.getByLabel('Move to').selectOption({ label: 'Holiday' })
  await move.getByLabel('Move amount').fill('100')
  const moved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/jars/reallocations') && r.ok(),
  )
  await move.getByRole('button', { name: 'Confirm move' }).click()
  await moved
  await expect(move).toBeHidden()
  await expect(jarCard(page, 'Holiday')).toContainText('350.00')
  await expect(unallocatedRow(page, 'Savings')).toContainText('500.00 unallocated')

  // --- Rule 68: the jar can't supply more than it holds ---
  await page.getByRole('button', { name: 'Move money from Holiday' }).click()
  const over = page.getByRole('dialog')
  await expect(over.getByLabel('Move from')).toHaveValue(/.+/)
  await over.getByLabel('Move amount').fill('500')
  await over.getByRole('button', { name: 'Confirm move' }).click()
  await expect(over.getByRole('alert')).toBeVisible()
  await over.getByRole('button', { name: 'Cancel move' }).click()

  // --- Rule 26: archiving is refused while the jar holds money ---
  await page.getByRole('button', { name: 'Edit Holiday' }).click()
  const edit = page.getByRole('dialog')
  await edit.getByRole('button', { name: 'Archive Holiday' }).click()
  await edit.getByRole('button', { name: 'Confirm archive Holiday' }).click()
  await expect(edit.getByRole('alert')).toContainText(/still holds 350/)
  await edit.getByRole('button', { name: 'Cancel edit' }).click()
  await expect(page.getByRole('heading', { name: 'Holiday', exact: true })).toBeVisible()
})
