import { expect, test, type Page } from '@playwright/test'
import { register } from './helpers'

/**
 * Allocation end-to-end through the REAL stack (the ALLOC deferred set): a genuine
 * 2-member household — accounts, member incomes, a savings jar with a funding
 * account, a planned month — walks the AllocationPage waterfall against live SQL,
 * then commits. The stubbed suites fake the preview/commit contract; these journeys
 * exercise the real IncomeAllocator over HTTP, the no-source commit guard, the
 * committed banner, the idempotent re-commit (prefix-delete + recreate of the
 * `alloc:{y}-{m}:{memberId}` BankReference transfers), the real register rows and
 * derived account balances they move, and the stranded-surplus / nothing-to-save
 * notes with real data.
 *
 * KNOWN BUG (worked around here, documented in the skipped test at the bottom):
 * against the real API a fresh household CANNOT open the "Set up allocation" modal.
 * GET /api/allocation/profile returns 204 No Content (not the JSON null the client
 * and its unit-test stubs assume), axios maps 204 → data '', and `'' ?? null` keeps
 * the empty string — so `profile` becomes `''`. That renders the no-profile empty
 * state fine, but `openSettings → syncFormFromProfile` evaluates `''?.rules.find`
 * (optional chaining does not short-circuit on ''), throwing a TypeError before
 * `setShowSettings(true)` runs. First-time setup is therefore impossible through
 * the UI. These journeys seed the profile via the raw PUT /api/allocation/profile
 * with EXACTLY the body the client's `standardRules` would send, then drive every
 * later step (settings edits against the existing profile, preview, commit) through
 * the real UI — the Settings modal works once a real profile object exists.
 *
 * Money assertions are symbol-agnostic ("2,500.00", not "€2,500.00") because the
 * registration form pre-selects the currency from the browser locale, while the
 * commit stamps transfers EUR (the documented ALLOC-058 limitation).
 *
 * Each test registers its own fresh user so the specs stay isolated.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The app's viewed month is the real current month (browser clock = server clock). */
function currentPeriod() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, name: MONTH_NAMES[now.getMonth()] }
}

/**
 * Capture the SPA's own bearer header from its traffic — the access token lives in
 * memory only (never a cookie), so direct page.request calls must replay it.
 */
function captureAuth(page: Page): () => string | undefined {
  let header: string | undefined
  page.on('request', (r) => {
    const h = r.headers()['authorization']
    if (h && r.url().includes('/api/')) header = h
  })
  return () => header
}

/**
 * Run a mutation and wait for its API response (2xx). Optimistic UI updates the DOM
 * before the server confirms, so later full-stack assertions could race the write.
 */
async function committed(
  page: Page,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string | ((u: string) => boolean),
  action: () => Promise<void>,
): Promise<void> {
  const matches = typeof url === 'string' ? (u: string) => u.includes(url) : url
  const done = page.waitForResponse(
    (r) => r.request().method() === method && matches(r.url()) && r.ok(),
  )
  await action()
  await done
}

/** The month-create POST is exactly /api/budget (…/categories etc. must not match). */
const createMonthUrl = (u: string) => new URL(u).pathname === '/api/budget'

/** From the create-month hero (a fresh no-sample registration), start a blank month. */
async function startBlankBudget(page: Page) {
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/**
 * Add an expense group on the Budget page. The dashboard shows an OPTIMISTIC temp
 * group first, so wait for the server POST before acting on the group.
 */
async function addExpenseGroup(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add a group', exact: true }).click()
  await page.getByRole('textbox', { name: 'New category group name' }).fill(name)
  await committed(
    page,
    'POST',
    (u) => new URL(u).pathname === '/api/budget/categories',
    () => page.getByRole('button', { name: 'Add category group', exact: true }).click(),
  )
  await expect(page.getByRole('textbox', { name: `Rename group ${name}`, exact: true })).toBeVisible()
}

/** Add a budget line to a group (same optimistic-temp-row hazard: wait for the POST). */
async function addLine(page: Page, group: string, name: string) {
  await page.getByRole('button', { name: `Add a line to ${group}`, exact: true }).click()
  await page.getByRole('textbox', { name: `Add a line to ${group}`, exact: true }).fill(name)
  await committed(
    page,
    'POST',
    (u) => /^\/api\/budget\/categories\/[^/]+\/items$/.test(new URL(u).pathname),
    () => page.keyboard.press('Enter'),
  )
  await expect(page.getByRole('textbox', { name: `Rename ${name}`, exact: true })).toBeVisible()
}

/**
 * Set a line's planned amount through the click-to-edit control. `formatted` is the
 * grouped at-rest rendering ("2,000.00") — the raw value has no thousands separator.
 */
async function setPlanned(page: Page, line: string, value: string, formatted: string) {
  const button = page.getByRole('button', { name: `Planned amount for ${line}`, exact: true })
  const input = page.getByRole('textbox', { name: `Planned amount for ${line}`, exact: true })
  await button.click()
  try {
    await input.waitFor({ state: 'visible', timeout: 2_000 })
  } catch {
    await button.click() // an add-line reconcile swapped the row out mid-click
    await input.waitFor({ state: 'visible' })
  }
  await input.fill(value)
  await committed(page, 'PUT', '/api/budget/items/', () => input.press('Enter'))
  await expect(button).toContainText(formatted)
}

/**
 * Add an account through the Accounts page modal. Names deliberately avoid the
 * type-chip labels (Current/Savings/Cash/…) so strict-mode lookups never collide.
 */
async function addAccount(page: Page, acc: { name: string; opening: string }) {
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(acc.name)
  await dialog.getByLabel('Opening balance').fill(acc.opening)
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden() // closes only on a successful POST
  await expect(page.getByRole('link', { name: `View ${acc.name}`, exact: true })).toBeVisible()
}

/**
 * Create a Goal jar held in a funding account through the real /jars modal.
 * Goal + no date → the accrual calculator plans (target − 0) ÷ 12 per month when the
 * jar's line is appended into a newly created budget month.
 */
async function createGoalJar(page: Page, jar: { name: string; target: string; heldIn: string }) {
  await page.getByRole('button', { name: 'New jar' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Jar name').fill(jar.name)
  // exact — the adjacent InfoHint is aria-labelled "About jar types" (a superstring).
  await dialog.getByLabel('Jar type', { exact: true }).selectOption({ label: 'Goal' })
  await dialog.getByLabel('Target amount').fill(jar.target)
  await dialog.getByLabel('Funding account').selectOption({ label: jar.heldIn })
  await committed(page, 'POST', '/api/jars', () =>
    dialog.getByRole('button', { name: 'Add jar' }).click(),
  )
  await expect(page.getByRole('heading', { name: jar.name })).toBeVisible()
}

/**
 * Rename the auto-seeded owner member (first name "Journey") and give them an income
 * and a personal savings account, through the People page row editor (hover-revealed).
 */
async function configureOwnerMember(
  page: Page,
  m: { newName: string; income: string; savings: string },
) {
  const row = page.locator('tbody tr').filter({ hasText: 'Journey' })
  await row.hover()
  await page.getByRole('button', { name: 'Edit Journey', exact: true }).click()
  await page.getByLabel('Name for Journey', { exact: true }).fill(m.newName)
  await page.getByLabel('Net monthly income for Journey', { exact: true }).fill(m.income)
  await page.getByLabel('Savings account for Journey', { exact: true }).selectOption({ label: m.savings })
  await committed(page, 'PUT', '/api/members/', () =>
    page.getByRole('button', { name: 'Save Journey', exact: true }).click(),
  )
  await expect(page.getByText(m.newName, { exact: true })).toBeVisible()
}

/** Add a second person (income, optional savings account) via the People page modal. */
async function addPerson(page: Page, m: { name: string; income: string; savings?: string }) {
  // exact + first — the dialog's submit shares the name and "Cancel add person" is a superstring.
  await page.getByRole('button', { name: 'Add person', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Person name', { exact: true }).fill(m.name)
  await dialog.getByLabel('Net monthly income', { exact: true }).fill(m.income)
  if (m.savings) {
    await dialog.getByLabel('Savings account', { exact: true }).selectOption({ label: m.savings })
  }
  await committed(page, 'POST', '/api/members', () =>
    dialog.getByRole('button', { name: 'Add person', exact: true }).click(),
  )
  await expect(dialog).toBeHidden()
}

// Wire enums (docs/testing/cases/14-allocation.md): AllocationRuleType and SplitMethod.
const RULE = { FundEnvelopes: 0, FundJars: 1, FixedPerMember: 2, SplitRemainderToMembers: 3 }
const SPLIT = { Equal: 0, ByIncomeRatio: 1, BalanceTilt: 2 }

/**
 * Seed the allocation profile via the raw PUT — byte-for-byte the body the client's
 * `standardRules(costSplit, pocket, savingsSplit)` would send from the Set up modal.
 * Needed because the modal cannot open for a profile-less household (the 204-null
 * bug this spec's skipped test documents); every later step still runs through the UI.
 */
async function seedStandardProfile(
  page: Page,
  auth: () => string | undefined,
  opts: {
    sourceName?: string
    pocket?: number
    costSplit?: number
    savingsSplit?: number
    lean?: number
  },
) {
  await expect.poll(auth).toBeTruthy()
  const headers = { Authorization: auth()! }
  let sourceAccountId: string | null = null
  if (opts.sourceName) {
    const res = await page.request.get('/api/accounts', { headers })
    expect(res.ok()).toBeTruthy()
    const accounts = (await res.json()) as Array<{ id: string; name: string }>
    sourceAccountId = accounts.find((a) => a.name === opts.sourceName)!.id
  }
  const cost = opts.costSplit ?? SPLIT.Equal
  const put = await page.request.put('/api/allocation/profile', {
    headers,
    data: {
      id: null,
      name: 'Household allocation',
      sourceAccountId,
      balanceLeanPercent: opts.lean ?? 25,
      rules: [
        { order: 0, type: RULE.FundEnvelopes, split: cost, fixedAmountPerMember: 0 },
        { order: 1, type: RULE.FundJars, split: cost, fixedAmountPerMember: 0 },
        { order: 2, type: RULE.FixedPerMember, split: SPLIT.Equal, fixedAmountPerMember: opts.pocket ?? 0 },
        { order: 3, type: RULE.SplitRemainderToMembers, split: opts.savingsSplit ?? SPLIT.BalanceTilt, fixedAmountPerMember: 0 },
      ],
    },
  })
  expect(put.ok()).toBeTruthy()
}

/** One dark-glass hero stat tile, located by its exact label ("Shared spending" / "To savings"). */
function heroTile(page: Page, label: string) {
  return page.locator('div', { has: page.getByText(label, { exact: true }) }).last()
}

/** One per-member savings tile below the waterfall, located by the member's exact name. */
function memberTile(page: Page, name: string) {
  return page.locator('div', { has: page.getByText(name, { exact: true }) }).last()
}

/** One waterfall step row by its label. */
function waterfallRow(page: Page, label: string) {
  return page.locator('li', { hasText: label })
}

/** Save the allocation settings modal and wait for the PUT + the preview reload. */
async function saveAllocationSettings(page: Page): Promise<{ rules: unknown[]; sourceAccountId: string | null }> {
  const put = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/allocation/profile' && r.ok(),
  )
  const preview = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname.startsWith('/api/allocation/preview/') && r.ok(),
  )
  await page.getByRole('button', { name: 'Save allocation settings', exact: true }).click()
  const profile = await (await put).json()
  await preview
  return profile
}

/** Click Allocate and wait for the commit POST; returns the result DTO. */
async function commitAllocation(page: Page): Promise<{ transfersCreated: number }> {
  const post = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/allocation/commit/') && r.ok(),
  )
  await page.getByRole('button', { name: 'Commit allocation', exact: true }).click()
  return await (await post).json()
}

/** The account-detail hero balance (aria-label "<name> balance: <amount>"). */
function detailBalance(page: Page, name: string) {
  return page.getByLabel(new RegExp(`^${name} balance:`))
}

test('a two-member household walks the waterfall: solo gate, no-source guard, reconciling hero, commit and idempotent re-commit moving real balances', async ({
  page,
}) => {
  test.slow() // one long linear journey: full household fixture + two commits
  const { year, month, name: monthName } = currentPeriod()
  const auth = captureAuth(page)

  await register(page)

  // --- ALLOC-002 + ALLOC-001: solo household — nav link absent, but the route
  // itself renders the "Add people first" gate, whose button lands on /people.
  await expect(page.getByRole('link', { name: 'People' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Allocation' })).toHaveCount(0)
  await page.goto('/allocation')
  await expect(page.getByText('Add people first')).toBeVisible()
  await page.getByRole('button', { name: 'Add people' }).click()
  await expect(page).toHaveURL(/\/people$/)

  // --- Fixture: three accounts, a jar held in the source account, a planned month ---
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Joint', opening: '10000' })
  await addAccount(page, { name: 'Chris Pot', opening: '1000' })
  await addAccount(page, { name: 'Robin Pot', opening: '500' })

  // A Goal jar (6,000 ÷ 12 = 500.00/mo) held in the Joint funding account — created
  // BEFORE the month so the blank create appends its accrual-planned Savings line.
  await page.getByRole('link', { name: 'Jars' }).click()
  await createGoalJar(page, { name: 'Holiday', target: '6000', heldIn: 'Joint' })

  await page.getByRole('link', { name: 'Budget' }).click()
  await startBlankBudget(page)
  // The jar line is the FundJars input the engine reads (planned 500.00).
  await expect(page.getByRole('textbox', { name: 'Rename Holiday', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Planned amount for Holiday' })).toContainText('500.00')
  // Envelopes: one expense line planned 2,000.00.
  await addExpenseGroup(page, 'Essentials')
  await addLine(page, 'Essentials', 'Rent')
  await setPlanned(page, 'Rent', '2000', '2,000.00')

  // --- Members: owner becomes Chris (3,000, Chris Pot); Robin joins (2,000, Robin Pot) ---
  await page.getByRole('link', { name: 'People' }).click()
  await configureOwnerMember(page, { newName: 'Chris', income: '3000', savings: 'Chris Pot' })
  await addPerson(page, { name: 'Robin', income: '2000', savings: 'Robin Pot' })
  await expect(page.getByLabel(/^Combined income:/)).toContainText('5,000.00')

  // --- ALLOC-003: the Allocation nav link appears live once the household is shared.
  await expect(page.getByRole('link', { name: 'Allocation' })).toBeVisible()
  await page.getByRole('link', { name: 'Allocation' }).click()

  // --- ALLOC-063 + ALLOC-008: a fresh opt-out account has no starter profile — the
  // no-profile empty state renders with the Owner's Set up button. (Clicking it is
  // the 204-null BUG documented in the skipped test below, so the profile is seeded
  // through the raw API with the exact standard four-rule body instead: ALLOC-018's
  // payload, savings split Equally, NO source account yet.)
  await expect(page.getByText('No allocation set up yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up allocation', exact: true })).toBeVisible()
  await seedStandardProfile(page, auth, { savingsSplit: SPLIT.Equal })
  await page.goto('/allocation')

  // --- ALLOC-049: no source → Allocate disabled with the amber Settings hint, while
  // hero + waterfall still render fine (the source only affects the commit).
  await expect(page.getByRole('button', { name: 'Commit allocation', exact: true })).toBeDisabled()
  await expect(page.getByText(/Set the account to pay shared costs from in/)).toBeVisible()

  // --- ALLOC-029 + ALLOC-030: hero — pool 5,000.00 (Σ member net income), and the two
  // tiles reconcile to it exactly: shared spending 2,500.00 (2,000 envelopes + 500 jars
  // + 0 pocket) + to savings 2,500.00.
  await expect(page.getByLabel(/^Income to allocate:/)).toContainText('5,000.00')
  await expect(heroTile(page, 'Shared spending')).toContainText('2,500.00')
  await expect(heroTile(page, 'To savings')).toContainText('2,500.00')

  // --- ALLOC-007 + ALLOC-033 + ALLOC-034 (zero leg): the "How {month} is allocated"
  // card walks the four named steps with per-step totals; pocket 0 shows no "· each".
  await expect(page.getByRole('heading', { name: `How ${monthName} is allocated` })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Commit allocation', exact: true })).toHaveText(`Allocate ${monthName}`)
  await expect(waterfallRow(page, 'Cover shared costs')).toContainText('2,000.00')
  await expect(waterfallRow(page, 'Fund the jars')).toContainText('500.00')
  await expect(waterfallRow(page, 'Pocket money')).toContainText('0.00')
  await expect(waterfallRow(page, 'Pocket money')).not.toContainText('each')
  await expect(waterfallRow(page, 'Split remainder to savings')).toContainText('2,500.00')

  // --- ALLOC-039 + ALLOC-044: savings sent Equally — the pooled 2,500.00 remainder
  // splits 1,250.00 each; tiles show pre-allocation balance → residual → projected.
  const chrisTile = memberTile(page, 'Chris')
  await expect(chrisTile).toContainText('1,000.00 → saves')
  await expect(chrisTile).toContainText('1,250.00')
  await expect(chrisTile).toContainText('Projected balance')
  await expect(chrisTile).toContainText('2,250.00')
  const robinTile = memberTile(page, 'Robin')
  await expect(robinTile).toContainText('500.00 → saves')
  await expect(robinTile).toContainText('1,250.00')
  await expect(robinTile).toContainText('1,750.00')

  // --- ALLOC-019 + ALLOC-015 (hide leg): the settings modal against the EXISTING
  // profile — titled "Allocation settings", primary button "Save", and with the saved
  // savings split (Equally, not Balance) the lean input is hidden.
  await page.getByRole('button', { name: 'Allocation settings', exact: true }).click()
  const settingsDialog = page.getByRole('dialog', { name: 'Allocation settings' })
  await expect(settingsDialog).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save allocation settings', exact: true })).toHaveText('Save')
  await expect(settingsDialog.getByLabel('Balance lean percent', { exact: true })).toHaveCount(0)

  // --- ALLOC-021: Cancel discards unsaved edits — a reopened form shows saved values
  // (pocket 0 renders as "0", cost split back on Equally).
  await settingsDialog.getByLabel('Pocket money per member', { exact: true }).fill('200')
  await settingsDialog
    .getByRole('group', { name: 'Split method', exact: true })
    .getByRole('button', { name: 'By income', exact: true })
    .click()
  await settingsDialog.getByRole('button', { name: 'Cancel settings', exact: true }).click()
  await expect(settingsDialog).toBeHidden()
  await page.getByRole('button', { name: 'Allocation settings', exact: true }).click()
  await expect(settingsDialog.getByLabel('Pocket money per member', { exact: true })).toHaveValue('0')
  await expect(
    settingsDialog
      .getByRole('group', { name: 'Split method', exact: true })
      .getByRole('button', { name: 'Equally', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')

  // --- ALLOC-019: set the source through the modal and Save — the PUT round-trips.
  await settingsDialog.getByLabel('Source account', { exact: true }).selectOption({ label: 'Joint' })
  const withSource = await saveAllocationSettings(page)
  expect(withSource.sourceAccountId).not.toBeNull()

  // The guard lifts: hint gone, Allocate enabled.
  await expect(page.getByText(/Set the account to pay shared costs from in/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Commit allocation', exact: true })).toBeEnabled()

  // --- ALLOC-050: commit creates 2 member transfers and shows the count banner.
  const first = await commitAllocation(page)
  expect(first.transfersCreated).toBe(2)
  await expect(page.getByRole('status')).toContainText(`Allocated ${monthName}`)
  await expect(page.getByRole('status')).toContainText('2 savings transfers created')
  await expect(page.getByRole('status')).toContainText('Re-running Allocate replaces them, never doubles up.')

  // --- ALLOC-047: a fresh preview after the commit still shows the PRE-allocation
  // balances (this month's alloc: transfers are excluded), so a re-run sees the same
  // tilt inputs as the first — tiles are byte-stable across runs.
  await page.reload()
  await expect(memberTile(page, 'Chris')).toContainText('1,000.00 → saves')
  await expect(memberTile(page, 'Chris')).toContainText('1,250.00')
  await expect(memberTile(page, 'Robin')).toContainText('500.00 → saves')

  // --- ALLOC-052: re-running the commit replaces the prior transfers, never doubles.
  const second = await commitAllocation(page)
  expect(second.transfersCreated).toBe(2)
  await expect(page.getByRole('status')).toContainText('2 savings transfers created')

  // --- ALLOC-050 + ALLOC-058 (register leg): after TWO commits the register holds
  // exactly two allocation transfers — badge rows, from → to cells, 1st-of-month
  // dates, residual amounts — not four.
  await page.getByRole('link', { name: 'Transactions' }).click()
  const allocRows = page.locator('tbody tr').filter({ hasText: 'Income allocation' })
  await expect(allocRows).toHaveCount(2)
  const chrisRow = allocRows.filter({ hasText: 'Joint → Chris Pot' })
  await expect(chrisRow).toHaveCount(1)
  await expect(chrisRow.getByText('Transfer', { exact: true })).toBeVisible() // the badge
  await expect(chrisRow).toContainText('1,250.00')
  const robinRow = allocRows.filter({ hasText: 'Joint → Robin Pot' })
  await expect(robinRow).toHaveCount(1)
  await expect(robinRow).toContainText('1,250.00')

  // --- ALLOC-052 (balances leg): balances match a SINGLE run — the transfers moved
  // real money once: Joint 10,000 − 2,500; pots up by their residuals; net unchanged.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Total balance:/)).toContainText('11,500.00')
  await page.getByRole('link', { name: 'View Joint', exact: true }).click()
  await expect(detailBalance(page, 'Joint')).toContainText('7,500.00')
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Chris Pot', exact: true }).click()
  await expect(detailBalance(page, 'Chris Pot')).toContainText('2,250.00')
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Robin Pot', exact: true }).click()
  await expect(detailBalance(page, 'Robin Pot')).toContainText('1,750.00')

  // --- ALLOC-058: the stored transfer composition — exactly two alloc: rows survive
  // the re-commit, BankReference = "alloc:{year}-{month}:{memberId}" with the month
  // NOT zero-padded (the idempotency prefix and the unique index both depend on it),
  // Type=Transfer, dated the 1st, distinct members.
  const txResponse = await page.request.get('/api/transactions', {
    headers: { Authorization: auth()! },
  })
  expect(txResponse.ok()).toBeTruthy()
  const transactions = (await txResponse.json()) as Array<{
    bankReference: string | null
    type: number
    date: string
    payee: string
    amount: number
  }>
  const allocTx = transactions.filter((t) => t.bankReference?.startsWith('alloc:'))
  expect(allocTx).toHaveLength(2)
  const firstOfMonth = `${year}-${String(month).padStart(2, '0')}-01`
  for (const t of allocTx) {
    expect(t.bankReference).toMatch(new RegExp(`^alloc:${year}-${month}:.+`)) // month un-padded
    expect(t.type).toBe(2) // Transfer
    expect(t.date.startsWith(firstOfMonth)).toBeTruthy()
    expect(t.payee).toMatch(/^Income allocation/)
    expect(t.amount).toBe(1250)
  }
  expect(new Set(allocTx.map((t) => t.bankReference)).size).toBe(2) // one per member
})

test('a member without a savings account strands their share; over-committing the month flips to nothing-to-save and a re-commit removes the prior transfer', async ({
  page,
}) => {
  test.slow()
  const { name: monthName } = currentPeriod()
  const auth = captureAuth(page)
  await register(page)
  await startBlankBudget(page)

  // Chris will have a pot; Robin deliberately gets NO savings account.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Joint', opening: '5000' })
  await addAccount(page, { name: 'Chris Pot', opening: '0' })

  await page.getByRole('link', { name: 'Budget' }).click()
  await addExpenseGroup(page, 'Essentials')
  await addLine(page, 'Essentials', 'Rent')
  await setPlanned(page, 'Rent', '2000', '2,000.00')

  await page.getByRole('link', { name: 'People' }).click()
  await configureOwnerMember(page, { newName: 'Chris', income: '3000', savings: 'Chris Pot' })
  await addPerson(page, { name: 'Robin', income: '2000' }) // savings left "None"

  // Profile: source Joint, pocket 50.00 each, savings sent Equally (raw-API seed —
  // the first-run modal cannot open, see the skipped BUG test).
  await seedStandardProfile(page, auth, { sourceName: 'Joint', pocket: 50, savingsSplit: SPLIT.Equal })
  await page.goto('/allocation')

  // --- ALLOC-012 + ALLOC-034 (positive leg): the pocket row totals 100.00 (2 × 50.00)
  // and carries the "· 50.00 each" suffix.
  const pocketRow = waterfallRow(page, 'Pocket money')
  await expect(pocketRow).toContainText('50.00 each')
  await expect(pocketRow).toContainText('100.00')

  // Hero: pool 5,000.00 = shared spending 2,100.00 (2,000 + 0 jars + 100 pocket)
  // + to savings 2,900.00 (ALLOC-030 again, different mix).
  await expect(page.getByLabel(/^Income to allocate:/)).toContainText('5,000.00')
  await expect(heroTile(page, 'Shared spending')).toContainText('2,100.00')
  await expect(heroTile(page, 'To savings')).toContainText('2,900.00')

  // --- ALLOC-046: Robin's tile carries the amber no-savings-account note and a 0.00
  // savings balance; the residual itself is a healthy 1,450.00.
  const robinTile = memberTile(page, 'Robin')
  await expect(robinTile).toContainText('No savings account set')
  await expect(robinTile).toContainText('0.00 → saves')
  await expect(robinTile).toContainText('1,450.00')

  // --- ALLOC-055: Robin's positive share is stranded — the amber note names the amount.
  const strandedNote = page.getByText(/has nowhere to go/)
  await expect(strandedNote).toBeVisible()
  await expect(strandedNote).toContainText('1,450.00')

  // --- ALLOC-057 + ALLOC-050 (singular): commit writes only Chris's transfer.
  const first = await commitAllocation(page)
  expect(first.transfersCreated).toBe(1)
  await expect(page.getByRole('status')).toContainText('1 savings transfer created')

  // Register: exactly ONE allocation row; Robin's 1,450.00 stayed in the source.
  await page.getByRole('link', { name: 'Transactions' }).click()
  const allocRows = page.locator('tbody tr').filter({ hasText: 'Income allocation' })
  await expect(allocRows).toHaveCount(1)
  await expect(allocRows.first()).toContainText('Joint → Chris Pot')
  await expect(allocRows.first()).toContainText('1,450.00')
  await page.getByRole('link', { name: 'Accounts' }).click()
  await page.getByRole('link', { name: 'View Joint', exact: true }).click()
  await expect(detailBalance(page, 'Joint')).toContainText('3,550.00') // 5,000 − 1,450 only
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Chris Pot', exact: true }).click()
  await expect(detailBalance(page, 'Chris Pot')).toContainText('1,450.00')

  // --- Over-commit the month: Rent 6,000.00 now exceeds the 5,000.00 pool ---
  await page.getByRole('link', { name: 'Budget' }).click()
  await setPlanned(page, 'Rent', '6000', '6,000.00')
  await page.getByRole('link', { name: 'Allocation' }).click()

  // --- ALLOC-031: negative To savings still reconciles — 6,100.00 spending against
  // the 5,000.00 pool leaves −1,100.00.
  await expect(page.getByLabel(/^Income to allocate:/)).toContainText('5,000.00')
  await expect(heroTile(page, 'Shared spending')).toContainText('6,100.00')
  await expect(heroTile(page, 'To savings')).toContainText('1,100.00')

  // --- ALLOC-056: nothing stranded now (no positive share), so the slate note shows
  // instead of the amber one.
  await expect(page.getByText(/nothing left to move to savings/)).toBeVisible()
  await expect(page.getByText(/has nowhere to go/)).toHaveCount(0)

  // --- ALLOC-045: keep-own residuals gone negative render in the rose tone —
  // Chris −50.00 (3,000 − 3,000 − 50), Robin −1,050.00 (2,000 − 3,000 − 50).
  await expect(memberTile(page, 'Chris').locator('.text-rose-600')).toContainText('50.00')
  await expect(memberTile(page, 'Robin').locator('.text-rose-600')).toContainText('1,050.00')

  // --- ALLOC-051 + ALLOC-052 (replace-to-zero leg): the re-commit needs no transfers,
  // says so in the 0-variant banner, and REPLACES the prior run — deleting Chris's
  // earlier 1,450.00 transfer rather than leaving it stacked.
  const second = await commitAllocation(page)
  expect(second.transfersCreated).toBe(0)
  await expect(page.getByRole('status')).toContainText(
    `Allocated ${monthName} — no savings transfers were needed this month.`,
  )
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.locator('tbody tr').filter({ hasText: 'Income allocation' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Accounts' }).click()
  await page.getByRole('link', { name: 'View Joint', exact: true }).click()
  await expect(detailBalance(page, 'Joint')).toContainText('5,000.00') // fully reverted
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Chris Pot', exact: true }).click()
  await expect(detailBalance(page, 'Chris Pot')).toContainText('0.00')
  await expect(page.getByText('No transactions on this account yet.')).toBeVisible()
})

test('a new couple with equal zero balances previews and commits under the default Balance split (the WaterFill overflow regression)', async ({
  page,
}) => {
  test.slow()
  const auth = captureAuth(page)
  await register(page)
  await startBlankBudget(page)

  // Both pots open at 0.00 — the exact equal-balances top tier that used to overflow.
  await page.getByRole('link', { name: 'Accounts' }).click()
  await addAccount(page, { name: 'Joint', opening: '4000' })
  await addAccount(page, { name: 'Pot A', opening: '0' })
  await addAccount(page, { name: 'Pot B', opening: '0' })

  await page.getByRole('link', { name: 'Budget' }).click()
  await addExpenseGroup(page, 'Essentials')
  await addLine(page, 'Essentials', 'Rent')
  await setPlanned(page, 'Rent', '3000', '3,000.00')

  await page.getByRole('link', { name: 'People' }).click()
  await configureOwnerMember(page, { newName: 'Alex', income: '2500', savings: 'Pot A' })
  await addPerson(page, { name: 'Sam', income: '2500', savings: 'Pot B' })

  // The DEFAULT profile — savings split Balance (BalanceTilt), lean 25 — seeded via
  // the raw API (the first-run modal cannot open, see the skipped BUG test).
  await seedStandardProfile(page, auth, { sourceName: 'Joint' })
  await page.goto('/allocation')

  // --- ALLOC-015 (show leg) + ALLOC-026: with the saved Balance split, the settings
  // modal (existing-profile edit, which works) shows the lean input pre-seeded 25.
  await page.getByRole('button', { name: 'Allocation settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Allocation settings' })
  await expect(
    dialog
      .getByRole('group', { name: 'Savings split method', exact: true })
      .getByRole('button', { name: 'Balance', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByLabel('Balance lean percent', { exact: true })).toHaveValue('25')
  await dialog.getByRole('button', { name: 'Cancel settings', exact: true }).click()
  await expect(dialog).toBeHidden()

  // --- ALLOC-042 (preview leg): BalanceTilt with equal/zero balances must not 500 —
  // the preview renders, and the 2,000.00 remainder levels evenly: 1,000.00 each
  // (ALLOC-041's invariants: sum-exact, both non-negative).
  await expect(page.getByText('Could not compute the allocation preview.')).toHaveCount(0)
  await expect(page.getByLabel(/^Income to allocate:/)).toContainText('5,000.00')
  await expect(heroTile(page, 'Shared spending')).toContainText('3,000.00')
  await expect(heroTile(page, 'To savings')).toContainText('2,000.00')
  await expect(memberTile(page, 'Alex')).toContainText('0.00 → saves')
  await expect(memberTile(page, 'Alex')).toContainText('1,000.00')
  await expect(memberTile(page, 'Sam')).toContainText('0.00 → saves')
  await expect(memberTile(page, 'Sam')).toContainText('1,000.00')

  // --- ALLOC-042 (commit leg): the commit also survives and moves real money evenly.
  const result = await commitAllocation(page)
  expect(result.transfersCreated).toBe(2)
  await expect(page.getByRole('status')).toContainText('2 savings transfers created')
  await page.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByLabel(/^Total balance:/)).toContainText('4,000.00')
  await page.getByRole('link', { name: 'View Joint', exact: true }).click()
  await expect(detailBalance(page, 'Joint')).toContainText('2,000.00')
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Pot A', exact: true }).click()
  await expect(detailBalance(page, 'Pot A')).toContainText('1,000.00')
  await page.getByRole('link', { name: '‹ Accounts' }).click()
  await page.getByRole('link', { name: 'View Pot B', exact: true }).click()
  await expect(detailBalance(page, 'Pot B')).toContainText('1,000.00')
})

test('the first-run Set up allocation modal opens from the no-profile empty state', async ({
  page,
}) => {
  // Reproduced live against the journey stack on 2026-07-17: GET /api/allocation/profile
  // answers 204 No Content for a profile-less household (ASP.NET's null → 204 formatter),
  // axios maps the empty body to '' and the client's `prof?.data ?? null` keeps '', so
  // `profile` is the empty string. The empty state renders (''), but clicking "Set up
  // allocation" throws inside syncFormFromProfile — `''?.rules.find(...)` does NOT
  // short-circuit on '' — so setShowSettings(true) never runs and the modal NEVER opens:
  // first-time allocation setup is impossible through the UI. AllocationPage.test.tsx
  // passes only because its stub resolves `data: null` (a real JSON null). Fix either
  // side (controller returning Ok(null), or normalising falsy → null client-side).
  test.skip(
    true,
    'BUG: GET /api/allocation/profile returns 204 (not JSON null) for a fresh household; profile state becomes "" and openSettings throws in syncFormFromProfile, so the Set up allocation modal never opens - ALLOC-010/ALLOC-018',
  )

  await register(page)
  await page.getByRole('link', { name: 'People' }).click()
  await addPerson(page, { name: 'Robin', income: '2000' })
  await page.getByRole('link', { name: 'Allocation' }).click()

  // ALLOC-008 + ALLOC-010: the Owner's empty state opens the "Set up allocation" modal.
  await expect(page.getByText('No allocation set up yet')).toBeVisible()
  await page.getByRole('button', { name: 'Set up allocation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Set up allocation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save allocation settings', exact: true })).toHaveText('Set up')
})
