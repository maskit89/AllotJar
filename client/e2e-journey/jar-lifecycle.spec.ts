import { expect, test, type Page } from '@playwright/test'
import { addAccount, closeMenu, createGoalJar, firstOfMonthAhead, jarAction, lineAction, openJarMenu, register } from './helpers'

/**
 * The jar lifecycle through the REAL stack (W03 rule 83; W04 rules 25, 27, 55, 60–61): a
 * Recurring jar's cycle is marked paid by choosing the payment that settled it and the jar moves
 * on to its next deadline; a Goal's contribution is skipped for the month from the Budget page —
 * the line stays at 0 and the rest of the plan spreads over the months that are left — and is
 * planned again; a Goal is marked completed and stops planning; a jar that never held money is
 * deleted with its planned lines, while one that has can only be archived.
 *
 * Money assertions are symbol-agnostic ("150.00", not "€150.00").
 */

/** From the create-month hero (a fresh registration), start a blank month. */
async function startBlankBudget(page: Page) {
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/** The jar card (the innermost rounded card around the jar's heading) on the Jars page. Its
 * actions (and its note: the last cycle, the month's plan) sit behind its ⋯. */
function jarCard(page: Page, name: string) {
  return page.locator('.rounded-2xl').filter({ has: page.getByRole('heading', { name, exact: true }) }).last()
}

/**
 * Create a Recurring jar — one that repeats yearly — through the one jar form (rule 73) on the
 * Jars page. The form asks no type: picking a cadence in Repeats makes the jar Recurring and
 * turns its date into "Next due".
 */
async function createRecurringJar(page: Page, jar: { name: string; target: string; nextDue: string; heldIn: string; setAside?: string }) {
  await page.getByRole('link', { name: 'Jars' }).click()
  await page.getByRole('button', { name: 'New jar' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Jar name').fill(jar.name)
  await dialog.getByLabel('Repeats').selectOption({ label: 'Yearly' })
  await dialog.getByLabel('Target amount').fill(jar.target)
  await dialog.getByLabel('Next due date').fill(jar.nextDue)
  await dialog.getByLabel('Funding account').selectOption({ label: jar.heldIn })
  if (jar.setAside) {
    // "Already set aside" is folded under More options (rule 77).
    await dialog.getByRole('button', { name: 'More options' }).click()
    await dialog.getByLabel('Already set aside').fill(jar.setAside)
  }
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/jars') && r.ok())
  await dialog.getByRole('button', { name: 'Add jar' }).click()
  await posted
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: jar.name, exact: true })).toBeVisible()
}

/** An expense from an account, assigned to a budget line, through the Transactions page. */
async function addExpense(page: Page, tx: { payee: string; amount: string; account: string; line: string }) {
  await page.getByRole('link', { name: 'Transactions' }).click()
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Transaction payee').fill(tx.payee)
  await dialog.getByLabel('Transaction amount').fill(tx.amount)
  await dialog.getByLabel('Transaction account').selectOption({ label: tx.account })
  await dialog.getByLabel('Assign transaction to').selectOption({ label: tx.line })
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/transactions') && r.ok())
  await dialog.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await posted
  await expect(dialog).toBeHidden()
}

test('a recurring cycle is marked paid with its payment; a goal is skipped for the month, planned again, completed; an unused jar is deleted', async ({
  page,
}) => {
  await register(page)
  await startBlankBudget(page)
  await addAccount(page, { name: 'Savings', opening: '1000', openingDate: '2026-01-01', type: 'Savings' })

  // --- W03 rule 83: "Road tax" 120.00 due on the 1st of next month, already held in full ---
  await createRecurringJar(page, { name: 'Road tax', target: '120', nextDue: firstOfMonthAhead(1), heldIn: 'Savings', setAside: '120' })
  await expect(jarCard(page, 'Road tax')).toContainText('120.00')
  // The bill is paid from the jar's account on the jar's line (rule 79) …
  await addExpense(page, { payee: 'Transport Malta', amount: '120', account: 'Savings', line: 'Road tax' })
  await page.getByRole('link', { name: 'Jars' }).click()
  await expect(jarCard(page, 'Road tax')).toContainText('0.00')
  // … and the user marks the cycle paid by choosing that payment (the app never infers it).
  await jarAction(page, 'Road tax', 'Mark paid')
  const paid = page.getByRole('dialog')
  await expect(paid.getByRole('button', { name: 'Mark paid' })).toBeDisabled()
  await paid.getByRole('radio', { name: /Transport Malta on .*, .*120\.00/ }).check()
  const marked = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/cycles/paid') && r.ok())
  await paid.getByRole('button', { name: 'Mark paid' }).click()
  await marked
  await expect(paid).toBeHidden()
  // The cycle closed as paid and the jar saves toward its next due date (rule 22: met on time):
  // its ⋯'s note says how the last cycle ended, and the next cycle can be marked paid in turn.
  const roadTaxMenu = await openJarMenu(page, 'Road tax')
  await expect(roadTaxMenu).toContainText(/Last cycle paid .*120\.00/)
  await expect(roadTaxMenu.getByRole('menuitem', { name: 'Mark paid', exact: true })).toBeVisible()
  await closeMenu(page)

  // --- W04 rules 60–61: "Sofa" 300.00 needed by a date three months out → 100.00 a month ---
  await createGoalJar(page, { name: 'Sofa', target: '300', heldIn: 'Savings', deadline: firstOfMonthAhead(3) })
  await page.getByRole('link', { name: 'Dashboard' }).click()
  const planned = page.getByRole('button', { name: /^Planned amount for Sofa:/ })
  await expect(planned).toContainText('100.00')
  // A jar's line offers skip or archive (its ⋯ "Skip this month"), never a bare delete
  // (rule 60), with the server's preview of the months that are left (rule 61: 150.00 each).
  await lineAction(page, 'Sofa', 'Skip this month')
  const remove = page.getByRole('dialog')
  await expect(remove.getByTestId('skip-preview')).toContainText(/spreads this month/)
  await expect(remove.getByTestId('skip-preview')).toContainText('150.00')
  const skipped = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/skip') && r.ok())
  await remove.getByRole('button', { name: 'Skip this month' }).click()
  await skipped
  await expect(remove).toBeHidden()
  await expect(planned).toContainText('0.00')
  await expect(page.getByText('Skipped', { exact: true })).toBeVisible()
  // The Jars page reads the same month.
  await page.getByRole('link', { name: 'Jars' }).click()
  await expect(jarCard(page, 'Sofa')).toContainText('Skipped this month')
  // Planned again: the even plan is back.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  const restored = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/skip') && r.ok())
  await lineAction(page, 'Sofa', 'Plan again this month')
  await restored
  await expect(page.getByRole('button', { name: /^Planned amount for Sofa:/ })).toContainText('100.00')
  await expect(page.getByText('Skipped', { exact: true })).toBeHidden()

  // --- W04 rule 55: completing Sofa stops its plan and keeps the jar listed ---
  await page.getByRole('link', { name: 'Jars' }).click()
  await jarAction(page, 'Sofa', 'Mark completed')
  const complete = page.getByRole('dialog')
  const completed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/complete') && r.ok())
  await complete.getByRole('button', { name: 'Mark completed' }).click()
  await completed
  await expect(complete).toBeHidden()
  await expect(jarCard(page, 'Sofa')).toContainText('Completed')
  const sofaMenu = await openJarMenu(page, 'Sofa')
  await expect(sofaMenu.getByRole('menuitem', { name: 'Mark completed', exact: true })).toHaveCount(0)
  await expect(sofaMenu.getByRole('menuitem', { name: 'Reopen', exact: true })).toBeVisible()
  await closeMenu(page)
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('button', { name: /^Planned amount for Sofa:/ })).toContainText('0.00')

  // --- W04 rule 27: a jar that never held money can be deleted; one that has cannot ---
  await createGoalJar(page, { name: 'Bike', target: '100', heldIn: 'Savings', deadline: firstOfMonthAhead(2) })
  await jarAction(page, 'Bike', 'Edit')
  const editBike = page.getByRole('dialog')
  await editBike.getByRole('button', { name: 'Delete jar' }).click()
  const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/jars/') && r.ok())
  await editBike.getByRole('button', { name: 'Really delete?' }).click()
  await deleted
  await expect(editBike).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Bike', exact: true })).toBeHidden()
  // Road tax has held money: Archive is offered, Delete is not.
  await jarAction(page, 'Road tax', 'Edit')
  const editRoadTax = page.getByRole('dialog')
  await expect(editRoadTax.getByRole('button', { name: 'Archive jar' })).toBeVisible()
  await expect(editRoadTax.getByRole('button', { name: 'Delete jar' })).toHaveCount(0)
  await editRoadTax.getByRole('button', { name: 'Cancel edit' }).click()
  // Its planned lines went with Bike; Sofa's and Road tax's stay.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('button', { name: /^Planned amount for Bike:/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Planned amount for Sofa:/ })).toBeVisible()
})
