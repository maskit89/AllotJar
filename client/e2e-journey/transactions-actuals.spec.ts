import { expect, test, type Page } from '@playwright/test'
import { accountAction, groupAction, lineAction, register, txAction, txRows } from './helpers'

/**
 * Transactions driving REAL budget actuals — the read-time derivation chain the
 * stubbed suites can only fake: POST /transactions through the live API (with the
 * AutoCategorizer's payee inheritance running against real SQL), split slices
 * rolling into each line's actual exactly once, the enforced FK SetNull behaviour
 * when a budget line or an account is deleted (InMemory unit tests are FK-blind),
 * the all-months register that never refetches on a month switch, and the
 * income-transactions-never-balance-a-month rule (PR #172) observed end-to-end.
 *
 * Money assertions are symbol-agnostic ("140.00", not "€140.00") so they hold
 * whatever currency a spec registers with.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The app-wide viewed month defaults to today's month; derive it + the one before. */
function viewedMonths() {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  return {
    current: { year, month, label: `${MONTH_NAMES[month - 1]} ${year}` },
    previous: { year: prevYear, month: prevMonth, label: `${MONTH_NAMES[prevMonth - 1]} ${prevYear}` },
  }
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** From the create-month hero (a fresh no-sample registration), start a blank month. */
async function startBlankBudget(page: Page) {
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/**
 * Add an expense group on the Budget page via the "+ Add group" reveal.
 * The dashboard shows an OPTIMISTIC temp group (id `temp-cat-…`) that renders the
 * same rename textbox as the real one, so waiting for the textbox is not enough —
 * a follow-up add-line against the temp id 400s. Wait for the server response.
 */
async function addExpenseGroup(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add a group', exact: true }).click()
  await page.getByRole('textbox', { name: 'New category group name' }).fill(name)
  const reconciled = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/budget/categories' && r.ok(),
  )
  await page.getByRole('button', { name: 'Add category group', exact: true }).click()
  await reconciled
  // Group names render as rename textboxes, not text.
  await expect(page.getByRole('textbox', { name: `Rename group ${name}`, exact: true })).toBeVisible()
}

/**
 * Add a budget line to a group (the group's ⋯ "Add line" opens the add row, whose input
 * is named "Add a line to {group}"). Same optimistic-temp-row hazard as the group add: wait for the
 * server response so the next action never targets a `temp-…` line id.
 */
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

/** Set a line's planned amount through the click-to-edit control (whole units only). */
async function setPlanned(page: Page, line: string, value: string) {
  await page.getByRole('button', { name: `Planned amount for ${line}`, exact: true }).click()
  const input = page.getByRole('textbox', { name: `Planned amount for ${line}`, exact: true })
  await input.fill(value)
  await input.press('Enter')
  await expect(
    page.getByRole('button', { name: `Planned amount for ${line}`, exact: true }),
  ).toContainText(`${value}.00`)
}

/** Record a transaction through the register's add modal. */
async function addTransaction(
  page: Page,
  tx: { payee: string; amount: string; date?: string; income?: boolean; category?: string; account?: string },
) {
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const dialog = page.getByRole('dialog')
  if (tx.income) await dialog.getByLabel('Transaction type').selectOption({ label: 'Income' })
  if (tx.date) await dialog.getByLabel('Transaction date').fill(tx.date)
  await dialog.getByLabel('Transaction payee').fill(tx.payee)
  await dialog.getByLabel('Transaction amount').fill(tx.amount)
  if (tx.account) await dialog.getByLabel('Transaction account').selectOption({ label: tx.account })
  if (!tx.income) {
    // The form keeps its Category selection across adds (only payee/amount clear —
    // the TX-094 quirk), so an "unassigned" add must RESET the select or it would
    // silently reuse the previous transaction's line and never exercise the
    // auto-categorizer.
    await dialog
      .getByLabel('Assign transaction to')
      .selectOption(tx.category ? { label: tx.category } : { label: 'Unassigned' })
  }
  await dialog.getByRole('button', { name: 'Add transaction', exact: true }).click()
  await expect(dialog).toBeHidden() // closes only on a successful POST
}

/** Split the list row of `payee` (one row with that payee) into 70/30 across two lines, from its ⋯. */
async function splitFirstRow(page: Page, payee: string, lines: [string, string], amounts: [string, string]) {
  const row = txRows(page).filter({ hasText: payee })
  await txAction(page, row, `Split transaction: ${payee}`)
  // Row 1 pre-fills the transaction's current line; only its amount is needed.
  await page.getByRole('textbox', { name: 'Split line 1 amount' }).fill(amounts[0])
  await page.getByRole('combobox', { name: 'Split line 2 category' }).selectOption({ label: lines[1] })
  await page.getByRole('textbox', { name: 'Split line 2 amount' }).fill(amounts[1])
  // Save is disabled until the remainder is exactly zero.
  await expect(page.getByLabel('Remaining to allocate')).toHaveText('Fully allocated')
  await page.getByRole('button', { name: 'Save split' }).click()
  await expect(page.getByRole('button', { name: 'Save split' })).toBeHidden() // editor closed
}

/** A Budget-page line row, located through its rename textbox (names are inputs). */
function budgetLineRow(page: Page, line: string) {
  return page
    .locator('div.group')
    .filter({ has: page.getByRole('textbox', { name: `Rename ${line}`, exact: true }) })
}

test('expense transactions drive real line actuals: explicit assign, payee inheritance, split slices, all-months register', async ({
  page,
}) => {
  const { current, previous } = viewedMonths()

  // A fresh household: blank month, one expense group with two planned lines.
  await register(page)
  await startBlankBudget(page)
  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')
  await addLine(page, 'Everyday', 'Internet')
  await setPlanned(page, 'Groceries', '200')
  await setPlanned(page, 'Internet', '100')

  // Count register fetches for the TX-011 no-refetch assertion (StrictMode may
  // double-fire the mount load; we only compare before/after the month switch).
  let registerFetches = 0
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/transactions') registerFetches += 1
  })

  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByText('No transactions yet')).toBeVisible()
  // Newest first: the Lidl rows below are dated the 5th, 10th, 12th and 14th, each add the newest,
  // so `.first()` is the one just added (their payees differ only in case, which hasText ignores).
  const rows = txRows(page)

  // --- TX-012: add an expense explicitly assigned to Groceries; the row is
  // prepended already carrying its line's tint pill.
  await addTransaction(page, {
    payee: 'Lidl',
    amount: '40',
    date: iso(current.year, current.month, 5),
    category: 'Groceries',
  })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Groceries')

  // --- TX-039 + TX-040: a second same-payee expense left Unassigned inherits the
  // line of the earlier "Lidl" — matching is trim/case/whitespace-insensitive, and
  // the returned DTO already carries the inherited line name.
  await addTransaction(page, { payee: '  LIDL  ', amount: '22', date: iso(current.year, current.month, 10) })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Groceries')

  // Reassign it to Internet via the inline picker (TX-031) — this makes Internet
  // the MOST RECENT "lidl" line, which TX-043 below must prefer.
  await rows.first().getByRole('button', { name: /^Reassign/ }).click()
  await rows.first().getByRole('combobox', { name: /^Assign/ }).selectOption({ label: 'Internet' })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Internet')

  // --- TX-043: a fresh unassigned "lidl" inherits the most recent match (Internet,
  // dated the 10th), not the older Groceries assignment from the 5th.
  await addTransaction(page, { payee: 'lidl', amount: '8', date: iso(current.year, current.month, 12) })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Internet')

  // --- TX-041: an explicit category on create beats the auto-categorizer (which
  // would now suggest Internet).
  await addTransaction(page, {
    payee: 'Lidl',
    amount: '30',
    date: iso(current.year, current.month, 14),
    category: 'Groceries',
  })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Groceries')

  // --- TX-044: split a 100.00 Costco expense 70 Groceries / 30 Internet. The save
  // is gated on "Fully allocated"; the saved row shows the violet Split badge with
  // both slices, and the whole-tx assignment is cleared server-side (no double count —
  // proven by the line actuals below).
  await addTransaction(page, { payee: 'Costco', amount: '100', category: 'Groceries' })
  await splitFirstRow(page, 'Costco', ['Groceries', 'Internet'], ['70', '30'])
  const costcoRow = rows.filter({ hasText: 'Costco' })
  await expect(costcoRow.getByText('Split', { exact: true })).toBeVisible()
  await expect(costcoRow).toContainText('Groceries')
  await expect(costcoRow).toContainText('70.00')
  await expect(costcoRow).toContainText('Internet')
  await expect(costcoRow).toContainText('30.00')

  // A previous-month unassigned expense — the register is all-months (TX-001/TX-011),
  // so it appears immediately even though the viewed month is the current one.
  await addTransaction(page, { payee: 'Cinema', amount: '5', date: iso(previous.year, previous.month, 15) })
  // Dated last month, so it sits below this month's rows: found by its payee.
  await expect(rows.filter({ hasText: 'Cinema' }).getByRole('button', { name: 'Assign Cinema', exact: true })).toBeVisible()

  // The KPIs count the viewed month only: 40+22+8+30+100 out (Cinema is last month's).
  await expect(rows).toHaveCount(6)
  const moneyOut = page.getByLabel(/^Spent in /)
  await expect(moneyOut).toContainText('200.00')

  // --- TX-011: switching the viewed month moves the KPIs to that month's money; the list
  // is NOT refiltered and /transactions is NOT refetched.
  await expect(page.getByLabel(new RegExp(`^Income for ${current.label}:`))).toBeVisible()
  const fetchesBeforeSwitch = registerFetches
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.getByLabel(new RegExp(`^Income for ${previous.label}:`))).toBeVisible()
  await expect(rows).toHaveCount(6)
  await expect(rows.filter({ hasText: 'Costco' })).toBeVisible() // current-month row still listed
  await expect(rows.filter({ hasText: 'Cinema' })).toBeVisible() // previous-month row still listed
  await expect(moneyOut).toContainText(/(?<![\d,])5\.00/) // the previous month's money out: Cinema
  await page.waitForTimeout(300) // give any (buggy) refetch a beat to show up
  expect(registerFetches).toBe(fetchesBeforeSwitch)
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByLabel(new RegExp(`^Income for ${current.label}:`))).toBeVisible()

  // --- Budget side of TX-012/TX-044: each line's read-time actual is the sum of its
  // whole transactions plus its split SLICE — and the split's 100.00 counts exactly
  // once (Groceries would read 240.00 if the parent also landed).
  await page.getByRole('link', { name: 'Dashboard' }).click()
  const groceries = budgetLineRow(page, 'Groceries')
  await expect(groceries).toContainText('140.00 of') // 40 + 30 + the 70.00 slice
  await expect(groceries).toContainText('200.00')
  await expect(groceries).toContainText('60.00 left') // 200 planned − 140 spent
  const internet = budgetLineRow(page, 'Internet')
  await expect(internet).toContainText('60.00 of') // 22 + 8 + the 30.00 slice
  await expect(internet).toContainText('40.00 left')
  // The roll-ups count the split once too: 200.00 spent of 300.00 planned — in the
  // Everyday group's header total and in the Budget card's (i) for all spending.
  const groupHeader = page
    .locator('div.group\\/gh')
    .filter({ has: page.getByRole('textbox', { name: 'Rename group Everyday', exact: true }) })
  await expect(groupHeader).toContainText(/200\.00 spent of \S*300\.00/)
  await page.getByRole('button', { name: 'About this month’s budget', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toContainText(/200\.00 spent of \S*300\.00 planned/)
})

test('the auto-categorizer never inherits a payee match from another household', async ({
  page,
  browser,
}) => {
  // --- TX-042: the suggestion index is owner-scoped (AutoCategorizer filters
  // t.OwnerId == ownerId), so household A teaching "Cross Cafe" → Groceries must
  // leak nothing into household B — even though B has a line with the SAME name,
  // which a naive name-based cross-owner match would happily resolve to.

  // Household A, in its own browser context (own cookie jar): teach the payee.
  const contextA = await browser.newContext()
  const pageA = await contextA.newPage()
  await register(pageA)
  await startBlankBudget(pageA)
  await addExpenseGroup(pageA, 'Everyday')
  await addLine(pageA, 'Everyday', 'Groceries')
  await pageA.getByRole('link', { name: 'Transactions' }).click()
  await addTransaction(pageA, { payee: 'Cross Cafe', amount: '15', category: 'Groceries' })
  await expect(
    txRows(pageA).filter({ hasText: 'Cross Cafe' }).getByRole('button', { name: /^Reassign/ }),
  ).toContainText('Groceries')
  await contextA.close()

  // Household B: an unassigned "Cross Cafe" stays unassigned — no cross-household
  // inheritance (and no crash from a foreign BudgetItemId).
  await register(page)
  await startBlankBudget(page)
  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')
  await page.getByRole('link', { name: 'Transactions' }).click()
  await addTransaction(page, { payee: 'Cross Cafe', amount: '9' })
  await expect(
    txRows(page).filter({ hasText: 'Cross Cafe' }).getByRole('button', { name: 'Assign Cross Cafe', exact: true }),
  ).toBeVisible()

  // And B's Groceries actual is untouched by A's 15.00 — only planning-free zeros.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(budgetLineRow(page, 'Groceries')).toContainText('0.00 of')
})

test('deleting a budget line or an account detaches its transactions but never deletes them', async ({
  page,
}) => {
  // Fresh household with two lines and one account.
  await register(page)
  await startBlankBudget(page)
  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')
  await addLine(page, 'Everyday', 'Internet')

  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Joint')
  // Rule 74: the 140.00 spent below must be covered — an account never goes below zero.
  await dialog.getByLabel('Opening balance').fill('500')
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Joint', { exact: true })).toBeVisible()

  // A whole assigned transaction and a split one, both on the Joint account.
  await page.getByRole('link', { name: 'Transactions' }).click()
  const rows = txRows(page)
  await addTransaction(page, { payee: 'Tesco', amount: '40', category: 'Groceries', account: 'Joint' })
  await addTransaction(page, { payee: 'Costco', amount: '100', category: 'Groceries', account: 'Joint' })
  const tescoRow = rows.filter({ hasText: 'Tesco' })
  const costcoRow = rows.filter({ hasText: 'Costco' })
  // Assert the account tag BEFORE splitting: the split (and assignment) response
  // DTOs currently omit AccountName (missing `.Include(t => t.Account)` in the
  // handlers' post-save re-read), so the row's Account cell blanks to "—" until
  // the next full register fetch — a known display bug, reported separately. The
  // TX-092/TX-093 assertions below all follow fresh page loads, so they are
  // unaffected.
  await expect(tescoRow).toContainText('Joint')
  await expect(costcoRow).toContainText('Joint')
  await splitFirstRow(page, 'Costco', ['Groceries', 'Internet'], ['70', '30'])

  // --- TX-092: deleting the Groceries line (real FK: Transactions.BudgetItemId and
  // TransactionSplits.BudgetItemId are ON DELETE SET NULL) detaches, never deletes.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('textbox', { name: 'Rename Groceries', exact: true })).toBeVisible()
  await lineAction(page, 'Groceries', 'Delete')
  await expect(page.getByRole('textbox', { name: 'Rename Groceries', exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(rows).toHaveCount(2) // nothing was deleted
  // The whole Tesco transaction is back to the dashed "+ Assign" pill.
  await expect(tescoRow.getByRole('button', { name: 'Assign Tesco', exact: true })).toBeVisible()
  // The split survives: the Groceries slice now reads Unassigned, the Internet slice is untouched.
  await expect(costcoRow.getByText('Split', { exact: true })).toBeVisible()
  await expect(costcoRow).toContainText('Unassigned')
  await expect(costcoRow).toContainText('70.00')
  await expect(costcoRow).toContainText('Internet')
  await expect(costcoRow).toContainText('30.00')

  // --- TX-093: deleting the account (confirm modal; Transactions.AccountId is
  // ON DELETE SET NULL) leaves both rows in the register with a "—" account cell.
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await accountAction(page, 'Joint', 'Delete Joint')
  await page.getByRole('button', { name: 'Confirm delete Joint', exact: true }).click()
  await expect(page.getByText('No accounts yet')).toBeVisible()

  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(rows).toHaveCount(2)
  await expect(tescoRow).toContainText('Tesco')
  await expect(tescoRow.getByText('—')).toBeVisible() // account cell fell back to "—"
  await expect(costcoRow.getByText('—')).toBeVisible()
})

test('an income transaction alone never marks the month balanced', async ({ page }) => {
  // --- TX-091 (PR #172): a month with NO planned income and an income TRANSACTION
  // assigned to an income line must keep the "plan your income" prompt — received
  // actuals never satisfy IsBalanced.
  await register(page)
  await startBlankBudget(page)

  // One income source, planned amount left at zero — the month stays "empty". The add row
  // opens from the Income group's ⋯.
  await groupAction(page, 'Income', 'Add income source')
  await page.getByRole('textbox', { name: 'New income source name', exact: true }).fill('Salary')
  await page.getByRole('button', { name: 'Add income source', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Income source name', exact: true })).toHaveValue('Salary')

  // Record a 2,500 income transaction. The add modal hides the Category select for
  // income, so it lands unassigned; assign it to Salary through the inline picker
  // (which offers income lines — the picker is unfiltered, TX-034).
  await page.getByRole('link', { name: 'Transactions' }).click()
  await addTransaction(page, { payee: 'ACME Payroll', amount: '2500', income: true })
  const rows = txRows(page)
  await rows.first().getByRole('button', { name: 'Assign ACME Payroll', exact: true }).click()
  await rows
    .first()
    .getByRole('combobox', { name: 'Assign ACME Payroll', exact: true })
    .selectOption({ label: 'Salary' })
  await expect(rows.first().getByRole('button', { name: /^Reassign/ })).toContainText('Salary')
  // The list's Income KPI sees the money…
  await expect(page.getByLabel(/^Income for /)).toContainText('2,500.00')

  // …and the income line's received actual reflects it on the Budget page, but the
  // hero still prompts for income: Remaining is 0.00 yet the month is NOT balanced —
  // no gold "has a job" badge anywhere.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByRole('group', { name: 'Income', exact: true })).toContainText('2,500.00 received')
  await expect(page.getByLabel(/^Remaining to budget:/)).toContainText('0.00')
  await expect(page.getByText(/Plan your income, then give every/)).toBeVisible()
  await expect(page.getByText(/has a job/)).toHaveCount(0)
})
