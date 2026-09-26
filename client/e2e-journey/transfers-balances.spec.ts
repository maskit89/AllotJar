import { expect, test, type Page } from '@playwright/test'
import { register } from './helpers'

/**
 * Transfers through the REAL stack — the balance-only money moves the stubbed
 * suites can only fake. A transfer is a SINGLE Type=Transfer row (source
 * AccountId + destination TransferAccountId) whose amount is derived into BOTH
 * account balances but into NO budget actual, hero total or allocation. These
 * journeys drive the live POST /transactions/transfer against real SQL and
 * verify the derived balances, the register/detail rendering, the delete
 * revert, the cross-currency guard, and the Type=Transfer injection guard on
 * the generic endpoints (PR #167's money-vanish regression) end-to-end.
 *
 * Money assertions are symbol-agnostic ("1,700.00", not "€1,700.00") because
 * the registration form pre-selects the currency from the browser locale.
 */

// AccountDetailPage signs a transfer by direction with U+2212, not a hyphen.
const MINUS = '−'

const isoToday = () => new Date().toISOString().slice(0, 10)

/** From the create-month hero (a fresh no-sample registration), start a blank month. */
async function startBlankBudget(page: Page) {
  await page.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/**
 * Add an expense group on the Budget page via the "+ Add group" reveal. The
 * dashboard shows an OPTIMISTIC temp group first, so wait for the server POST
 * before acting on the group (a follow-up add-line against the temp id 400s).
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

/** Add a budget line to a group (same optimistic-temp-row hazard: wait for the POST). */
async function addLine(page: Page, group: string, name: string) {
  await page.getByRole('button', { name: `Add a line to ${group}`, exact: true }).click()
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

/**
 * Add an account through the Accounts page modal. Account names deliberately
 * avoid the type-chip labels (Current/Savings/Cash/…) — a name like "Current"
 * would collide with every card's type chip in strict-mode lookups.
 */
async function addAccount(
  page: Page,
  acc: { name: string; opening: string; currencyLabel?: string },
) {
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(acc.name)
  if (acc.currencyLabel) {
    await dialog.getByLabel('Account currency').selectOption({ label: acc.currencyLabel })
  }
  await dialog.getByLabel('Opening balance').fill(acc.opening)
  await dialog.getByLabel('Opening date').fill('2026-01-01')
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden() // closes only on a successful POST
  await expect(page.getByRole('link', { name: `View ${acc.name}`, exact: true })).toBeVisible()
}

/** Open the add modal and switch it to Transfer mode (the ≥2-accounts segmented control). */
async function openTransferForm(page: Page) {
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
  const dialog = page.getByRole('dialog')
  // --- TRF-001: with two or more accounts the "Entry type" control renders…
  const entryType = dialog.getByRole('group', { name: 'Entry type' })
  await expect(entryType).toBeVisible()
  await entryType.getByRole('button', { name: 'Transfer', exact: true }).click()
  // …and the modal becomes the transfer form: Date/Amount/From/To/Note only —
  // no Type, Category or Member field.
  await expect(page.getByRole('dialog', { name: 'Record a transfer' })).toBeVisible()
  await expect(dialog.getByLabel('Transfer amount')).toBeVisible()
  await expect(dialog.getByLabel('Transaction type')).toHaveCount(0)
  await expect(dialog.getByLabel('Assign transaction to')).toHaveCount(0)
  await expect(dialog.getByLabel('Transaction member')).toHaveCount(0)
  return dialog
}

/**
 * Record a completed transfer through the open transfer form; resolves to the returned DTO.
 * The form records the confirmed departure (rule 71); `receivedSameDay` also supplies the
 * receipt so the destination is credited at once, otherwise the amount stays in transit.
 */
async function recordTransfer(
  page: Page,
  t: { amount: string; from: string; to: string; note?: string; receivedSameDay?: boolean },
): Promise<{ id: string; date: string; accountId: string; transferAccountId: string; transferStatus: string }> {
  const dialog = page.getByRole('dialog', { name: 'Record a transfer' })
  await dialog.getByLabel('Transfer amount').fill(t.amount)
  await dialog.getByLabel('Transfer from account').selectOption({ label: t.from })
  await dialog.getByLabel('Transfer to account').selectOption({ label: t.to })
  if (t.note) await dialog.getByLabel('Transfer note').fill(t.note)
  if (t.receivedSameDay !== false) {
    await dialog.getByLabel('Transfer receipt date').fill(await dialog.getByLabel('Transfer date').inputValue())
  }
  // Rule 7: the explicit "I've completed this transfer" confirmation gates the record.
  await dialog.getByLabel('Transfer completed confirmation').check()
  const responsePromise = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/transactions/transfer' &&
      r.ok(),
  )
  await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
  const dto = await (await responsePromise).json()
  await expect(dialog).toBeHidden() // closes only on success
  return dto
}

/** The account-detail hero balance (aria-label "<name> balance: <amount>"). */
function detailBalance(page: Page, name: string) {
  return page.getByLabel(new RegExp(`^${name} balance:`))
}

test('a transfer moves both balances but never the budget, renders badge + from → to and signed detail rows, and delete reverts both legs', async ({
  page,
}) => {
  // A fresh household: blank month with one planned expense line, so the budget
  // side has real numbers a (buggy) transfer could disturb.
  await register(page)
  await startBlankBudget(page)
  await addExpenseGroup(page, 'Everyday')
  await addLine(page, 'Everyday', 'Groceries')
  await setPlanned(page, 'Groceries', '400')
  // Snapshot the dashboard hero — it must be byte-identical after the transfer.
  const remainingBefore = (await page.getByLabel(/^Remaining to budget:/).textContent()) ?? ''
  expect(remainingBefore).toContain('400.00') // 0 income − 400 planned

  // Two same-currency accounts (the add-modal default currency is shared).
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Wallet', opening: '2000' })
  await addAccount(page, { name: 'Pot', opening: '500' })
  await expect(page.getByLabel(/^Total balance:/)).toContainText('2,500.00')

  // --- TRF-001 + TRF-005 + TRF-006: record a 300.00 Wallet→Pot transfer with a
  // custom note through the real modal; the POST returns the single Type=Transfer
  // row and the register prepends it.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await openTransferForm(page)
  await recordTransfer(page, { amount: '300', from: 'Wallet', to: 'Pot', note: 'Stash move' })

  // --- TRF-023: the register row — note as payee (TRF-006), brand Transfer badge
  // in the Category cell, "Wallet → Pot" account cell, and an UNSIGNED amount.
  const rows = page.locator('tbody tr')
  const row = rows.filter({ hasText: 'Stash move' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Transfer', { exact: true })).toBeVisible() // the badge
  await expect(row).toContainText('Wallet → Pot')
  const amountCell = row.locator('td').nth(4)
  await expect(amountCell).toContainText('300.00')
  await expect(amountCell).not.toContainText('+')
  await expect(amountCell).not.toContainText(MINUS)
  // No assign/reassign affordance on a transfer row (the badge replaces the pill).
  await expect(row.getByRole('button', { name: /^Assign|^Reassign/ })).toHaveCount(0)

  // --- TRF-024: no edit ✎ or split ⑂ on a transfer row; delete ✕ is present.
  await expect(row.getByRole('button', { name: /^Edit transaction/ })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /^Split transaction/ })).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Delete transaction: Stash move', exact: true })).toHaveCount(1)

  // --- TRF-027 (transfer-exclusion leg): the hero money-in/out ignore the
  // transfer, it never counts as unassigned, but the row count includes it.
  await expect(page.getByLabel(/^Money in for /)).toContainText('0.00')
  const moneyOut = page.locator('div', { has: page.getByText('Money out', { exact: true }) }).last()
  await expect(moneyOut).toContainText('0.00')
  await expect(page.getByText('All assigned')).toBeVisible()
  await expect(page.getByText('1 transactions')).toBeVisible()

  // --- TRF-005 + TRF-028: with the receipt confirmed on the same day both derived
  // balances moved by the raw amount and the net across accounts is unchanged.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Total balance:/)).toContainText('2,500.00')

  // --- TRF-025: the single-account registers sign the SAME row by direction.
  // Source (Wallet): balance 1,700.00 and a −300.00 row with the from→to cell.
  await page.getByRole('link', { name: 'View Wallet', exact: true }).click()
  await expect(detailBalance(page, 'Wallet')).toContainText('1,700.00')
  const walletRow = page.locator('tbody tr').filter({ hasText: 'Stash move' })
  await expect(walletRow).toContainText('Wallet → Pot')
  await expect(walletRow.locator('td').nth(3)).toContainText(`${MINUS}`)
  await expect(walletRow.locator('td').nth(3)).toContainText('300.00')
  // Destination (Pot): balance 800.00 and the row signed +300.00.
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Pot', exact: true }).click()
  await expect(detailBalance(page, 'Pot')).toContainText('800.00')
  const potRow = page.locator('tbody tr').filter({ hasText: 'Stash move' })
  await expect(potRow).toContainText('Wallet → Pot')
  await expect(potRow.locator('td').nth(3)).toContainText('+')
  await expect(potRow.locator('td').nth(3)).toContainText('300.00')

  // --- TRF-028 (budget-invariance leg): no budget actual moved — Groceries is
  // still untouched and the "Remaining to budget" hero is byte-identical.
  await page.getByRole('link', { name: 'Budget' }).click()
  const groceries = page
    .locator('div.group')
    .filter({ has: page.getByRole('textbox', { name: 'Rename Groceries', exact: true }) })
  await expect(groceries).toContainText('0.00 of')
  await expect(groceries).toContainText('400.00 left')
  await expect(page.getByLabel(/^Remaining to budget:/)).toHaveText(remainingBefore)

  // --- TRF-030: delete the transfer — immediate, NO confirmation dialog — and
  // both legs revert.
  await page.getByRole('link', { name: 'Transactions' }).click()
  const deleted = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/transactions/') && r.ok(),
  )
  await page
    .locator('tbody tr')
    .filter({ hasText: 'Stash move' })
    .getByRole('button', { name: 'Delete transaction: Stash move', exact: true })
    .click()
  await deleted
  await expect(page.getByRole('dialog')).toHaveCount(0) // no confirm modal ever appeared
  await expect(page.getByText('No transactions yet')).toBeVisible()

  // Balances are back to their openings, and both account registers are empty.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Total balance:/)).toContainText('2,500.00')
  await page.getByRole('link', { name: 'View Wallet', exact: true }).click()
  await expect(detailBalance(page, 'Wallet')).toContainText('2,000.00')
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Pot', exact: true }).click()
  await expect(detailBalance(page, 'Pot')).toContainText('500.00')
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
})

test('client-side transfer validation blocks bad input without an API call, and a cross-currency transfer is rejected and moves nothing', async ({
  page,
}) => {
  await register(page)
  await startBlankBudget(page)

  // Two REAL accounts in different currencies (explicitly chosen so the test is
  // independent of the locale-detected default).
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Euro Main', opening: '100', currencyLabel: 'Euro (€)' })
  await addAccount(page, { name: 'Dollar Stash', opening: '100', currencyLabel: 'US dollar ($)' })

  // Count every transfer POST — the client guards below must never send one.
  let transferPosts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/transactions/transfer') transferPosts += 1
  })

  await page.getByRole('link', { name: 'Transactions' }).click()
  const dialog = await openTransferForm(page)

  // --- TRF-011 + TRF-012: a zero amount is blocked client-side with the exact
  // error string and no POST (even with both accounts validly chosen).
  await dialog.getByLabel('Transfer from account').selectOption({ label: 'Euro Main' })
  await dialog.getByLabel('Transfer to account').selectOption({ label: 'Dollar Stash' })
  await dialog.getByLabel('Transfer amount').fill('0')
  await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
  await expect(dialog.getByText('Enter a valid transfer amount greater than zero.')).toBeVisible()

  // --- TRF-012: negative, empty and whitespace-only amounts all hit the same
  // client short-circuit (parseMinor → null) with the same string; the
  // transferPosts counter asserted below proves none of them sent a POST.
  for (const bad of ['-50', '', '   ']) {
    await dialog.getByLabel('Transfer amount').fill(bad)
    await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
    await expect(dialog.getByText('Enter a valid transfer amount greater than zero.')).toBeVisible()
  }

  // --- TRF-013: a valid amount but a missing source is blocked next.
  await dialog.getByLabel('Transfer amount').fill('50')
  await dialog.getByLabel('Transfer from account').selectOption({ label: 'Choose…' })
  await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
  await expect(dialog.getByText('Choose both a source and a destination account.')).toBeVisible()
  await page.waitForTimeout(300) // give any (buggy) POST a beat to fire
  expect(transferPosts).toBe(0)

  // --- Rule 7: without the "I've completed this transfer" confirmation nothing is sent.
  await dialog.getByLabel('Transfer from account').selectOption({ label: 'Euro Main' })
  await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
  await expect(dialog.getByText('Confirm that you’ve completed this transfer before recording it.')).toBeVisible()
  await page.waitForTimeout(300)
  expect(transferPosts).toBe(0)

  // --- TRF-021 + TRF-015: EUR → USD passes the client checks, so the POST goes
  // out and the server's cross-currency guard rejects it (400). The client maps
  // every server failure to the one generic string, prepends no row, and the
  // modal stays open.
  await dialog.getByLabel('Transfer completed confirmation').check()
  const rejected = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/transactions/transfer',
  )
  await dialog.getByRole('button', { name: 'Record transfer', exact: true }).click()
  const rejection = await rejected
  expect(rejection.status()).toBe(400)
  expect(await rejection.text()).toContain('Both accounts must use the same currency to transfer between them.')
  await expect(dialog.getByText('Could not record that transfer.')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Record a transfer' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('No transactions yet')).toBeVisible() // no phantom row

  // --- TRF-021 (moves-nothing leg): both balances are exactly their openings.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await page.getByRole('link', { name: 'View Euro Main', exact: true }).click()
  await expect(detailBalance(page, 'Euro Main')).toContainText('100.00')
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Dollar Stash', exact: true }).click()
  await expect(detailBalance(page, 'Dollar Stash')).toContainText('100.00')
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
})

test('the generic transaction endpoints reject Type=Transfer injection, and re-typing a real transfer clears the dangling counterparty', async ({
  page,
}) => {
  // Capture the app's real bearer token from its own traffic: the access token
  // lives in memory only (never a cookie), so direct page.request calls must
  // replay the Authorization header the SPA sends.
  let authHeader: string | undefined
  page.on('request', (r) => {
    const h = r.headers()['authorization']
    if (h && r.url().includes('/api/')) authHeader = h
  })

  await register(page)
  await startBlankBudget(page)
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Wallet', opening: '2000' })
  await addAccount(page, { name: 'Pot', opening: '500' })
  expect(authHeader).toBeTruthy()

  // --- TX-065 / TRF-032: a bare Type=Transfer on the generic create is a
  // destination-less transfer that would vanish money from the derived balances —
  // the real validator 400s it with the exact guard message.
  const inject = await page.request.post('/api/transactions', {
    headers: { Authorization: authHeader! },
    data: { date: isoToday(), payee: 'Sneaky transfer', amount: 100, type: 2 },
  })
  expect(inject.status()).toBe(400)
  expect(await inject.text()).toContain('Use the transfer action to move money between accounts.')

  // UI-observable leg: nothing was created and no balance moved.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByText('No transactions yet')).toBeVisible()
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Total balance:/)).toContainText('2,500.00')
  await page.getByRole('link', { name: 'View Wallet', exact: true }).click()
  await expect(detailBalance(page, 'Wallet')).toContainText('2,000.00')

  // A REAL transfer to attack via the generic update endpoint.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await openTransferForm(page)
  const dto = await recordTransfer(page, { amount: '300', from: 'Wallet', to: 'Pot' })
  expect(dto.transferAccountId).toBeTruthy()

  // --- TX-065 / TRF-033: PUT with Type=Transfer is rejected by the same rule;
  // the stored row is untouched (still a badge-carrying transfer after reload).
  const putTransfer = await page.request.put(`/api/transactions/${dto.id}`, {
    headers: { Authorization: authHeader! },
    data: { date: dto.date, payee: 'still sneaky', amount: 300, type: 2, accountId: dto.accountId },
  })
  expect(putTransfer.status()).toBe(400)
  expect(await putTransfer.text()).toContain('Use the transfer action to move money between accounts.')
  // A real reload (not a same-route nav click, which never refetches) so the
  // register renders the STORED row, not the optimistic client state.
  await page.goto('/transactions')
  const transferRow = page.locator('tbody tr').first()
  await expect(transferRow.getByText('Transfer', { exact: true })).toHaveCount(2) // payee + badge
  await expect(transferRow).toContainText('Wallet → Pot')

  // --- TX-066 / TRF-034: re-typing the transfer to Income (which the validator
  // allows) must clear the dangling TransferAccountId, or Pot would keep a
  // phantom +300 credit in the derived balances.
  const retype = await page.request.put(`/api/transactions/${dto.id}`, {
    headers: { Authorization: authHeader! },
    data: { date: dto.date, payee: 'Was a transfer', amount: 300, type: 1, accountId: dto.accountId },
  })
  expect(retype.status()).toBe(200)
  const updated = await retype.json()
  expect(updated.type).toBe(1)
  expect(updated.transferAccountId).toBeNull()

  // UI-observable leg (after a real reload): the row is now a clean +Income on
  // Wallet (no badge, no from→to cell), Wallet gains the 300 as income and
  // Pot's credit is GONE.
  await page.goto('/transactions')
  const incomeRow = page.locator('tbody tr').filter({ hasText: 'Was a transfer' })
  await expect(incomeRow).toBeVisible()
  await expect(incomeRow.getByText('Transfer', { exact: true })).toHaveCount(0)
  await expect(incomeRow).not.toContainText('→')
  await expect(incomeRow.locator('td').nth(4)).toContainText('+')
  await expect(incomeRow.locator('td').nth(4)).toContainText('300.00')
  await page.getByRole('link', { name: 'Accounts' }).click()
  await page.getByRole('link', { name: 'View Wallet', exact: true }).click()
  await expect(detailBalance(page, 'Wallet')).toContainText('2,300.00') // 2,000 + 300 income
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Pot', exact: true }).click()
  await expect(detailBalance(page, 'Pot')).toContainText('500.00') // phantom credit cleared
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
})
