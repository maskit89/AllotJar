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
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { TransactionsPage } from './TransactionsPage'
import { AuthProvider } from '../auth/AuthContext'

function budget(): BudgetMonthDto {
  return {
    id: 'm1', key: '2026-06', year: 2026, month: 6, baseCurrency: 'EUR',
    totalIncome: 3000, totalPlanned: 1000, remainingToBudget: 2000, isBalanced: false,
    categories: [
      {
        id: 'c1', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 1000, totalActual: 0,
        items: [
          { id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1000, actualAmount: 0, remaining: 1000},
        ],
      },
      {
        id: 'c2', name: 'Food', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0,
        items: [
          { id: 'i-food', name: 'Groceries', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0},
        ],
      },
    ],
  }
}

function tx(): TransactionDto {
  return {
    id: 't1', date: '2026-06-10', payee: 'Tesco', amount: 12.5, currency: 'EUR',
    exchangeRate: 1, baseAmount: 12.5, type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null,
    isSplit: false, splits: [],
  }
}

function membersFixture(): HouseholdMemberDto[] {
  return [
    { id: 'mem-chris', name: 'Chris', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.5 },
    { id: 'mem-liza', name: 'Liza', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.5 },
  ]
}

function accountsFixture(): AccountDto[] {
  return [
    { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, currentBalance: 100, displayOrder: 0 },
    { id: 'a2', name: 'Savings', type: 1, currency: 'EUR', openingBalance: 500, currentBalance: 500, displayOrder: 1 },
  ]
}

function mockLoad(
  transactions: TransactionDto[],
  accounts: AccountDto[] = [],
  members: HouseholdMemberDto[] = [],
) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/transactions') return Promise.resolve({ data: transactions })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/members') return Promise.resolve({ data: members })
    return Promise.resolve({ data: budget() })
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

describe('TransactionsPage manual sheet', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
  })

  it('adds a manual transaction assigned to a line', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({
      data: { ...tx(), payee: 'Tesco', amount: 12.5, budgetItemId: 'i-rent', budgetItemName: 'Rent' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco')
    await user.type(screen.getByLabelText('Transaction amount'), '12,50')
    await user.selectOptions(screen.getByLabelText('Assign transaction to'), 'i-rent')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ payee: 'Tesco', amount: 12.5, type: 0, budgetItemId: 'i-rent' }),
      ),
    )
    expect(await screen.findByText('Tesco', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('tags a new transaction to an account', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost.mockResolvedValue({
      data: { ...tx(), accountId: 'a1', accountName: 'Everyday' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco')
    await user.type(screen.getByLabelText('Transaction amount'), '12,50')
    // The account select appears once accounts have loaded.
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a1')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ payee: 'Tesco', accountId: 'a1' }),
      ),
    )
    // The posted account shows in its column in the register (not the modal option).
    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    expect(table.getByText('Everyday')).toBeInTheDocument()
  })

  it('records a transfer between two accounts', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    mockPost.mockResolvedValue({
      data: {
        ...tx(),
        payee: 'Move to savings',
        amount: 50,
        type: 2,
        accountId: 'a1', accountName: 'Everyday',
        transferAccountId: 'a2', transferAccountName: 'Savings',
      },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    // The Transaction/Transfer toggle appears in the modal once 2+ accounts have loaded.
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '50')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a1')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a2')
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions/transfer',
        expect.objectContaining({ amount: 50, fromAccountId: 'a1', toAccountId: 'a2' }),
      ),
    )
    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    expect(table.getByText('Move to savings')).toBeInTheDocument()
    expect(table.getByText('Transfer')).toBeInTheDocument()
  })

  it('blocks a transfer between the same account without calling the API', { timeout: 15000 }, async () => {
    mockLoad([], accountsFixture())
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '50')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a1')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a1')
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    expect(await screen.findByText(/two different accounts/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('attributes a new transaction to a household member', { timeout: 15000 }, async () => {
    mockLoad([], [], membersFixture())
    mockPost.mockResolvedValue({
      data: { ...tx(), payee: 'Pharmacy', memberId: 'mem-chris', memberName: 'Chris' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction payee'), 'Pharmacy')
    await user.type(screen.getByLabelText('Transaction amount'), '12,50')
    // The member select appears once members have loaded.
    await user.selectOptions(await screen.findByLabelText('Transaction member', {}, { timeout: 5000 }), 'mem-chris')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ payee: 'Pharmacy', memberId: 'mem-chris' }),
      ),
    )
    // The member isn't a register column in the redesign, so just confirm the row landed.
    expect(await screen.findByText('Pharmacy', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('rejects a non-positive amount without calling the API', { timeout: 15000 }, async () => {
    mockLoad([])
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction amount'), '0')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    expect(await screen.findByText(/valid amount/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('deletes a transaction', { timeout: 15000 }, async () => {
    mockLoad([tx()])
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    const del = await screen.findByLabelText('Delete transaction: Tesco', {}, { timeout: 5000 })
    await user.click(del)

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/transactions/t1'))
    await waitFor(() => expect(screen.queryByText('Tesco')).not.toBeInTheDocument())
  })

  it('edits a transaction inline', { timeout: 15000 }, async () => {
    mockLoad([tx()])
    mockPut.mockResolvedValue({ data: { ...tx(), payee: 'Aldi', amount: 31.5 } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit transaction: Tesco', {}, { timeout: 5000 }))
    const payeeInput = screen.getByLabelText('Edit payee')
    await user.clear(payeeInput)
    await user.type(payeeInput, 'Aldi')
    const amountInput = screen.getByLabelText('Edit amount')
    await user.clear(amountInput)
    await user.type(amountInput, '31,50')
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t1',
        expect.objectContaining({ payee: 'Aldi', amount: 31.5 }),
      ),
    )
    expect(await screen.findByText('Aldi', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('splits a transaction across two budget lines', { timeout: 15000 }, async () => {
    mockLoad([{ ...tx(), amount: 100 }])
    mockPut.mockResolvedValue({
      data: {
        ...tx(),
        amount: 100,
        isSplit: true,
        splits: [
          { id: 's1', budgetItemId: 'i-rent', budgetItemName: 'Rent', amount: 70 },
          { id: 's2', budgetItemId: 'i-food', budgetItemName: 'Groceries', amount: 30 },
        ],
      },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Split transaction: Tesco', {}, { timeout: 5000 }))

    // Save stays disabled until the lines add up to the total.
    expect(screen.getByLabelText('Save split')).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-rent')
    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-food')
    await user.type(screen.getByLabelText('Split line 2 amount'), '30')

    await waitFor(() => expect(screen.getByLabelText('Save split')).toBeEnabled())
    await user.click(screen.getByLabelText('Save split'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/splits', {
        allocations: [
          { budgetItemId: 'i-rent', amount: 70, memberId: null },
          { budgetItemId: 'i-food', amount: 30, memberId: null },
        ],
      }),
    )
    expect(await screen.findByText('Split', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('blocks a split that does not add up to the total', { timeout: 15000 }, async () => {
    mockLoad([{ ...tx(), amount: 100 }])
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Split transaction: Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-rent')
    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-food')
    await user.type(screen.getByLabelText('Split line 2 amount'), '20') // 90 != 100

    expect(screen.getByLabelText('Save split')).toBeDisabled()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('filters the register to just the unassigned transactions', { timeout: 15000 }, async () => {
    mockLoad([
      tx(), // Tesco — unassigned (budgetItemId null)
      { ...tx(), id: 't2', payee: 'Rent payment', budgetItemId: 'i-rent', budgetItemName: 'Rent' },
    ])
    const user = userEvent.setup()

    renderPage()

    await screen.findByText('Tesco', {}, { timeout: 5000 })
    expect(screen.getByText('Rent payment')).toBeInTheDocument()

    // Unassigned only — the already-assigned transaction drops out.
    await user.click(screen.getByRole('button', { name: 'Unassigned' }))
    await waitFor(() => expect(screen.queryByText('Rent payment')).not.toBeInTheDocument())
    expect(screen.getByText('Tesco')).toBeInTheDocument()

    // Back to All — both return.
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('Rent payment', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // TX-060.. — splitting an expense across categories directly in the Add modal.

  it('split mode replaces the single category and member selects with slice rows', { timeout: 15000 }, async () => {
    mockLoad([], [], membersFixture())
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.click(await screen.findByRole('button', { name: 'Split across categories' }, { timeout: 5000 }))

    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()
    expect(screen.getByLabelText('Split line 2 category')).toBeInTheDocument()
    expect(screen.queryByLabelText('Assign transaction to')).not.toBeInTheDocument()
    // The whole-transaction member select hides too — members are attributed per slice.
    expect(screen.queryByLabelText('Transaction member')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Split line 1 member')).toBeInTheDocument()

    // "Don't split" restores the single-category form.
    await user.click(screen.getByRole('button', { name: "Don't split" }))
    expect(screen.getByLabelText('Assign transaction to')).toBeInTheDocument()
    expect(screen.queryByLabelText('Split line 1 category')).not.toBeInTheDocument()
  })

  it('posts an atomic split payload once the slices sum to the amount', { timeout: 15000 }, async () => {
    mockLoad([], [], membersFixture())
    mockPost.mockResolvedValue({
      data: {
        ...tx(),
        payee: 'Supermarket',
        amount: 100,
        isSplit: true,
        splits: [
          { id: 's1', budgetItemId: 'i-rent', budgetItemName: 'Rent', memberId: 'mem-chris', memberName: 'Chris', amount: 70 },
          { id: 's2', budgetItemId: 'i-food', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 30 },
        ],
      },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction payee'), 'Supermarket')
    await user.type(screen.getByLabelText('Transaction amount'), '100')
    await user.click(await screen.findByRole('button', { name: 'Split across categories' }, { timeout: 5000 }))

    // Unallocated remainder disables the submit.
    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-rent')
    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    await user.selectOptions(screen.getByLabelText('Split line 1 member'), 'mem-chris')
    expect(dialog.getByRole('button', { name: 'Add transaction' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-food')
    await user.type(screen.getByLabelText('Split line 2 amount'), '30')
    expect(screen.getByText('Fully allocated')).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/transactions', {
        date: expect.any(String),
        payee: 'Supermarket',
        amount: 100,
        type: 0,
        budgetItemId: null,
        accountId: null,
        memberId: null,
        splits: [
          { budgetItemId: 'i-rent', amount: 70, memberId: 'mem-chris' },
          { budgetItemId: 'i-food', amount: 30, memberId: null },
        ],
      }),
    )
    // The register row renders the violet Split badge + slice summary.
    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    expect(table.getByText('Split')).toBeInTheDocument()
  })

  it('guards the Enter-key path: mismatched or incomplete slices never post', { timeout: 15000 }, async () => {
    mockLoad([], [], membersFixture())
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.type(screen.getByLabelText('Transaction payee'), 'Supermarket')
    await user.type(screen.getByLabelText('Transaction amount'), '100')
    await user.click(await screen.findByRole('button', { name: 'Split across categories' }, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-rent')
    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-food')
    await user.type(screen.getByLabelText('Split line 2 amount'), '20')

    // Enter in the amount field bypasses the disabled button — the guard must catch it.
    await user.type(screen.getByLabelText('Transaction amount'), '{Enter}')
    expect(await screen.findByText('The split lines must add up to the transaction total.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // Fix the sum but blank a category — the completeness guard fires instead.
    await user.clear(screen.getByLabelText('Split line 2 amount'))
    await user.type(screen.getByLabelText('Split line 2 amount'), '30')
    await user.selectOptions(screen.getByLabelText('Split line 2 category'), '')
    await user.type(screen.getByLabelText('Transaction amount'), '{Enter}')
    expect(
      await screen.findByText('Give every split line a category and an amount greater than zero.'),
    ).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('switching the type to Income resets split mode', { timeout: 15000 }, async () => {
    mockLoad([], [], membersFixture())
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.click(await screen.findByRole('button', { name: 'Split across categories' }, { timeout: 5000 }))
    expect(screen.getByLabelText('Split line 1 category')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Transaction type'), '1')
    expect(screen.queryByLabelText('Split line 1 category')).not.toBeInTheDocument()

    // Back to Expense: split mode was RESET, not remembered — the single select returns.
    await user.selectOptions(screen.getByLabelText('Transaction type'), '0')
    expect(screen.getByLabelText('Assign transaction to')).toBeInTheDocument()
    expect(screen.queryByLabelText('Split line 1 category')).not.toBeInTheDocument()
  })
})

describe('TransactionsPage FX-pending flag', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
  })

  it('flags an FX-pending row next to its amount and leaves settled rows unmarked', { timeout: 15000 }, async () => {
    // fxPending = the server resolved no exchange rate (amount counts at face value);
    // the register must say so instead of presenting the figure as settled.
    mockLoad([
      { ...tx(), id: 't-fx', payee: 'London Cab', currency: 'GBP', fxPending: true },
      tx(),
    ])

    renderPage()

    const tag = await screen.findByText('Rate pending', {}, { timeout: 5000 })
    expect(tag).toHaveAttribute('title', expect.stringContaining('face value'))
    expect(screen.getAllByText('Rate pending')).toHaveLength(1) // only the unresolved row
  })
})
