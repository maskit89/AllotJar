import { expect, test, type Page } from '@playwright/test'
import { register } from './helpers'

/**
 * Import lifecycle journeys — the generic-CSV behaviours the flagship import.spec.ts round-trip
 * does NOT cover, driven through the live API + real SQL:
 *
 *  1. Same-day identical rows are occurrence-suffixed so BOTH import; the chosen import account is
 *     stamped on every row and its derived balance moves by the file's net; the success tiles sum
 *     real money; and a re-import of the occurrence-suffixed file is a complete no-op (the
 *     deterministic `#occurrence` references dedup against the unique BankReference index).
 *  2. A genuinely ambiguous date file (every date valid as dd/MM AND MM/dd) is pinned to ONE
 *     format for the whole file, the pin is echoed into the mapping UI, and an explicit
 *     "MM/DD/YYYY" override re-reads every row under the user's format.
 *  3. Re-scanning after a mapping edit carries the user's per-row work (category choice, unticked
 *     rows) forward for rows whose reference is unchanged, and the commit + success sums reflect
 *     only the included rows.
 *
 * Money assertions are symbol-agnostic ("950.00", not "€950.00") because the registration form
 * pre-selects the currency from the browser locale.
 */

/** Upload a statement buffer on /import and advance to the review phase. */
async function upload(page: Page, statement: string, opts: { accountName?: string } = {}) {
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Import transactions' })).toBeVisible()
  if (opts.accountName) {
    await page.getByLabel('Add to account').selectOption({ label: opts.accountName })
  }
  await page.getByLabel('Statement file').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(statement),
  })
  await page.getByRole('button', { name: 'Review transactions' }).click()
}

/**
 * Add an account through the Accounts page modal (same pattern as transfers-balances.spec.ts).
 * The currency is chosen explicitly so the account matches the EUR statement rows regardless of
 * the locale-detected registration default. Account names avoid the type-chip labels
 * (Current/Savings/Cash/…) so strict-mode lookups never collide with a card's chip.
 */
async function addAccount(page: Page, name: string) {
  await page.goto('/accounts')
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(name)
  await dialog.getByLabel('Account currency').selectOption({ label: 'Euro (€)' })
  await dialog.getByLabel('Opening balance').fill('0')
  // Rule 40: the balance is tracked from the opening date; the statement rows are dated 2026.
  await dialog.getByLabel('Opening date').fill('2026-01-01')
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden() // closes only on a successful POST
  await expect(page.getByRole('link', { name: `View ${name}`, exact: true })).toBeVisible()
}

// Two byte-identical charges on the same day (same date/amount/description → same dedup
// signature) plus one credit — the occurrence-suffix file.
const OCCURRENCE_STATEMENT = [
  'Date,Description,Amount,Currency',
  '2026-06-18,GYM CLUB,-25.00,EUR',
  '2026-06-18,GYM CLUB,-25.00,EUR',
  '2026-06-19,ACME PAYROLL,1000.00,EUR',
  '',
].join('\n')

test('same-day duplicate rows both import into the chosen account, its balance moves by the net, and a re-import is a complete no-op', async ({
  page,
}) => {
  await register(page)
  await addAccount(page, 'Bank Feed')

  // --- IMP-057: both identical GYM CLUB rows survive the per-file dedup — the parser gives them
  // distinct `csv:{hash}#0` / `#1` references, so the preview offers all 3 rows for review.
  await upload(page, OCCURRENCE_STATEMENT, { accountName: 'Bank Feed' })
  await expect(page.getByText(/3 new transactions to review/)).toBeVisible()
  await expect(page.getByLabel('Include GYM CLUB on 2026-06-18')).toHaveCount(2)
  await expect(page.getByLabel('Include ACME PAYROLL on 2026-06-19')).toBeVisible()

  // --- IMP-010: the chosen import account is announced above the grid.
  await expect(page.getByText(/Importing into Bank Feed\./)).toBeVisible()

  await page.getByRole('button', { name: 'Import 3 transactions' }).click()
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()

  // --- IMP-067: the success tiles sum REAL money from the file — both occurrence rows count
  // toward Money out (25.00 + 25.00), the credit toward Money in.
  await expect(page.getByText('3 transactions added')).toBeVisible()
  const moneyIn = page.locator('div', { has: page.getByText('Money in', { exact: true }) }).last()
  const moneyOut = page.locator('div', { has: page.getByText('Money out', { exact: true }) }).last()
  await expect(moneyIn).toContainText('1,000.00')
  await expect(moneyOut).toContainText('50.00')

  // --- IMP-069: every committed row was stamped with the account, so its derived balance reflects
  // the import's net (+1,000.00 − 25.00 − 25.00 = 950.00) — proof at the DB level that BOTH
  // occurrence rows persisted, not just one.
  await page.goto('/accounts')
  await page.getByRole('link', { name: 'View Bank Feed', exact: true }).click()
  await expect(page.getByLabel(/^Bank Feed balance:/)).toContainText('950.00')

  // --- IMP-056 + IMP-057 + IMP-082: re-importing the identical file skips EVERYTHING — the
  // occurrence-suffixed references are deterministic across runs, so all 3 rows (including both
  // same-signature ones) match existing BankReferences: zero new rows, no grid, no commit button.
  await upload(page, OCCURRENCE_STATEMENT, { accountName: 'Bank Feed' })
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
  await expect(page.getByText(/all 3 were skipped as duplicates/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Import \d+ transaction/ })).toHaveCount(0)
})

// Every date in this file parses as BOTH dd/MM and MM/dd — the genuinely ambiguous case.
const AMBIGUOUS_STATEMENT = [
  'Date,Description,Amount',
  '03/04/2026,ALPHA SHOP,-10.00',
  '05/06/2026,BETA STORE,-20.00',
  '',
].join('\n')

test('an ambiguous date file is pinned to one format for the whole file, and an explicit override re-reads every row', async ({
  page,
}) => {
  await register(page)
  await upload(page, AMBIGUOUS_STATEMENT)
  await expect(page.getByText(/2 new transactions to review/)).toBeVisible()

  // --- IMP-026 + IMP-027: with both rows tying under dd/MM and MM/dd, the server resolves ONE
  // format for the whole file by preference order (dd/MM before MM/dd), pins it into the echoed
  // mapping (the select shows it — not "Auto-detect") and reports it in the readout. Every row is
  // read under that single format: 03/04 → 3 April, 05/06 → 5 June (never a mixed split).
  await expect(page.getByLabel('Date format')).toHaveValue('dd/MM/yyyy')
  await expect(page.getByText(/We read your dates as/)).toContainText('DD/MM/YYYY')
  await expect(page.getByLabel('Include ALPHA SHOP on 2026-04-03')).toBeVisible()
  await expect(page.getByLabel('Include BETA STORE on 2026-06-05')).toBeVisible()

  // --- IMP-028 (+ IMP-064 gating): choosing an explicit MM/DD/YYYY dirties the mapping (import
  // blocks until a re-scan applies it), and the re-scan re-reads EVERY row under the user's
  // format — 03/04 is now 4 March, 05/06 now 6 May.
  await page.getByLabel('Date format').selectOption('MM/dd/yyyy')
  await expect(page.getByRole('button', { name: /Import \d+ transaction/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Apply changes & re-scan' }).click()

  await expect(page.getByLabel('Include ALPHA SHOP on 2026-03-04')).toBeVisible()
  await expect(page.getByLabel('Include BETA STORE on 2026-05-06')).toBeVisible()
  await expect(page.getByLabel('Include ALPHA SHOP on 2026-04-03')).toHaveCount(0)
  // The explicit choice survives the re-scan echo (it is now the pinned format).
  await expect(page.getByLabel('Date format')).toHaveValue('MM/dd/yyyy')
  await expect(page.getByText(/We read your dates as/)).toContainText('MM/DD/YYYY')
  await expect(page.getByRole('button', { name: /Import \d+ transaction/ })).toBeEnabled()
})

const CARRYOVER_STATEMENT = [
  'Date,Description,Amount,Currency',
  '2026-06-10,CORNER BAKERY,-12.40,EUR',
  '2026-06-11,NIGHT MARKET,-30.00,EUR',
  '',
].join('\n')

test('a re-scan carries per-row work forward for unchanged rows, and the commit reflects only the included rows', async ({
  page,
}) => {
  // Sample figures give the review grid REAL budget lines to categorise against.
  await register(page, { sampleBudget: true })
  await upload(page, CARRYOVER_STATEMENT)
  await expect(page.getByText(/2 new transactions to review/)).toBeVisible()

  // Per-row work: categorise one row to a seeded line, untick the other.
  const category = page.getByLabel('Category for CORNER BAKERY on 2026-06-10')
  await category.selectOption({ label: 'Groceries' })
  const groceriesId = await category.inputValue()
  await page.getByLabel('Include NIGHT MARKET on 2026-06-11').uncheck()

  // --- IMP-064: editing the Number format (a control whose change does NOT alter these rows'
  // parse, so their references survive) dirties the mapping and blocks the import.
  await page.getByLabel('Number format').selectOption('1')
  await expect(page.getByRole('button', { name: /Import \d+ transaction/ })).toBeDisabled()
  await expect(page.getByText(/changed the column mapping/)).toBeVisible()

  // --- IMP-065 + IMP-020: the re-scan re-parses with the edited mapping; both rows come back with
  // unchanged references, so the category choice AND the untick carry forward.
  await page.getByRole('button', { name: 'Apply changes & re-scan' }).click()
  await expect(category).toHaveValue(groceriesId)
  await expect(page.getByLabel('Include NIGHT MARKET on 2026-06-11')).not.toBeChecked()

  // --- IMP-040 + IMP-067: only the included row is committed, and the success sums cover just
  // that row (12.40 out, nothing in) — not the whole file.
  await page.getByRole('button', { name: 'Import 1 transaction' }).click()
  // The statement's rows are dated June 2026 while the journey runs in the live current month,
  // so budgeting them to this month's lines is the deliberate cross-month case — confirm it
  // (the server would reject an unacknowledged commit).
  await expect(page.getByText('Budget to a different month?')).toBeVisible()
  await page.getByRole('button', { name: 'Import anyway' }).click()
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  await expect(page.getByText('1 transaction added')).toBeVisible()
  const moneyIn = page.locator('div', { has: page.getByText('Money in', { exact: true }) }).last()
  const moneyOut = page.locator('div', { has: page.getByText('Money out', { exact: true }) }).last()
  await expect(moneyIn).toContainText('0.00')
  await expect(moneyOut).toContainText('12.40')

  // --- IMP-070 (journey leg): the committed row persisted with its category — the register shows
  // CORNER BAKERY assigned to Groceries, and the unticked NIGHT MARKET row was never created.
  await page.goto('/transactions')
  const row = page.locator('tbody tr').filter({ hasText: 'CORNER BAKERY' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Groceries')
  await expect(page.getByText('NIGHT MARKET')).toHaveCount(0)
})
