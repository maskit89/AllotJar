// Catalog-driven tests for the Transactions area (docs/testing/cases/10-transactions.md, prefix TX).
// These convert P0 + cheap P1/P2 manual cases whose "Automated" field was No/Partial and whose
// behaviour is observable in a jsdom render: hero totals, register row rendering (signs, account &
// category cells, Bill tag), the add modal (field gating, client validation messages), the inline
// assign picker, the split editor (seed/add/remove/remainder/guards/unsplit), inline edit, delete,
// filters, the transfer form, and generic-error mapping. New FILE only — the existing
// TransactionsPage.test.tsx is left untouched; conventions (the shared api mock,
// MemoryRouter + AuthProvider, explicit async timeouts) mirror it exactly.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, HouseholdMemberDto, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { txAction, txDelete, txItems, txNote, txRow } from '../test/rowMenu'
import { TransactionsPage } from './TransactionsPage'
import { formatDate, monthYear, shortDate } from '../lib/dates'

// --- Fixtures ---------------------------------------------------------------
// The catalog's default month: Income group (Salary), Expense group (Groceries + Internet, the
// latter a DueDay=20 bill), and a Savings group (Emergency) — so assign/split option grouping,
// the Bill tag, and expense-vs-income filtering are all exercisable.

function item(
  id: string,
  name: string,
  extra: Partial<BudgetMonthDto['categories'][number]['items'][number]> = {},
): BudgetMonthDto['categories'][number]['items'][number] {
  return {
    id,
    name,
    displayOrder: 0,
    plannedAmount: 0,
    actualAmount: 0,
    remaining: 0,
    savingsId: null,
    savingsAvailable: null,
    dueDay: null,
    isPaid: false,
    ...extra,
  }
}

function budget(): BudgetMonthDto {
  return {
    id: 'm1', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR',
    totalIncome: 2500, totalPlanned: 0, remainingToBudget: 2500, isBalanced: false,
    categories: [
      {
        id: 'c-inc', name: 'Salary', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0,
        items: [item('i-salary', 'Salary')],
      },
      {
        id: 'c-exp', name: 'Everyday', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0,
        items: [item('i-groceries', 'Groceries'), item('i-internet', 'Internet', { dueDay: 20 })],
      },
      {
        id: 'c-sav', name: 'Emergency', kind: 'Savings', displayOrder: 2, totalPlanned: 0, totalActual: 0,
        items: [item('i-emergency', 'Emergency fund', { savingsId: 'jar1', savingsAvailable: 0 })],
      },
    ],
  }
}

// Income-only month (no expense/savings lines) — for the "no candidate lines" split warning.
function incomeOnlyBudget(): BudgetMonthDto {
  return { ...budget(), categories: [budget().categories[0]] }
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-07-10', payee: 'Tesco', amount: 40, currency: 'EUR',
    type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null,
    isSplit: false, splits: [],
    ...over,
  }
}

function accountsFixture(): AccountDto[] {
  return [
    { id: 'a-joint', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 1250, currentBalance: 1250, displayOrder: 0 },
    { id: 'a-rainy', name: 'Rainy Day', type: 1, currency: 'EUR', openingBalance: 500, currentBalance: 500, displayOrder: 1 },
  ]
}

function membersFixture(): HouseholdMemberDto[] {
  return [
    { id: 'mem-alex', name: 'Alex', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.5 },
    { id: 'mem-robin', name: 'Robin', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.5 },
  ]
}

function mockLoad(
  transactions: TransactionDto[],
  accounts: AccountDto[] = [],
  members: HouseholdMemberDto[] = [],
  budgetData: BudgetMonthDto | null = budget(),
) {
  mockGet.mockImplementation((url: string) => {
    // A copy per read, so a test can change the list the next re-read returns.
    if (url === '/transactions') return Promise.resolve({ data: [...transactions] })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/members') return Promise.resolve({ data: members })
    if (url === '/budget/current') return Promise.resolve({ data: budgetData })
    // /auth/me and anything else — a role-less body is ignored by AuthContext.
    return Promise.resolve({ data: budgetData })
  })
}

const renderPage = () => renderWithProviders(<TransactionsPage />)

/** The list row that renders a given payee (the list's main, non-editing row). */
const rowFor = (payee: string): HTMLElement => txRow(payee)

/** A row with no ⋯ (a fee row, a read-only row) keeps its note behind an (i): hovers it, returns the note's text, and leaves. */
async function rowHint(user: ReturnType<typeof userEvent.setup>, payee: string): Promise<string> {
  const button = await screen.findByRole('button', { name: `About ${payee}` }, { timeout: 5000 })
  await user.hover(button)
  const text = (await screen.findByRole('tooltip')).textContent ?? ''
  await user.unhover(button)
  return text
}

/** A row's amount: the figure (its first child) and what is under it (the foreign amount, a fee). */
function amountOf(payee: string): HTMLElement {
  const el = rowFor(payee).querySelector<HTMLElement>('[data-tx-amount]')
  if (!el) throw new Error(`No amount on the row for "${payee}"`)
  return el
}

/** A row's account: the name, "—", or a transfer's "{from} → {to}". */
function accountOf(payee: string): HTMLElement {
  const el = rowFor(payee).querySelector<HTMLElement>('[data-tx-account]')
  if (!el) throw new Error(`No account on the row for "${payee}"`)
  return el
}

/** The dashed gold "+ Assign" chip: the word, the plus glyph, the dashed border. */
function expectFillChip(button: HTMLElement) {
  expect(button).toHaveTextContent(/^Assign$/)
  expect(button.querySelector('svg')).not.toBeNull()
  expect(button.className).toContain('border-dashed')
}

/** A day in the month the top bar shows by default (today's), whose rows the hero counts. */
function thisMonth(day = 10): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

beforeEach(() => {
  resetApiMocks()
})

describe('TransactionsPage catalog — register load, hero & list rendering', () => {
  // TX-001 — register loads every transaction across all months via an UNFILTERED GET /transactions.
  it('loads all months and fires an unfiltered GET /transactions', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't-jul', date: '2026-07-10', payee: 'July buy' }),
      tx({ id: 't-jun', date: '2026-06-15', payee: 'June buy' }),
    ])
    renderPage()

    expect(await screen.findByText('July buy', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('June buy')).toBeInTheDocument()
    // Unfiltered — no year/month query string.
    expect(mockGet).toHaveBeenCalledWith('/transactions')
    expect(mockGet.mock.calls.map((c) => c[0])).not.toContain(expect.stringContaining('year'))
    // The list has no "N transactions" count any more: both rows are there.
    expect(screen.getAllByTestId('tx-row')).toHaveLength(2)
  })

  // TX-002 — empty register shows the first-use empty state; the hero still renders zero totals.
  it('shows the empty state and a zeroed hero when there are no transactions', { timeout: 15000 }, async () => {
    mockLoad([])
    renderPage()

    expect(await screen.findByText('No transactions yet', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(
      screen.getByText('Use + Add transaction to record one, or Import a bank statement.'),
    ).toBeInTheDocument()
    // Income and Spent, unsigned on the tiles.
    expect(screen.getByLabelText(/^Income for .+: €0\.00$/)).toHaveTextContent(/^€0\.00$/)
    expect(screen.getByLabelText(/^Spent in .+: €0\.00$/)).toHaveTextContent(/^€0\.00$/)
    // Nothing to filter or assign: no list card, so no All / Unassigned filter and no count.
    expect(screen.queryByRole('region', { name: 'Transactions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unassigned' })).not.toBeInTheDocument()
    expect(screen.queryByText(/to assign$/)).not.toBeInTheDocument()
    // The toolbar Add button is still present for an Owner.
    expect(screen.getByRole('button', { name: 'Add transaction' })).toBeInTheDocument()
  })

  // TX-003 — hero Money in / Money out sum all income / expense and EXCLUDE transfers.
  it('sums the month’s hero totals across income and expense, excluding transfers and other months', { timeout: 15000 }, async () => {
    mockLoad(
      [
        tx({ id: 't-inc', date: thisMonth(), payee: 'Payday', amount: 2500, type: 1 }),
        tx({ id: 't-e1', date: thisMonth(), payee: 'Tesco', amount: 40, type: 0 }),
        tx({ id: 't-e2', date: thisMonth(), payee: 'Cafe', amount: 6.3, type: 0 }),
        tx({ id: 't-xfer', date: thisMonth(), payee: 'Move', amount: 100, type: 2, accountName: 'Joint', transferAccountName: 'Rainy Day' }),
        // Listed in the register, but not the viewed month's money.
        tx({ id: 't-old', date: '2025-01-15', payee: 'Old rent', amount: 900, type: 0 }),
      ],
      accountsFixture(),
    )
    renderPage()

    // +€2,500.00 income (hero + the income row); €46.30 expense (40 + 6.30) — the Money-out
    // tile value, unique to the hero; the 100 transfer counts in neither total.
    expect((await screen.findAllByText('+€2,500.00', {}, { timeout: 5000 })).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByLabelText(/^Income for .+: €2,500\.00$/)).toHaveTextContent(/^€2,500\.00$/)
    expect(screen.getByLabelText(/^Spent in .+: €46\.30$/)).toBeInTheDocument()
    expect(screen.getByText('€46.30')).toBeInTheDocument()
    expect(screen.queryByText('€146.30')).not.toBeInTheDocument()
    expect(screen.queryByText('+€2,600.00')).not.toBeInTheDocument()
  })

  // TX-004 — the Unassigned tile counts only external, non-split, unassigned transactions.
  it('counts only external non-split unassigned rows in the Unassigned tile', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't-a', payee: 'Assigned', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 't-split', payee: 'Split one', isSplit: true, splits: [{ id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 20 }, { id: 's2', budgetItemId: 'i-internet', budgetItemName: 'Internet', memberId: null, memberName: null, amount: 20 }] }),
      tx({ id: 't-xfer', payee: 'Move', amount: 100, type: 2 }),
      tx({ id: 't-u', payee: 'Plain', budgetItemId: null }),
    ])
    renderPage()

    // Only the one plain unassigned expense counts — split parents and transfers are excluded.
    expect(await screen.findByText('1 to assign', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // TX-006 — row signs: income +green, expense − ink, transfer unsigned grey.
  it('renders income/expense/transfer amount signs and colour classes', { timeout: 15000 }, async () => {
    mockLoad(
      [
        tx({ id: 't-inc', payee: 'Payday', amount: 2500, type: 1 }),
        tx({ id: 't-exp', payee: 'Tesco', amount: 40, type: 0 }),
        tx({ id: 't-xfer', payee: 'Move', amount: 100, type: 2, accountName: 'Joint', transferAccountName: 'Rainy Day' }),
      ],
      accountsFixture(),
    )
    renderPage()
    await screen.findByText('Payday', {}, { timeout: 5000 })

    const income = amountOf('Payday')
    expect(income.textContent).toBe('+€2,500.00')
    expect(income.firstElementChild!.className).toContain('text-ok')

    const expense = amountOf('Tesco')
    expect(expense.textContent).toContain('€40.00')
    expect(expense.textContent!.startsWith('+')).toBe(false) // signed with the minus glyph, not '+'
    expect(expense.textContent!.length).toBeGreaterThan('€40.00'.length)
    expect(expense.firstElementChild!.className).toContain('text-slate-900')

    const transfer = amountOf('Move')
    expect(transfer.textContent).toBe('€100.00') // unsigned
    expect(transfer.firstElementChild!.className).toContain('text-slate-500')
  })

  // TX-007 — account cell renders the account name, "—", or a transfer "{from} → {to}".
  it('renders the account cell as name, dash, or transfer arrow', { timeout: 15000 }, async () => {
    mockLoad(
      [
        tx({ id: 't-j', payee: 'On Joint', accountId: 'a-joint', accountName: 'Joint' }),
        tx({ id: 't-none', payee: 'No account' }),
        tx({ id: 't-xfer', payee: 'Move', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' }),
      ],
      accountsFixture(),
    )
    renderPage()
    await screen.findByText('On Joint', {}, { timeout: 5000 })

    expect(accountOf('On Joint').textContent).toBe('Joint')
    expect(accountOf('No account').textContent).toBe('—')
    expect(accountOf('Move').textContent).toBe('Joint → Rainy Day')
  })

  // TX-008 — the Category cell states: assigned pill (Reassign), Split badge, Transfer badge, +Assign.
  it('renders the four category-cell states with the right affordances', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't-a', payee: 'Assigned', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 't-split', payee: 'Split one', isSplit: true, splits: [{ id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 20 }, { id: 's2', budgetItemId: 'i-internet', budgetItemName: 'Internet', memberId: null, memberName: null, amount: 20 }] }),
      tx({ id: 't-xfer', payee: 'Move', type: 2, amount: 100 }),
      tx({ id: 't-u', payee: 'Plain', budgetItemId: null }),
    ])
    renderPage()
    await screen.findByText('Assigned', {}, { timeout: 5000 })

    // Assigned → a Reassign button carrying the line name.
    const reassign = screen.getByRole('button', { name: /^Reassign Assigned:/ })
    expect(reassign).toHaveTextContent('Groceries')
    // Split → the Split chip + slice summary.
    expect(within(rowFor('Split one')).getByText('Split')).toBeInTheDocument()
    expect(within(rowFor('Split one')).getByText(/Groceries.*Internet/)).toBeInTheDocument()
    // Transfer → Transfer chip, no assign control.
    expect(within(rowFor('Move')).getByText('Transfer')).toBeInTheDocument()
    expect(within(rowFor('Move')).queryByRole('button', { name: /Assign Move/ })).not.toBeInTheDocument()
    // Unassigned → dashed +Assign button.
    expectFillChip(screen.getByRole('button', { name: 'Assign Plain' }))
  })

  // TX-009 — the Bill tag appears on a transaction assigned to a bill line (Internet, DueDay 20).
  it('shows a Bill tag only for a transaction on a bill line', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't-bill', payee: 'Vodafone', budgetItemId: 'i-internet', budgetItemName: 'Internet' }),
      tx({ id: 't-nobill', payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
    ])
    renderPage()
    await screen.findByText('Vodafone', {}, { timeout: 5000 })

    expect(within(rowFor('Vodafone')).getByText('Bill')).toBeInTheDocument()
    expect(within(rowFor('Tesco')).queryByText('Bill')).not.toBeInTheDocument()
  })

  // TX-010 — loading state: "Loading…" shows while /transactions is pending; the hero renders at once.
  it('shows Loading while transactions are pending, with the hero already up', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/transactions') return new Promise(() => {}) // never resolves
      if (url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/members') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: budget() })
    })
    renderPage()

    expect(await screen.findByText(/Loading/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Income')).toBeInTheDocument()
  })

  // TX-010 — page-load-error: a /transactions rejection sets the "Could not load transactions." banner.
  it('shows the load-error banner when GET /transactions rejects', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/transactions') return Promise.reject(new Error('boom'))
      if (url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/members') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: budget() })
    })
    renderPage()

    expect(await screen.findByText('Could not load transactions.', {}, { timeout: 5000 })).toBeInTheDocument()
  })
})

describe('TransactionsPage catalog — add modal fields & gating', () => {
  // TX-013 — Income hides the Category select and posts budgetItemId: null.
  it('hides the Category select for income and posts an unassigned income tx', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ payee: 'Salary', amount: 2500, type: 1 }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Transaction type'), '1') // Income
    expect(screen.queryByLabelText('Assign transaction to')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Transaction payee'), 'Salary')
    await user.type(screen.getByLabelText('Transaction amount'), '2500')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ type: 1, budgetItemId: null }),
      ),
    )
  })

  // TX-016 — the Member select is hidden in a solo household (members.length < 2).
  it('hides the Member select in a solo household', { timeout: 15000 }, async () => {
    mockLoad([], [], [membersFixture()[0]]) // one member only
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Transaction member')).not.toBeInTheDocument()
  })

  // TX-017 — with zero accounts the Account select and the Entry-type toggle are both absent.
  it('hides the Account select and Entry-type toggle with zero accounts', { timeout: 15000 }, async () => {
    mockLoad([], [])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Transaction account')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument()
  })

  // TX-018 — the add-form Category select offers UNFILTERED optgroups (Income & Savings included).
  it('offers expense and savings lines, not income lines, in the add-form Category select', { timeout: 15000 }, async () => {
    mockLoad([])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign transaction to', {}, { timeout: 5000 })
    // The server refuses an expense on an income line, so none is offered.
    expect(within(select).queryByRole('option', { name: 'Salary' })).not.toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Groceries' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Emergency fund' })).toBeInTheDocument()
  })

  // TX-019 — pressing Enter in the Amount field submits the add form.
  it('submits the add form when Enter is pressed in the Amount field', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ payee: 'Tesco' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco')
    await user.type(screen.getByLabelText('Transaction amount'), '40{Enter}')

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/transactions', expect.objectContaining({ amount: 40 })),
    )
  })

  // TX-021 — the Date field defaults to today's UTC calendar date.
  it('defaults the Date field to today (UTC)', { timeout: 15000 }, async () => {
    mockLoad([])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const date = (await screen.findByLabelText('Transaction date', {}, { timeout: 5000 })) as HTMLInputElement
    expect(date.value).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('TransactionsPage catalog — add-transaction validation', () => {
  // TX-023 — empty / whitespace / non-numeric / ambiguous multi-separator amounts are all rejected.
  it('rejects empty, whitespace and non-numeric amounts client-side', { timeout: 20000 }, async () => {
    mockLoad([])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const amount = screen.getByLabelText('Transaction amount')

    for (const bad of ['', '   ', 'abc', '1.2.3', '1,2,3']) {
      await user.clear(amount)
      if (bad) await user.type(amount, bad)
      await user.click(dialog.getByRole('button', { name: 'Add transaction' }))
      expect(await screen.findByText('Enter a valid amount greater than zero.', {}, { timeout: 5000 })).toBeInTheDocument()
    }
    expect(mockPost).not.toHaveBeenCalled()
  })

  // TX-026 — a server-rejected create maps to the fixed generic string (server text never surfaced).
  it('maps a failed create to the generic "Could not add that transaction."', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockRejectedValue(new Error('400 Amount exceeds the supported range.'))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction amount'), '100000000000000')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    expect(await screen.findByText('Could not add that transaction.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).toHaveBeenCalled()
  })
})

describe('TransactionsPage catalog — inline assign picker', () => {
  // TX-030 — assign an unassigned transaction via the inline picker.
  it('assigns an unassigned transaction through the inline picker', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco', hidden: false }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }), 'i-groceries')

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-groceries' }),
    )
    expect(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 })).toBeInTheDocument()
  })

  // #350 P3-1 — the keyboard arrows through the picker (Chrome fires change on a closed select for
  // each arrow): the select stays open, and Enter assigns the line it shows, with one request.
  it('arrows through the picker from the keyboard and assigns on Enter, once', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: 'i-internet', budgetItemName: 'Internet' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco', hidden: false }, { timeout: 5000 }))
    const select = (await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })) as HTMLSelectElement
    for (const value of ['i-groceries', 'i-internet']) {
      fireEvent.keyDown(select, { key: 'ArrowDown' })
      fireEvent.change(select, { target: { value } })
    }
    expect(screen.getByRole('combobox', { name: 'Assign Tesco' })).toBe(select)
    expect(select.value).toBe('i-internet')
    expect(mockPut).not.toHaveBeenCalled()
    fireEvent.keyDown(select, { key: 'Enter' })
    fireEvent.keyDown(select, { key: 'Enter' })
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-internet' }))
    expect(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 })).toHaveTextContent('Internet')
    expect(mockPut).toHaveBeenCalledTimes(1)
  })

  it('leaving the picker after arrowing assigns the line it shows; Escape leaves it unassigned', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco', hidden: false }, { timeout: 5000 }))
    let select = (await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })) as HTMLSelectElement
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.change(select, { target: { value: 'i-groceries' } })
    fireEvent.keyDown(select, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Assign Tesco' })).not.toBeInTheDocument())
    expect(mockPut).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Assign Tesco', hidden: false }))
    select = (await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })) as HTMLSelectElement
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.change(select, { target: { value: 'i-groceries' } })
    fireEvent.blur(select)
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-groceries' }))
    expect(mockPut).toHaveBeenCalledTimes(1)
  })

  // TX-031 — reassign an already-assigned transaction to a different line.
  it('reassigns an already-assigned transaction', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: 'i-internet', budgetItemName: 'Internet' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }), 'i-internet')

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-internet' }),
    )
    // Relabels to the new line and now carries the Bill tag (Internet has a due day).
    expect(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 })).toHaveTextContent('Internet')
    expect(within(rowFor('Tesco')).getByText('Bill')).toBeInTheDocument()
  })

  // TX-032 — clearing the assignment (choosing "Unassigned") reverts to the +Assign pill.
  it('clears an assignment back to the +Assign pill', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: null, budgetItemName: null }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })
    await user.selectOptions(select, within(select).getByRole('option', { name: 'Unassigned' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: null }),
    )
    expectFillChip(await screen.findByRole('button', { name: 'Assign Tesco' }, { timeout: 5000 }))
  })

  // TX-033 — assigning to a line in a different month than the transaction's date prompts to
  // confirm, then re-sends the assignment acknowledged (never a silent cross-month write).
  it('confirms a cross-month assignment and re-sends it acknowledged', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    mockPut
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { errors: { crossMonth: ['This transaction is dated 2026-06 but that budget line is in 2026-07.'] } },
        },
      })
      .mockResolvedValueOnce({ data: tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco', hidden: false }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }), 'i-groceries')

    // First attempt is rejected as cross-month → the confirm dialog appears, not a generic error.
    const confirm = await screen.findByRole('button', { name: 'Budget it anyway' }, { timeout: 5000 })
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-groceries' }),
    )
    expect(screen.queryByText('Could not save that assignment.')).not.toBeInTheDocument()

    // Confirm → re-send acknowledged; the row reassigns.
    await user.click(confirm)
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', {
        budgetItemId: 'i-groceries',
        acknowledgeCrossMonth: true,
      }),
    )
    expect(await screen.findByRole('button', { name: /^Reassign Tesco:/ }, { timeout: 5000 })).toBeInTheDocument()
  })

  // Re-review F1 — an EDIT that moves an assigned transaction across months gets the same
  // confirm-then-acknowledge flow (the server re-validates the retained assignment now).
  it('confirms a cross-month edit and re-sends it acknowledged', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { errors: { crossMonth: ['This transaction is dated 2026-07 but that budget line is in 2026-06.'] } },
        },
      })
      .mockResolvedValueOnce({
        data: tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    await user.click(screen.getByLabelText('Save transaction'))

    // Rejected as cross-month → the confirm dialog, not the generic edit error.
    const confirm = await screen.findByRole('button', { name: 'Budget it anyway' }, { timeout: 5000 })
    expect(screen.queryByText('Could not save that change.')).not.toBeInTheDocument()

    await user.click(confirm)
    await waitFor(() =>
      expect(mockPut).toHaveBeenLastCalledWith(
        '/transactions/t1',
        expect.objectContaining({ acknowledgeCrossMonth: true }),
      ),
    )
  })

  // TX-033 — blurring the assign picker (no selection) closes it without a PUT.
  it('cancels the assign picker on blur without calling the API', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco' }, { timeout: 5000 }))
    await screen.findByRole('combobox', { name: 'Assign Tesco' }, { timeout: 5000 })
    // Click a focusable control elsewhere to blur the select.
    await user.click(screen.getByRole('button', { name: 'All' }))

    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Assign Tesco' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Assign Tesco' })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // TX-034 — the assign picker is UNFILTERED: an income tx can be pointed at an expense/savings line.
  it('offers only income lines in the assign picker for income that is not a refund', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Payday', type: 1, budgetItemId: null })])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Payday' }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign Payday', {}, { timeout: 5000 })
    expect(within(select).getByRole('option', { name: 'Salary' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'Groceries' })).not.toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'Emergency fund' })).not.toBeInTheDocument()
  })

  // TX-038 — an assign failure surfaces the generic error and the row keeps its prior state.
  it('shows the generic assign error and keeps the prior state on failure', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: null })])
    mockPut.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Tesco' }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }), 'i-groceries')

    expect(await screen.findByText('Could not save that assignment.', {}, { timeout: 5000 })).toBeInTheDocument()
    // No optimistic mutation — the row is still unassigned.
    expectFillChip(screen.getByRole('button', { name: 'Assign Tesco' }))
  })
})

describe('TransactionsPage catalog — split editor', () => {
  // TX-045 — the split editor seeds exactly two rows; row 1 inherits the current line & member.
  it('seeds two split rows with row 1 inheriting the line and member', { timeout: 15000 }, async () => {
    mockLoad(
      [tx({ payee: 'Costco', amount: 100, budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: 'mem-robin', memberName: 'Robin' })],
      accountsFixture(),
      membersFixture(),
    )
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    expect((screen.getByLabelText('Split line 1 category') as HTMLSelectElement).value).toBe('i-groceries')
    expect((screen.getByLabelText('Split line 1 member') as HTMLSelectElement).value).toBe('mem-robin')
    expect((screen.getByLabelText('Split line 2 category') as HTMLSelectElement).value).toBe('')
    expect(screen.queryByLabelText('Split line 3 category')).not.toBeInTheDocument()
  })

  // TX-046 — +Add line appends a slice; the per-row ✕ only appears above the 2-row minimum.
  it('adds and removes split lines, hiding remove below three rows', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Costco', amount: 100 })])
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    // At the 2-row minimum, no remove buttons.
    expect(screen.queryByLabelText('Remove split line 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add line' }))
    expect(await screen.findByLabelText('Split line 3 category', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByLabelText('Remove split line 1')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Remove split line 3'))
    await waitFor(() => expect(screen.queryByLabelText('Split line 3 category')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('Remove split line 1')).not.toBeInTheDocument()
  })

  // TX-047 / TX-048 — the remainder chip tracks the live shortfall, and Save is disabled until it hits zero.
  it('tracks the remainder chip and gates Save on an exact-zero remainder', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Costco', amount: 100 })])
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    const chip = screen.getByLabelText('Remaining to allocate')
    expect(chip).toHaveTextContent('100.00 left')
    expect(screen.getByLabelText('Save split')).toBeDisabled()

    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    await user.type(screen.getByLabelText('Split line 2 amount'), '20')
    await waitFor(() => expect(chip).toHaveTextContent('10.00 left'), { timeout: 5000 })
    expect(screen.getByLabelText('Save split')).toBeDisabled()

    await user.clear(screen.getByLabelText('Split line 2 amount'))
    await user.type(screen.getByLabelText('Split line 2 amount'), '30')
    await waitFor(() => expect(chip).toHaveTextContent('Fully allocated'), { timeout: 5000 })
    expect(screen.getByLabelText('Save split')).toBeEnabled()
  })

  // TX-049 — a split line missing its category is blocked client-side even when the amounts sum.
  it('blocks a split with a category-less line', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Costco', amount: 100 })])
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    // Amounts sum to the total (100 + 0) so Save is enabled, but row 1 has no category.
    await user.type(screen.getByLabelText('Split line 1 amount'), '100')
    await waitFor(() => expect(screen.getByLabelText('Save split')).toBeEnabled(), { timeout: 5000 })
    await user.click(screen.getByLabelText('Save split'))

    expect(
      await screen.findByText('Give every split line a category and an amount greater than zero.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // TX-055 — Remove split is exactly assign(id, null): it clears the slices via the assignment endpoint.
  it('unsplits via Remove split (assign null)', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ payee: 'Costco', amount: 100, isSplit: true, splits: [
        { id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 70 },
        { id: 's2', budgetItemId: 'i-internet', budgetItemName: 'Internet', memberId: null, memberName: null, amount: 30 },
      ] }),
    ])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Costco', amount: 100, isSplit: false, splits: [], budgetItemId: null }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    await user.click(await screen.findByRole('button', { name: 'Remove split' }, { timeout: 5000 }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: null }),
    )
  })

  // TX-056 — the split editor warns when no candidate lines exist for the transaction's kind.
  it('warns when there are no candidate lines to split into', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Costco', amount: 100 })], [], [], incomeOnlyBudget())
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Costco', 'Split transaction: Costco')
    expect(await screen.findByText('Add some expense budget lines first.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // TX-057 — the split and edit editors are mutually exclusive (opening one closes the other).
  it('keeps the split and edit editors mutually exclusive', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't1', payee: 'Tesco', amount: 40 }),
      tx({ id: 't2', payee: 'Aldi', amount: 40 }),
    ])
    const user = userEvent.setup()
    renderPage()

    // Open split on Tesco.
    await txAction(user, 'Tesco', 'Split transaction: Tesco')
    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()

    // Opening edit on Aldi closes the split.
    await txAction(user, 'Aldi', 'Edit transaction: Aldi')
    await waitFor(() => expect(screen.queryByLabelText('Split line 1 category')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Edit payee')).toBeInTheDocument()

    // Opening split again on Tesco closes the edit.
    await txAction(user, 'Tesco', 'Split transaction: Tesco')
    await waitFor(() => expect(screen.queryByLabelText('Edit payee')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()
  })

  // TX-058 (W07) — a transfer row is edited through the transfer form, never split or edited inline.
  it('offers the transfer edit, and no inline edit or split, on a transfer row', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Move', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' })], accountsFixture())
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Move', {}, { timeout: 5000 })

    // The row's ⋯ holds exactly Edit transfer and Delete (no inline Edit, no Split).
    const items = await txItems(user, 'Move')
    expect(items).toEqual(['Edit transfer: Move', 'Delete transaction: Move'])
    expect(items).not.toContain('Edit transaction: Move')
    expect(items).not.toContain('Split transaction: Move')
  })

  // TX-059 — three slices that sum exactly at scale 4 (3.33 + 3.33 + 3.34 = 10.00) save cleanly.
  it('saves a three-way split that sums exactly in integer minor units', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Dinner', amount: 10 })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Dinner', amount: 10, isSplit: true, splits: [] }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Dinner', 'Split transaction: Dinner')
    await user.click(screen.getByRole('button', { name: 'Add line' }))
    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-groceries')
    await user.type(screen.getByLabelText('Split line 1 amount'), '3.33')
    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-internet')
    await user.type(screen.getByLabelText('Split line 2 amount'), '3.33')
    await user.selectOptions(await screen.findByLabelText('Split line 3 category', {}, { timeout: 5000 }), 'i-emergency')
    await user.type(screen.getByLabelText('Split line 3 amount'), '3.34')

    await waitFor(() => expect(screen.getByLabelText('Remaining to allocate')).toHaveTextContent('Fully allocated'), { timeout: 5000 })
    await user.click(screen.getByLabelText('Save split'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/splits', {
        allocations: [
          { budgetItemId: 'i-groceries', amount: 3.33, memberId: null },
          { budgetItemId: 'i-internet', amount: 3.33, memberId: null },
          { budgetItemId: 'i-emergency', amount: 3.34, memberId: null },
        ],
        version: null,
      }),
    )
  })
})

describe('TransactionsPage catalog — inline edit & delete', () => {
  // TX-061 — an edit can flip a transaction Expense → Income; the row sign flips to +green.
  it('flips a transaction type from expense to income on edit', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', amount: 40, type: 0 })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', amount: 40, type: 1 }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    await user.selectOptions(screen.getByLabelText('Edit type'), '1') // Income
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ type: 1 })),
    )
    await waitFor(() => expect(amountOf('Tesco').textContent!.startsWith('+')).toBe(true), { timeout: 5000 })
  })

  // TX-063 — editing account and member to their "No …" options clears both (null in the PUT).
  it('clears account and member on edit', { timeout: 15000 }, async () => {
    mockLoad(
      [tx({ payee: 'Tesco', amount: 40, accountId: 'a-joint', accountName: 'Joint', memberId: 'mem-robin', memberName: 'Robin' })],
      accountsFixture(),
      membersFixture(),
    )
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', amount: 40, accountId: null, accountName: null, memberId: null, memberName: null }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    await user.selectOptions(screen.getByLabelText('Edit account'), '') // No account
    await user.selectOptions(screen.getByLabelText('Edit member'), '') // No member
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ accountId: null, memberId: null })),
    )
    await waitFor(() => expect(accountOf('Tesco').textContent).toBe('—'), { timeout: 5000 })
  })

  // TX-071 — a transfer row can be deleted (its single row carries both legs).
  it('deletes a transfer row', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Move', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' })], accountsFixture())
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    await txDelete(user, 'Move')
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/transactions/t1'))
    await waitFor(() => expect(screen.queryByText('Move')).not.toBeInTheDocument())
  })

  // W07 P2-6 — the server deletes a transfer's fee row with it (P71), so the register drops it too.
  it('deleting a transfer with a fee also drops its fee row', { timeout: 15000 }, async () => {
    mockLoad(
      [
        tx({
          id: 't-tr', payee: 'Move', type: 2, amount: 100, accountId: 'a-joint', accountName: 'Joint',
          transferAccountId: 'a-rainy', transferAccountName: 'Rainy Day', fee: 2,
          feeBudgetItemId: 'i-groceries', feeBudgetItemName: 'Groceries',
        }),
        tx({ id: 't-fee', payee: 'Fee: Move', amount: 2, accountId: 'a-joint', accountName: 'Joint', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', feeForTransferId: 't-tr' }),
        tx({ id: 't-other', payee: 'Tesco' }),
      ],
      accountsFixture(),
    )
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    // The fee row says what it is behind its (i) (the row has no chip for it).
    expect(await rowHint(user, 'Fee: Move')).toContain('A transfer’s fee: edit the transfer to change it.')
    await txAction(user, 'Move', 'Delete transaction: Move')
    // The dialog says the fee goes with it.
    const dialog = await screen.findByRole('dialog', { name: 'Delete this transaction?' })
    expect(dialog).toHaveTextContent(/Move · .* · its fee too/)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/transactions/t-tr'))
    await waitFor(() => expect(screen.queryByText('Move')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'About Fee: Move' })).not.toBeInTheDocument()
    expect(screen.queryByText('Fee: Move')).not.toBeInTheDocument()
    expect(screen.getByText('Tesco')).toBeInTheDocument()
    expect(mockDelete).toHaveBeenCalledTimes(1)
  })

  // TX-072 — a delete failure surfaces the generic error and keeps the row.
  it('shows the generic delete error and keeps the row on failure', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco' })])
    mockDelete.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    renderPage()

    await txDelete(user, 'Tesco')
    expect(await screen.findByText('Could not delete that transaction.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Tesco')).toBeInTheDocument()
  })
})

describe('TransactionsPage catalog — filters & count', () => {
  // TX-074 / TX-005 — the Unassigned filter with no matches shows a placeholder; All still lists the
  // WHOLE list (the "N transactions" count is gone: the rows themselves are the count).
  it('shows the empty-filter placeholder while All keeps the whole list', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't1', payee: 'Rent', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 't2', payee: 'Bus', budgetItemId: 'i-internet', budgetItemName: 'Internet' }),
    ])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Rent', {}, { timeout: 5000 })
    expect(screen.getAllByTestId('tx-row')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Unassigned' }))
    expect(await screen.findByText('Nothing left to assign.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryAllByTestId('tx-row')).toHaveLength(0)
    // Back to All: the full list, not a filtered subset.
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getAllByTestId('tx-row')).toHaveLength(2)
  })
})

describe('TransactionsPage catalog — transfer form', () => {
  // TX-077 — the Entry-type toggle is absent with a single account (needs 2+); Account select still shows.
  it('hides the Entry-type toggle with a single account', { timeout: 15000 }, async () => {
    mockLoad([], [accountsFixture()[0]]) // one account
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Transaction account')).toBeInTheDocument()
  })

  // Rules 7/71 — the form records a confirmed departure; the receipt is optional and never invented.
  it('sends the departure as departedOn, an optional receipt, and needs the completed confirmation', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost.mockResolvedValue({ data: tx({ payee: 'Transfer', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.clear(screen.getByLabelText('Transfer date'))
    await user.type(screen.getByLabelText('Transfer date'), '2026-09-30')
    await user.type(screen.getByLabelText('Transfer amount'), '100')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a-joint')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a-rainy')

    // Not confirmed → blocked before the API.
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))
    expect(await screen.findByText('Confirm that you’ve completed this transfer before recording it.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // A receipt before the departure is a typo, blocked client-side.
    await user.click(screen.getByLabelText('Transfer completed confirmation'))
    await user.type(screen.getByLabelText('Transfer receipt date'), '2026-09-29')
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))
    expect(await screen.findByText('The receipt date can’t be before the departure date.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('Transfer receipt date'))
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/transactions/transfer', {
        departedOn: '2026-09-30', receivedOn: null, amount: 100, fromAccountId: 'a-joint', toAccountId: 'a-rainy', payee: null,
      }),
    )
  })

  // Rules 69/72 — transfer rows show their leg status and take the missing leg inline.
  it('confirms a missing bank leg from the register row', { timeout: 15000 }, async () => {
    const inTransit = tx({ id: 't-in', payee: 'Stash', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day', transferStatus: 'InTransit', departedOn: '2026-09-30', receivedOn: null })
    const pending = tx({ id: 't-pend', payee: 'From Joint', type: 2, amount: 40, accountName: 'Joint', transferAccountName: 'Rainy Day', transferStatus: 'PendingReview', departedOn: null, receivedOn: '2026-10-01' })
    mockLoad([inTransit, pending], accountsFixture())
    mockPut.mockResolvedValue({ data: { ...pending, transferStatus: 'Completed', departedOn: '2026-09-30' } })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('In transit', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Pending review')).toBeInTheDocument()
    expect(await txItems(user, 'Stash')).toContain('Confirm receipt: Stash')

    await txAction(user, 'From Joint', 'Add departure date: From Joint')
    await user.clear(screen.getByLabelText('Departure date'))
    await user.type(screen.getByLabelText('Departure date'), '2026-09-30')
    await user.click(screen.getByRole('button', { name: 'Save transfer leg' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-pend/transfer-legs', { departedOn: '2026-09-30' }))
    await waitFor(() => expect(screen.queryByText('Pending review')).not.toBeInTheDocument())
  })

  // TX-080 — a non-positive/blank transfer amount is blocked before the API.
  it('blocks a non-positive transfer amount client-side', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    const amount = screen.getByLabelText('Transfer amount')

    for (const bad of ['0', '-5']) {
      await user.clear(amount)
      await user.type(amount, bad)
      await user.click(screen.getByRole('button', { name: 'Record transfer' }))
      expect(
        await screen.findByText('Enter a valid transfer amount greater than zero.', {}, { timeout: 5000 }),
      ).toBeInTheDocument()
    }
    expect(mockPost).not.toHaveBeenCalled()
  })

  // TX-081 — a missing source or destination account is blocked client-side.
  it('blocks a transfer with a missing source or destination', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '100')
    // From left on "Choose…".
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a-rainy')
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    expect(
      await screen.findByText('Choose both a source and a destination account.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // TX-084 — a failed transfer maps to the fixed generic string.
  it('maps a failed transfer to the generic "Could not record that transfer."', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '100')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a-joint')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a-rainy')
    await user.click(screen.getByLabelText('Transfer completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    expect(await screen.findByText('Could not record that transfer.', {}, { timeout: 5000 })).toBeInTheDocument()
  })
})

describe('TransactionsPage catalog — no current-month budget', () => {
  // TX-090 — with no budget month, the assign picker offers only "Unassigned" and the split editor warns.
  it('offers only Unassigned and warns in the split editor when no month is loaded', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', amount: 40, budgetItemId: null })], [], [], null)
    const user = userEvent.setup()
    renderPage()

    // Register still renders (only a /transactions failure blocks it).
    await screen.findByText('Tesco', {}, { timeout: 5000 })

    // Assign picker → the only option is "Unassigned"; no budget optgroups.
    await user.click(screen.getByRole('button', { name: 'Assign Tesco' }))
    const select = await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })
    expect(within(select).getByRole('option', { name: 'Unassigned' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'Groceries' })).not.toBeInTheDocument()

    // Split editor → the "add lines first" warning; open it from the row's ⋯.
    await txAction(user, 'Tesco', 'Split transaction: Tesco')
    expect(await screen.findByText('Add some expense budget lines first.', {}, { timeout: 5000 })).toBeInTheDocument()
  })
})

describe('TransactionsPage catalog — add resets category (TX-094)', () => {
  // TX-094 — after a successful add the form clears payee, amount AND the category, so a later
  // "unassigned" add cannot silently inherit the previous line (and the auto-categorizer runs).
  it('resets the Category select to Unassigned after a successful add', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({
      data: tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
    })
    const user = userEvent.setup()
    renderPage()

    // Open the add modal, pick a category, fill payee + amount, and submit.
    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Assign transaction to'), 'i-groceries')
    expect((screen.getByLabelText('Assign transaction to') as HTMLSelectElement).value).toBe('i-groceries')
    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco')
    await user.type(screen.getByLabelText('Transaction amount'), '40')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    // The POST carried the chosen line, and the modal closed on success.
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ budgetItemId: 'i-groceries' }),
      ),
    )

    // Re-open the modal: the Category select is back to its Unassigned default, not the prior line.
    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect((screen.getByLabelText('Assign transaction to') as HTMLSelectElement).value).toBe('')
  })
})

describe('TransactionsPage catalog — cross-month "Budgeted to" note', () => {
  // A transaction can be budgeted to a line in a different month than its own date (e.g. a
  // 31 Jul purchase budgeted to a February line). The list says so in the row's ⋯ note
  // ("Budgeted to a <Mon YYYY> line…", restyle PR 5; it was a tag); a same-month assignment says nothing.
  it('tags a cross-month assignment but not a same-month one', { timeout: 15000 }, async () => {
    const feb = monthYear('2026-02-01') // locale-consistent with the component's own formatter
    mockLoad([
      // Dated in July, budgeted to a February line → the cross-month tag shows.
      tx({
        id: 't-cross', payee: 'Cross buy', date: '2026-07-31',
        budgetItemId: 'i-groceries', budgetItemName: 'Groceries',
        budgetItemYear: 2026, budgetItemMonth: 2,
      }),
      // Dated in July, budgeted to a July line → no tag (same month).
      tx({
        id: 't-same', payee: 'Same buy', date: '2026-07-10',
        budgetItemId: 'i-groceries', budgetItemName: 'Groceries',
        budgetItemYear: 2026, budgetItemMonth: 7,
      }),
    ])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Cross buy', {}, { timeout: 5000 })

    // The mismatch is said in the row's ⋯ note (a status that needs nothing done is no chip).
    expect(await txNote(user, 'Cross buy')).toContain(`Budgeted to a ${feb} line, not this transaction’s own month.`)
    expect(within(rowFor('Cross buy')).queryByText(/Budgeted to/)).not.toBeInTheDocument()
    expect((await txNote(user, 'Same buy')).join(' ')).not.toMatch(/Budgeted to/)
    expect(within(rowFor('Same buy')).queryByText(/Budgeted to/)).not.toBeInTheDocument()
  })

  // Null-safe: when the assigned line's month wasn't loaded (fields absent), no tag renders —
  // an unassigned row never carries it either.
  it('shows no tag when the line month is absent or the row is unassigned', { timeout: 15000 }, async () => {
    mockLoad([
      tx({
        id: 't-nomonth', payee: 'No month', date: '2026-07-31',
        budgetItemId: 'i-groceries', budgetItemName: 'Groceries',
      }),
      tx({ id: 't-unassigned', payee: 'Unassigned buy', date: '2026-07-31', budgetItemId: null }),
    ])
    renderPage()

    const user = userEvent.setup()
    await screen.findByText('No month', {}, { timeout: 5000 })

    expect(within(rowFor('No month')).queryByText(/Budgeted to/)).not.toBeInTheDocument()
    expect(within(rowFor('Unassigned buy')).queryByText(/Budgeted to/)).not.toBeInTheDocument()
    expect((await txNote(user, 'No month')).join(' ')).not.toMatch(/Budgeted to/)
    expect((await txNote(user, 'Unassigned buy')).join(' ')).not.toMatch(/Budgeted to/)
  })
})

describe('TransactionsPage catalog — refunds (rules 38/39, W12)', () => {
  const purchase = () =>
    tx({ id: 't-tesco', date: '2026-07-10', payee: 'Tesco', amount: 40, type: 0, budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })
  const refundRow = () =>
    tx({
      id: 't-refund', date: '2026-07-12', payee: 'Tesco refund', amount: 10, type: 1,
      budgetItemId: 'i-groceries', budgetItemName: 'Groceries',
      refundOfTransactionId: 't-tesco', refundOfPayee: 'Tesco', refundOfDate: '2026-07-10', refundOfAmount: 40,
    })

  // #286 P3-1: a split purchase has no one line for the refund to follow, so the refund's line
  // is the user's to pick; the default option says so and the save waits for it.
  it('needs a category for a refund of a split purchase', { timeout: 15000 }, async () => {
    const splitPurchase = tx({
      id: 't-ikea', date: '2026-07-08', payee: 'Ikea', amount: 90, type: 0, isSplit: true,
      splits: [
        { id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', amount: 50, memberId: null, memberName: null },
        { id: 's2', budgetItemId: 'i-rest', budgetItemName: 'Restaurants', amount: 40, memberId: null, memberName: null },
      ],
    })
    mockLoad([purchase(), splitPurchase])
    mockPost.mockResolvedValue({ data: refundRow() })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.selectOptions(screen.getByLabelText('Transaction type'), '-1')
    await user.type(screen.getByLabelText('Transaction payee'), 'Ikea refund')
    await user.type(screen.getByLabelText('Transaction amount'), '10')
    await user.selectOptions(screen.getByLabelText('Refund of'), 't-ikea')
    const category = screen.getByLabelText('Assign transaction to') as HTMLSelectElement
    expect(within(category).getAllByRole('option')[0].textContent).toBe('Choose a category (the purchase is split)')

    const submit = within(screen.getByRole('dialog')).getByRole('button', { name: 'Add transaction' })
    await user.click(submit)
    expect(await screen.findByText('That purchase is split across several lines: choose the category the refund goes to.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.selectOptions(category, 'i-groceries')
    await user.click(submit)
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ type: 1, refundOfTransactionId: 't-ikea', budgetItemId: 'i-groceries' }),
      ),
    )
  })

  // TX-099 — the Add modal's third type: a refund names the purchase it comes back from, offers
  // only expense/savings lines (defaulting to the purchase's category) and posts as Income with
  // the link; it never posts without a purchase.
  it('adds a refund linked to a purchase, on expense lines only (TX-099)', { timeout: 15000 }, async () => {
    const splitPurchase = tx({
      id: 't-ikea', date: '2026-07-08', payee: 'Ikea', amount: 90, type: 0, isSplit: true,
      splits: [
        { id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', amount: 50, memberId: null, memberName: null },
        { id: 's2', budgetItemId: 'i-rest', budgetItemName: 'Restaurants', amount: 40, memberId: null, memberName: null },
      ],
    })
    const register = [purchase(), splitPurchase, tx({ id: 't-inc', payee: 'Payday', amount: 2500, type: 1 })]
    mockLoad(register)
    mockPost.mockImplementation(() => {
      register.unshift(refundRow())
      return Promise.resolve({ data: refundRow() })
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.selectOptions(screen.getByLabelText('Transaction type'), '-1')

    // The purchase picker lists expenses only (never the income row), newest first.
    const picker = screen.getByLabelText('Refund of') as HTMLSelectElement
    const labels = within(picker).getAllByRole('option').map((o) => o.textContent)
    expect(labels[0]).toBe('Choose the purchase')
    expect(labels.some((l) => l?.includes('Tesco') && l.includes('€40.00'))).toBe(true)
    expect(labels.some((l) => l?.includes('Payday'))).toBe(false)
    // A split purchase can be refunded too, as on the server.
    expect(labels.some((l) => l?.includes('Ikea') && l.includes('€90.00'))).toBe(true)
    // Category: expense and savings lines with the purchase's category as the default; no income line.
    const category = screen.getByLabelText('Assign transaction to') as HTMLSelectElement
    const lines = within(category).getAllByRole('option').map((o) => o.textContent)
    expect(lines[0]).toBe('Same category as the purchase')
    expect(lines).toContain('Groceries')
    expect(lines).toContain('Emergency fund')
    expect(lines).not.toContain('Salary')
    expect(screen.queryByRole('button', { name: 'Split across categories' })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco refund')
    await user.type(screen.getByLabelText('Transaction amount'), '10')
    const submit = within(screen.getByRole('dialog')).getByRole('button', { name: 'Add transaction' })
    // No purchase chosen → refused client-side, nothing posted.
    await user.click(submit)
    expect(await screen.findByText('Choose the purchase this refund is for.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.selectOptions(picker, 't-tesco')
    await user.click(submit)
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ type: 1, refundOfTransactionId: 't-tesco', budgetItemId: null, payee: 'Tesco refund', amount: 10 }),
      ),
    )
    expect(await screen.findByText('Tesco refund', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // TX-100 — a refund row is labelled with the purchase it came back from and is money received
  // on the register, but never Money in; Money out is net of it. The purchase says it was refunded.
  it('labels refund rows and nets them out of the hero totals (TX-100)', { timeout: 15000 }, async () => {
    mockLoad([
      { ...purchase(), date: thisMonth(10), refundCount: 1, refundedAmount: 10 },
      { ...refundRow(), date: thisMonth(12) },
      tx({ id: 't-inc', date: thisMonth(), payee: 'Payday', amount: 2500, type: 1 }),
    ])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Tesco refund', {}, { timeout: 5000 })
    // What it is a refund of: the row's ⋯ note (no chip in the row; its icon is the refund glyph).
    expect(within(rowFor('Tesco refund')).queryByText('Refund')).not.toBeInTheDocument()
    expect(await txNote(user, 'Tesco refund')).toContain(`Refund of Tesco · ${shortDate('2026-07-10')}`)
    expect(amountOf('Tesco refund')).toHaveTextContent('+€10.00')
    // The purchase carries the refunded amount (in its ⋯ note).
    expect(await txNote(user, 'Tesco')).toContain('€10.00 refunded')
    // Income = 2,500 (the refund is not income); Spent = 40 − 10 = 30.
    expect(screen.getByLabelText(/^Income for .*: €2,500\.00$/)).toBeInTheDocument()
    expect(screen.getByText('€30.00')).toBeInTheDocument()
  })

  // TX-101 — money received can be marked as a refund of a purchase (PUT …/refund with the
  // purchase) and a refund unmarked (PUT …/refund with null).
  it('marks income as a refund and unmarks a refund (TX-101)', { timeout: 15000 }, async () => {
    const register = [purchase(), refundRow(), tx({ id: 't-inc', payee: 'Payday', amount: 2500, type: 1 })]
    mockLoad(register)
    // The server's register after each change: the purchase counts the refunds linked to it.
    mockPut.mockImplementation((_url: string, body: { refundOfTransactionId: string | null }) => {
      const data = body.refundOfTransactionId
        ? { ...tx({ id: 't-inc', payee: 'Payday', amount: 2500, type: 1 }), refundOfTransactionId: 't-tesco', refundOfPayee: 'Tesco', refundOfDate: '2026-07-10' }
        : { ...refundRow(), refundOfTransactionId: null, refundOfPayee: null, refundOfDate: null, budgetItemId: null, budgetItemName: null }
      register.splice(register.findIndex((t) => t.id === data.id), 1, data)
      const refunds = register.filter((t) => t.refundOfTransactionId === 't-tesco')
      register[0] = { ...purchase(), refundCount: refunds.length, refundedAmount: refunds.reduce((sum, t) => sum + t.amount, 0) }
      return Promise.resolve({ data })
    })
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Payday', {}, { timeout: 5000 })
    // A purchase offers no refund action; an income row does.
    const tescoItems = await txItems(user, 'Tesco')
    expect(tescoItems).toContain('Edit transaction: Tesco')
    expect(tescoItems).not.toContain('Mark as refund: Tesco')
    await txAction(user, 'Payday', 'Mark as refund: Payday')
    const save = await screen.findByRole('button', { name: 'Save refund link' })
    expect(save).toBeDisabled() // nothing picked yet
    await user.selectOptions(screen.getByLabelText('Purchase refunded by Payday'), 't-tesco')
    await user.click(save)
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-inc/refund', { refundOfTransactionId: 't-tesco' }))
    // Payday is now a refund: its ⋯ note says of what, and its ⋯ offers to unmark it.
    await waitFor(async () => expect(await txNote(user, 'Payday')).toContain(`Refund of Tesco · ${shortDate('2026-07-10')}`), { timeout: 5000 })
    expect(await txItems(user, 'Payday')).toContain('Not a refund: Payday')
    // The purchase's row shows the refunded total the server counts (both linked refunds), in its ⋯ note.
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/transactions')).toHaveLength(2))
    await waitFor(async () => expect(await txNote(user, 'Tesco')).toContain('€2,510.00 refunded (2 refunds)'), { timeout: 5000 })

    await txAction(user, 'Tesco refund', 'Not a refund: Tesco refund')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-refund/refund', { refundOfTransactionId: null }))
    await waitFor(async () => expect((await txNote(user, 'Tesco refund')).join(' ')).not.toMatch(/Refund of/), { timeout: 5000 })
    expect(await txItems(user, 'Tesco refund')).toContain('Mark as refund: Tesco refund')
  })

  // TX-102 — a refund keeps its direction (the edit's type select is locked) and is never split;
  // its inline picker offers expense/savings lines only.
  it('locks a refund’s type, hides split and offers expense lines to assign (TX-102)', { timeout: 15000 }, async () => {
    mockLoad([{ ...purchase(), refundCount: 1, refundedAmount: 10 }, refundRow()])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Tesco refund', {}, { timeout: 5000 })
    const refundItems = await txItems(user, 'Tesco refund')
    expect(refundItems).toContain('Edit transaction: Tesco refund')
    expect(refundItems).not.toContain('Split transaction: Tesco refund')
    expect(await txItems(user, 'Tesco')).toContain('Split transaction: Tesco')

    await user.click(screen.getByRole('button', { name: /^Reassign Tesco refund:/ }))
    const picker = screen.getByLabelText('Assign Tesco refund') as HTMLSelectElement
    const lines = within(picker).getAllByRole('option').map((o) => o.textContent)
    expect(lines).toContain('Groceries')
    expect(lines).not.toContain('Salary')

    await txAction(user, 'Tesco refund', 'Edit transaction: Tesco refund')
    expect(screen.getByLabelText('Edit type')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    // The refunded purchase's type is locked too, until its refunds are unmarked.
    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    expect(screen.getByLabelText('Edit type')).toBeDisabled()
  })
})

describe('TransactionsPage catalog — transfer edit, fees and returns (W07)', () => {
  function transfer(over: Partial<TransactionDto> = {}): TransactionDto {
    return tx({
      id: 't-tr', payee: 'Move', type: 2, amount: 100, date: '2026-07-10',
      accountId: 'a-joint', accountName: 'Joint', transferAccountId: 'a-rainy', transferAccountName: 'Rainy Day',
      transferStatus: 'InTransit', departedOn: '2026-07-10', receivedOn: null, returnedOn: null, fee: null,
      feeBudgetItemId: null, feeBudgetItemName: null,
      departureConfirmedByStatement: false, receiptConfirmedByStatement: false, returnConfirmedByStatement: false,
      ...over,
    })
  }

  it('edits a transfer in place, sending every field to PUT /transfer', { timeout: 20000 }, async () => {
    const t = transfer()
    mockLoad([t], accountsFixture())
    mockPut.mockResolvedValue({ data: transfer({ receivedOn: '2026-07-12', transferStatus: 'Completed', payee: 'Top up', fee: 1.5 }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    // Pre-filled from the stored transfer; no "completed" confirmation for a recorded one.
    expect(within(dialog).getByLabelText('Transfer date')).toHaveValue('2026-07-10')
    expect(within(dialog).getByLabelText('Transfer amount')).toHaveValue('100')
    expect(within(dialog).getByLabelText('Transfer from account')).toHaveValue('a-joint')
    expect(within(dialog).getByLabelText('Transfer to account')).toHaveValue('a-rainy')
    expect(within(dialog).getByLabelText('Transfer note')).toHaveValue('Move')
    expect(within(dialog).queryByLabelText('Transfer completed confirmation')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Transfer receipt date'), '2026-07-12')
    await user.clear(within(dialog).getByLabelText('Transfer note'))
    await user.type(within(dialog).getByLabelText('Transfer note'), 'Top up')
    // The fee line picker appears once a fee is typed, offering the departure month's lines.
    expect(within(dialog).queryByLabelText('Transfer fee category')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Transfer fee'), '1.5')
    await user.selectOptions(within(dialog).getByLabelText('Transfer fee category'), 'i-groceries')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t-tr/transfer', {
        fromAccountId: 'a-joint', toAccountId: 'a-rainy', amount: 100,
        departedOn: '2026-07-10', receivedOn: '2026-07-12', returnedOn: null,
        payee: 'Top up', fee: 1.5, feeBudgetItemId: 'i-groceries', acknowledgeCrossMonth: false,
        fromJarId: null, jarAllocations: null,
        version: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The fee is its own row: the register is re-read after the save.
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/transactions')).toHaveLength(2))
  })

  // D10 (#306 review P2-1): a transfer edit that leaves the receipt's jars unbacked is saved and says so.
  it('shows the warning a transfer edit answers with (D10)', { timeout: 20000 }, async () => {
    mockLoad([transfer()], accountsFixture())
    const warning = 'Saved. From 2026-07-10 Rainy day’s jars hold 500 while the account holds 200.'
    mockPut.mockResolvedValue({ data: { ...transfer({ amount: 50 }), warning } })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.clear(within(dialog).getByLabelText('Transfer amount'))
    await user.type(within(dialog).getByLabelText('Transfer amount'), '50')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-tr/transfer', expect.objectContaining({ amount: 50 })))
    expect(await screen.findByRole('status', {}, { timeout: 5000 })).toHaveTextContent(warning)
  })

  it('fetches the departure month for the fee line when it is not the loaded month', { timeout: 20000 }, async () => {
    mockLoad([transfer({ departedOn: '2026-06-28', date: '2026-06-28' })], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    await user.type(await screen.findByLabelText('Transfer fee', {}, { timeout: 5000 }), '2')
    await screen.findByLabelText('Transfer fee category', {}, { timeout: 5000 })
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/budget/2026/6'))
  })

  it('marks an in-transit transfer as returned; the receipt date is then off', { timeout: 20000 }, async () => {
    mockLoad([transfer()], accountsFixture())
    mockPut.mockResolvedValue({ data: transfer({ transferStatus: 'Returned', returnedOn: '2026-07-15' }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.type(within(dialog).getByLabelText('Transfer returned date'), '2026-07-15')
    expect(within(dialog).getByLabelText('Transfer receipt date')).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-tr/transfer',
        expect.objectContaining({ departedOn: '2026-07-10', receivedOn: null, returnedOn: '2026-07-15' }),
      ),
    )
    // The list row now reads Returned (its ⋯ note says when), and its ⋯ offers no receipt to confirm.
    expect(await screen.findByText('Returned', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('In transit')).not.toBeInTheDocument()
    expect(await txNote(user, 'Move')).toContain(`Sent back to Joint on ${formatDate('2026-07-15')}.`)
    expect(await txItems(user, 'Move')).toEqual(['Edit transfer: Move', 'Delete transaction: Move'])
  })

  it('offers "Returned on" only while the transfer has departed and has no receipt', { timeout: 15000 }, async () => {
    mockLoad([transfer({ receivedOn: '2026-07-11', transferStatus: 'Completed' })], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    expect(within(dialog).queryByLabelText('Transfer returned date')).not.toBeInTheDocument()
    // Clearing the receipt makes it a departed, unreceived transfer again.
    await user.clear(within(dialog).getByLabelText('Transfer receipt date'))
    expect(within(dialog).getByLabelText('Transfer returned date')).toBeInTheDocument()
  })

  it('disables the fields a bank statement confirmed', { timeout: 15000 }, async () => {
    mockLoad(
      [
        transfer({ receivedOn: '2026-07-11', transferStatus: 'Completed', departureConfirmedByStatement: true, receiptConfirmedByStatement: true }),
        transfer({ id: 't-ret', payee: 'Bounced', transferStatus: 'Returned', returnedOn: '2026-07-15', returnConfirmedByStatement: true }),
      ],
      accountsFixture(),
    )
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    let dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    for (const label of ['Transfer date', 'Transfer amount', 'Transfer from account', 'Transfer fee', 'Transfer to account', 'Transfer receipt date']) {
      expect(within(dialog).getByLabelText(label)).toBeDisabled()
    }
    expect(within(dialog).getByLabelText('Transfer note')).toBeEnabled()
    expect(within(dialog).getAllByText('Confirmed by the bank statement').length).toBeGreaterThan(0)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    // A return the source statement confirmed keeps its date; the departure is still editable.
    await txAction(user, 'Bounced', 'Edit transfer: Bounced')
    dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    expect(within(dialog).getByLabelText('Transfer returned date')).toHaveValue('2026-07-15')
    expect(within(dialog).getByLabelText('Transfer returned date')).toBeDisabled()
    expect(within(dialog).getByLabelText('Transfer date')).toBeEnabled()
    expect(within(dialog).getByLabelText('Transfer to account')).toBeEnabled()
  })

  it('badges a returned transfer and offers no receipt to confirm', { timeout: 15000 }, async () => {
    mockLoad([transfer({ transferStatus: 'Returned', returnedOn: '2026-07-15' })], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    // The word sits in the chip's truncating span; the chip holds the title.
    const badge = (await screen.findByText('Returned', {}, { timeout: 5000 })).closest('[title]')
    expect(badge).toHaveAttribute('title', `Sent back to Joint on ${formatDate('2026-07-15')}`)
    const items = await txItems(user, 'Move')
    expect(items).toContain('Edit transfer: Move')
    expect(items.some((name) => /Confirm receipt/.test(name))).toBe(false)
    expect(await txNote(user, 'Move')).toContain(`Sent back to Joint on ${formatDate('2026-07-15')}.`)
    expect(screen.queryByText('In transit')).not.toBeInTheDocument()
  })

  it('shows a transfer fee on its row, and its fee row only takes a line', { timeout: 15000 }, async () => {
    mockLoad(
      [
        transfer({ transferStatus: 'Completed', receivedOn: '2026-07-10', fee: 2, feeBudgetItemId: 'i-groceries', feeBudgetItemName: 'Groceries' }),
        tx({ id: 't-fee', payee: 'Transfer fee', amount: 2, accountId: 'a-joint', accountName: 'Joint', feeForTransferId: 't-tr' }),
      ],
      accountsFixture(),
    )
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Transfer fee', {}, { timeout: 5000 })
    expect(amountOf('Move')).toHaveTextContent(/\+ fee 2\.00/)
    expect(await txNote(user, 'Move')).toContain('Fee on Groceries.')
    // The fee row has no ⋯ (so no Edit, Split or Delete); an (i) says what it is and why.
    expect(await rowHint(user, 'Transfer fee')).toContain('A transfer’s fee: edit the transfer to change it.')
    expect(screen.getByRole('button', { name: 'Move: more actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transfer fee: more actions' })).not.toBeInTheDocument()
    expect(within(rowFor('Transfer fee')).getByRole('button', { name: 'About Transfer fee' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Edit transaction: Transfer fee')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Split transaction: Transfer fee')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Delete transaction: Transfer fee')).not.toBeInTheDocument()
    // It can still be put on a line.
    expect(screen.getByRole('button', { name: 'Assign Transfer fee' })).toBeInTheDocument()
  })

  it('records a new transfer with a fee, confirming a cross-month fee line', { timeout: 20000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 400, data: { errors: { crossMonth: ['The fee is dated 2026-06 but that budget line is in 2026-07.'] } } },
      })
      .mockResolvedValueOnce({ data: transfer({ fee: 2 }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.clear(screen.getByLabelText('Transfer date'))
    await user.type(screen.getByLabelText('Transfer date'), '2026-07-10')
    await user.type(screen.getByLabelText('Transfer amount'), '100')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a-joint')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a-rainy')
    await user.type(screen.getByLabelText('Transfer fee'), '2')
    await user.selectOptions(screen.getByLabelText('Transfer fee category'), 'i-internet')
    await user.click(screen.getByLabelText('Transfer completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    const expected = {
      departedOn: '2026-07-10', receivedOn: null, amount: 100, fromAccountId: 'a-joint', toAccountId: 'a-rainy', payee: null,
      fee: 2, feeBudgetItemId: 'i-internet',
    }
    const confirm = await screen.findByRole('button', { name: 'Budget it anyway' }, { timeout: 5000 })
    expect(mockPost).toHaveBeenCalledWith('/transactions/transfer', expected)
    await user.click(confirm)
    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith('/transactions/transfer', { ...expected, acknowledgeCrossMonth: true }),
    )
  })

  it('moves money between amount and fee on a departure the bank confirmed (P3-7)', { timeout: 20000 }, async () => {
    // The source statement shows 102 leaving Joint: 100 on its way and a 2 fee.
    mockLoad([transfer({ fee: 2, feeBudgetItemId: 'i-internet', departureConfirmedByStatement: true })], accountsFixture())
    mockPut.mockResolvedValue({ data: transfer({ amount: 99, fee: 3, departureConfirmedByStatement: true }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    const amount = within(dialog).getByLabelText('Transfer amount')
    expect(amount).toBeEnabled()
    expect(within(dialog).getByLabelText('Transfer fee')).toBeDisabled()
    expect(within(dialog).getByText(/The bank took 102\.00 in all/)).toBeInTheDocument()

    // More than the bank's total is refused before anything is sent.
    await user.clear(amount)
    await user.type(amount, '103')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    expect(await within(dialog).findByText(/shows 102\.00 leaving the source account/)).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()

    // The fee follows as the rest of the bank's total.
    await user.clear(amount)
    await user.type(amount, '99')
    expect(within(dialog).getByLabelText('Transfer fee')).toHaveValue('3')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-tr/transfer',
        expect.objectContaining({ amount: 99, fee: 3, feeBudgetItemId: 'i-internet' }),
      ),
    )
  })

  it('re-saves a fee left on its line without asking the cross-month question again (P3-8)', { timeout: 20000 }, async () => {
    mockLoad([transfer({ fee: 2, feeBudgetItemId: 'i-internet', feeBudgetItemName: 'Internet' })], accountsFixture())
    mockPut.mockResolvedValue({ data: transfer({ fee: 2, feeBudgetItemId: 'i-internet', payee: 'Top up' }) })
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.clear(within(dialog).getByLabelText('Transfer note'))
    await user.type(within(dialog).getByLabelText('Transfer note'), 'Top up')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-tr/transfer',
        expect.objectContaining({ fee: 2, feeBudgetItemId: 'i-internet', acknowledgeCrossMonth: true }),
      ),
    )
  })

  // P3-10, relaxed with #283: the server accepts an archived jar's stored share sent back
  // unchanged on a leg that keeps its date, so only a changed answer is stopped on the screen.
  function loadWithArchivedHoliday(t: TransactionDto) {
    mockLoad([t], accountsFixture())
    const load = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string) =>
      url === '/jars/ledger'
        ? Promise.resolve({
            data: [
              {
                accountId: 'a-joint', accountName: 'Joint', currency: 'EUR', asOf: '2026-07-20', accountBalance: 1250,
                unallocated: 1250, positiveAllocations: 0, hasBackingDeficit: false, unreconciledAllocations: 0,
                requiresReview: false, jars: [{ jarId: 'jar-hol', name: 'Holiday', balance: 0, isArchived: true }],
              },
            ],
          })
        : load(url),
    )
  }

  it('sends an edit that leaves an archived jar’s stored share unchanged (P3-10 relaxed after #283)', { timeout: 20000 }, async () => {
    const t = transfer({ jarAllocations: [{ accountId: 'a-joint', jarId: 'jar-hol', jarName: 'Holiday', amount: -100 }] })
    loadWithArchivedHoliday(t)
    mockPut.mockResolvedValue({ data: { ...t, payee: 'Top up' } })
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/ledger'))
    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.clear(within(dialog).getByLabelText('Transfer note'))
    await user.type(within(dialog).getByLabelText('Transfer note'), 'Top up')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t-tr/transfer', expect.objectContaining({ payee: 'Top up', fromJarId: 'jar-hol' })),
    )
    expect(within(dialog).queryByText(/which is archived/)).not.toBeInTheDocument()
  })

  it('explains, without sending, an edit that changes the share drawn from an archived jar (P3-10)', { timeout: 20000 }, async () => {
    const t = transfer({ jarAllocations: [{ accountId: 'a-joint', jarId: 'jar-hol', jarName: 'Holiday', amount: -100 }] })
    loadWithArchivedHoliday(t)
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/ledger'))
    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    // A larger amount would draw 120 from Holiday, where 100 is stored: a new answer.
    await user.clear(within(dialog).getByLabelText('Transfer amount'))
    await user.type(within(dialog).getByLabelText('Transfer amount'), '120')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    expect(
      await within(dialog).findByText(
        'This entry moved money in or out of Holiday, which is archived. Restore Holiday on the Jars page to change this entry.',
      ),
    ).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // #286 P3-2: moving off the archived jar must not drop it from the list; the stored answer can
  // be picked back and is sent unchanged.
  it('keeps an archived jar’s stored option offered after moving off it', { timeout: 20000 }, async () => {
    const t = transfer({ jarAllocations: [{ accountId: 'a-joint', jarId: 'jar-hol', jarName: 'Holiday', amount: -100 }] })
    mockLoad([t], accountsFixture())
    const load = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string) =>
      url === '/jars/ledger'
        ? Promise.resolve({
            data: [
              {
                accountId: 'a-joint', accountName: 'Joint', currency: 'EUR', asOf: '2026-07-20', accountBalance: 1250,
                unallocated: 1050, positiveAllocations: 200, hasBackingDeficit: false, unreconciledAllocations: 0,
                requiresReview: false,
                jars: [
                  { jarId: 'jar-hol', name: 'Holiday', balance: 0, isArchived: true },
                  { jarId: 'jar-car', name: 'Car', balance: 200, isArchived: false },
                ],
              },
            ],
          })
        : load(url),
    )
    mockPut.mockResolvedValue({ data: t })
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/ledger'))
    await txAction(user, 'Move', 'Edit transfer: Move')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    const fromJar = within(dialog).getByLabelText('From jar') as HTMLSelectElement
    expect(fromJar).toHaveValue('jar-hol')
    await user.selectOptions(fromJar, 'jar-car')
    expect(within(fromJar).getByRole('option', { name: 'Holiday (archived)' })).toBeInTheDocument()
    await user.selectOptions(fromJar, 'jar-hol')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-tr/transfer', expect.objectContaining({ fromJarId: 'jar-hol' })))
  })

  it('needs a budget line for a fee (rule 91)', { timeout: 15000 }, async () => {
    mockLoad([transfer()], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    await user.type(await screen.findByLabelText('Transfer fee', {}, { timeout: 5000 }), '2')
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    expect(await screen.findByText('Choose the budget line the fee is spent from.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('blocks a fee that is not a positive amount', { timeout: 15000 }, async () => {
    mockLoad([transfer()], accountsFixture())
    const user = userEvent.setup()
    renderPage()

    await txAction(user, 'Move', 'Edit transfer: Move')
    await user.type(await screen.findByLabelText('Transfer fee', {}, { timeout: 5000 }), '0')
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    expect(await screen.findByText('Enter a valid fee greater than zero, or leave it blank.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })
})
