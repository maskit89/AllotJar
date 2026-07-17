// Catalog-driven tests for the Transactions area (docs/testing/cases/10-transactions.md, prefix TX).
// These convert P0 + cheap P1/P2 manual cases whose "Automated" field was No/Partial and whose
// behaviour is observable in a jsdom render: hero totals, register row rendering (signs, account &
// category cells, Bill tag), the add modal (field gating, client validation messages), the inline
// assign picker, the split editor (seed/add/remove/remainder/guards/unsplit), inline edit, delete,
// filters, the transfer form, and generic-error mapping. New FILE only — the existing
// TransactionsPage.test.tsx is left untouched; conventions (vi.hoisted api mock spreading
// importOriginal, MemoryRouter + AuthProvider, explicit async timeouts) mirror it exactly.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, BudgetMonthDto, HouseholdMemberDto, TransactionDto } from '../types'

const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls (PR #169 harness invariant).
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { TransactionsPage } from './TransactionsPage'
import { AuthProvider } from '../auth/AuthContext'

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
    exchangeRate: 1, baseAmount: 40, type: 0, bankReference: null,
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
    { id: 'mem-chris', name: 'Chris', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.5 },
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
    if (url === '/transactions') return Promise.resolve({ data: transactions })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/members') return Promise.resolve({ data: members })
    if (url === '/budget/current') return Promise.resolve({ data: budgetData })
    // /auth/me and anything else — a role-less body is ignored by AuthContext.
    return Promise.resolve({ data: budgetData })
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <TransactionsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** The <tr> that renders a given payee (the register's main, non-editing row). */
function rowFor(payee: string): HTMLElement {
  const cell = screen.getByText(payee)
  const tr = cell.closest('tr')
  if (!tr) throw new Error(`No row for payee "${payee}"`)
  return tr
}

/** The six <td>s of a normal (non-editing) register row: date, payee, category, account, amount, actions. */
function cellsFor(payee: string): HTMLTableCellElement[] {
  return Array.from(rowFor(payee).querySelectorAll('td'))
}

beforeEach(() => {
  mockGet.mockReset()
  mockPut.mockReset()
  mockPost.mockReset()
  mockDelete.mockReset()
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
    expect(screen.getByText('2 transactions')).toBeInTheDocument()
  })

  // TX-002 — empty register shows the first-use empty state; the hero still renders zero totals.
  it('shows the empty state and a zeroed hero when there are no transactions', { timeout: 15000 }, async () => {
    mockLoad([])
    renderPage()

    expect(await screen.findByText('No transactions yet', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(
      screen.getByText('Use + Add transaction to record one, or Import a bank statement.'),
    ).toBeInTheDocument()
    expect(screen.getByText('+€0.00')).toBeInTheDocument() // Money in
    expect(screen.getByText('All assigned')).toBeInTheDocument() // Unassigned tile, none to assign
    // The toolbar Add button is still present for an Owner.
    expect(screen.getByRole('button', { name: 'Add transaction' })).toBeInTheDocument()
  })

  // TX-003 — hero Money in / Money out sum all income / expense and EXCLUDE transfers.
  it('sums hero totals across income and expense, excluding transfers', { timeout: 15000 }, async () => {
    mockLoad(
      [
        tx({ id: 't-inc', payee: 'Payday', amount: 2500, type: 1 }),
        tx({ id: 't-e1', payee: 'Tesco', amount: 40, type: 0 }),
        tx({ id: 't-e2', payee: 'Cafe', amount: 6.3, type: 0 }),
        tx({ id: 't-xfer', payee: 'Move', amount: 100, type: 2, accountName: 'Joint', transferAccountName: 'Rainy Day' }),
      ],
      accountsFixture(),
    )
    renderPage()

    // +€2,500.00 income (hero + the income row); €46.30 expense (40 + 6.30) — the Money-out
    // tile value, unique to the hero; the 100 transfer counts in neither total.
    expect((await screen.findAllByText('+€2,500.00', {}, { timeout: 5000 })).length).toBeGreaterThanOrEqual(1)
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

    const income = cellsFor('Payday')[4]
    expect(income.textContent).toBe('+€2,500.00')
    expect(income.className).toContain('text-brand-700')

    const expense = cellsFor('Tesco')[4]
    expect(expense.textContent).toContain('€40.00')
    expect(expense.textContent!.startsWith('+')).toBe(false) // signed with the minus glyph, not '+'
    expect(expense.textContent!.length).toBeGreaterThan('€40.00'.length)
    expect(expense.className).toContain('text-slate-900')

    const transfer = cellsFor('Move')[4]
    expect(transfer.textContent).toBe('€100.00') // unsigned
    expect(transfer.className).toContain('text-slate-500')
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

    expect(cellsFor('On Joint')[3].textContent).toBe('Joint')
    expect(cellsFor('No account')[3].textContent).toBe('—')
    expect(cellsFor('Move')[3].textContent).toBe('Joint → Rainy Day')
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
    const reassign = screen.getByRole('button', { name: 'Reassign Assigned' })
    expect(reassign).toHaveTextContent('Groceries')
    // Split → violet Split badge + slice summary.
    expect(within(rowFor('Split one')).getByText('Split')).toBeInTheDocument()
    expect(within(rowFor('Split one')).getByText(/Groceries.*Internet/)).toBeInTheDocument()
    // Transfer → Transfer badge, no assign control.
    expect(within(rowFor('Move')).getByText('Transfer')).toBeInTheDocument()
    // Unassigned → dashed +Assign button.
    expect(screen.getByRole('button', { name: 'Assign Plain' })).toHaveTextContent('+ Assign')
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
    expect(screen.getByText(/Money in/)).toBeInTheDocument()
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
  it('offers income and savings lines in the add-form Category select', { timeout: 15000 }, async () => {
    mockLoad([])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign transaction to', {}, { timeout: 5000 })
    // An expense form still exposes income + savings lines (only the split editor filters by type).
    expect(within(select).getByRole('option', { name: 'Salary' })).toBeInTheDocument()
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
    expect(await screen.findByRole('button', { name: 'Reassign Tesco' }, { timeout: 5000 })).toBeInTheDocument()
  })

  // TX-031 — reassign an already-assigned transaction to a different line.
  it('reassigns an already-assigned transaction', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: 'i-internet', budgetItemName: 'Internet' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Reassign Tesco' }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }), 'i-internet')

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-internet' }),
    )
    // Relabels to the new line and now carries the Bill tag (Internet has a due day).
    expect(await screen.findByRole('button', { name: 'Reassign Tesco' }, { timeout: 5000 })).toHaveTextContent('Internet')
    expect(within(rowFor('Tesco')).getByText('Bill')).toBeInTheDocument()
  })

  // TX-032 — clearing the assignment (choosing "Unassigned") reverts to the +Assign pill.
  it('clears an assignment back to the +Assign pill', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco', budgetItemId: null, budgetItemName: null }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Reassign Tesco' }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 })
    await user.selectOptions(select, within(select).getByRole('option', { name: 'Unassigned' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: null }),
    )
    expect(await screen.findByRole('button', { name: 'Assign Tesco' }, { timeout: 5000 })).toHaveTextContent('+ Assign')
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
  it('offers all line kinds in the assign picker for an income transaction', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Refund', type: 1, budgetItemId: null })])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Assign Refund' }, { timeout: 5000 }))
    const select = await screen.findByLabelText('Assign Refund', {}, { timeout: 5000 })
    expect(within(select).getByRole('option', { name: 'Salary' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Groceries' })).toBeInTheDocument() // expense line offered to income
    expect(within(select).getByRole('option', { name: 'Emergency fund' })).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Assign Tesco' })).toHaveTextContent('+ Assign')
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
    // At the 2-row minimum, no remove buttons.
    expect(screen.queryByLabelText('Remove split line 1')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Add split line'))
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Split transaction: Costco', {}, { timeout: 5000 }))
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
    await user.click(await screen.findByLabelText('Split transaction: Tesco', {}, { timeout: 5000 }))
    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()

    // Opening edit on Aldi closes the split.
    await user.click(screen.getByLabelText('Edit transaction: Aldi'))
    await waitFor(() => expect(screen.queryByLabelText('Split line 1 category')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Edit payee')).toBeInTheDocument()

    // Opening split again on Tesco closes the edit.
    await user.click(screen.getByLabelText('Split transaction: Tesco'))
    await waitFor(() => expect(screen.queryByLabelText('Edit payee')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()
  })

  // TX-058 — a transfer row exposes only delete; no edit or split affordance.
  it('offers no edit or split affordance on a transfer row', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Move', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' })], accountsFixture())
    renderPage()
    await screen.findByText('Move', {}, { timeout: 5000 })

    expect(screen.queryByLabelText('Edit transaction: Move')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Split transaction: Move')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Delete transaction: Move')).toBeInTheDocument()
  })

  // TX-059 — three slices that sum exactly at scale 4 (3.33 + 3.33 + 3.34 = 10.00) save cleanly.
  it('saves a three-way split that sums exactly in integer minor units', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Dinner', amount: 10 })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Dinner', amount: 10, isSplit: true, splits: [] }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Split transaction: Dinner', {}, { timeout: 5000 }))
    await user.click(screen.getByLabelText('Add split line'))
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

    await user.click(await screen.findByLabelText('Edit transaction: Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Edit type'), '1') // Income
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ type: 1 })),
    )
    await waitFor(() => expect(cellsFor('Tesco')[4].textContent!.startsWith('+')).toBe(true), { timeout: 5000 })
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

    await user.click(await screen.findByLabelText('Edit transaction: Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Edit account'), '') // No account
    await user.selectOptions(screen.getByLabelText('Edit member'), '') // No member
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ accountId: null, memberId: null })),
    )
    await waitFor(() => expect(cellsFor('Tesco')[3].textContent).toBe('—'), { timeout: 5000 })
  })

  // TX-071 — a transfer row can be deleted (its single row carries both legs).
  it('deletes a transfer row', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Move', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' })], accountsFixture())
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Delete transaction: Move', {}, { timeout: 5000 }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/transactions/t1'))
    await waitFor(() => expect(screen.queryByText('Move')).not.toBeInTheDocument())
  })

  // TX-072 — a delete failure surfaces the generic error and keeps the row.
  it('shows the generic delete error and keeps the row on failure', { timeout: 15000 }, async () => {
    mockLoad([tx({ payee: 'Tesco' })])
    mockDelete.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Delete transaction: Tesco', {}, { timeout: 5000 }))
    expect(await screen.findByText('Could not delete that transaction.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Tesco')).toBeInTheDocument()
  })
})

describe('TransactionsPage catalog — filters & count', () => {
  // TX-074 / TX-005 — the Unassigned filter with no matches shows a placeholder; the count is the WHOLE list.
  it('shows the empty-filter placeholder while the count reflects the whole list', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 't1', payee: 'Rent', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 't2', payee: 'Bus', budgetItemId: 'i-internet', budgetItemName: 'Internet' }),
    ])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Rent', {}, { timeout: 5000 })
    expect(screen.getByText('2 transactions')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Unassigned' }))
    expect(await screen.findByText('Nothing left to assign.', {}, { timeout: 5000 })).toBeInTheDocument()
    // The "{n} transactions" count still counts the full list, not the filtered subset.
    expect(screen.getByText('2 transactions')).toBeInTheDocument()
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

  // TX-079 — a blank note sends payee: null (the server defaults the payee to "Transfer").
  it('sends payee null when the transfer note is blank', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost.mockResolvedValue({ data: tx({ payee: 'Transfer', type: 2, amount: 100, accountName: 'Joint', transferAccountName: 'Rainy Day' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '100')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a-joint')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a-rainy')
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/transactions/transfer', expect.objectContaining({ payee: null })),
    )
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

    // Split editor → the "add lines first" warning; open it via the row's ⑂.
    await user.click(screen.getByLabelText('Split transaction: Tesco'))
    expect(await screen.findByText('Add some expense budget lines first.', {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
