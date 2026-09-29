import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { setMoneyFormat } from '../lib/money'

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
    type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null,
    isSplit: false, splits: [],
  }
}

function membersFixture(): HouseholdMemberDto[] {
  return [
    { id: 'mem-alex', name: 'Alex', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.5 },
    { id: 'mem-sam', name: 'Sam', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.5 },
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
  afterEach(() => setMoneyFormat('comma-dot'))

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
    await user.click(screen.getByLabelText('Transfer completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions/transfer',
        expect.objectContaining({ amount: 50, fromAccountId: 'a1', toAccountId: 'a2', receivedOn: null }),
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
      data: { ...tx(), payee: 'Pharmacy', memberId: 'mem-alex', memberName: 'Alex' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transaction payee'), 'Pharmacy')
    await user.type(screen.getByLabelText('Transaction amount'), '12,50')
    // The member select appears once members have loaded.
    await user.selectOptions(await screen.findByLabelText('Transaction member', {}, { timeout: 5000 }), 'mem-alex')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ payee: 'Pharmacy', memberId: 'mem-alex' }),
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

  // W13 (P56): money from someone else's private account shows on the budget line it was put on,
  // named "Private account", and only its holder can change it.
  it('shows another login\'s private-account entry read-only', { timeout: 15000 }, async () => {
    mockLoad([
      { ...tx(), id: 't2', payee: 'Lidl', accountId: 'p9', accountName: 'Private account', budgetItemId: 'i-food', budgetItemName: 'Groceries', inPrivateAccount: true },
      tx(),
    ])

    renderPage()

    expect(await screen.findByText('Lidl', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Private account')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete transaction: Tesco')).toBeInTheDocument()
    expect(screen.queryByLabelText('Delete transaction: Lidl')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Edit transaction: Lidl')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Reassign Lidl')).not.toBeInTheDocument()
  })

  // W13 (P57): on a transfer between a shared and a private account, the others may confirm the
  // shared side's leg only: the receipt into the shared account, or the departure out of it.
  it('offers only the shared side\'s leg on a transfer with someone else\'s private account', { timeout: 15000 }, async () => {
    const transfer = { ...tx(), type: 2, amount: 50, inPrivateAccount: true }
    mockLoad([
      { ...transfer, id: 't3', payee: 'To Sam', accountId: 'a1', accountName: 'Everyday', transferAccountName: 'Private account', transferStatus: 'PendingReview', departedOn: null, receivedOn: '2026-06-11' },
      { ...transfer, id: 't4', payee: 'From Sam', accountName: 'Private account', transferAccountId: 'a1', transferAccountName: 'Everyday', transferStatus: 'InTransit', departedOn: '2026-06-10', receivedOn: null },
      { ...transfer, id: 't5', payee: 'Sam top-up', accountName: 'Private account', transferAccountId: 'a1', transferAccountName: 'Everyday', transferStatus: 'PendingReview', departedOn: null, receivedOn: '2026-06-12' },
    ], accountsFixture())

    renderPage()

    expect(await screen.findByRole('button', { name: 'Add departure date: To Sam' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm receipt: From Sam' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add departure date: Sam top-up' })).not.toBeInTheDocument()
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

  it('preserves an unchanged transaction amount with comma decimals', async () => {
    localStorage.setItem('zbb.numberFormat', 'dot-comma')
    const transaction = { ...tx(), amount: 1.234 }
    mockLoad([transaction])
    mockPut.mockResolvedValue({ data: transaction })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Edit transaction: Tesco'))
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1', {
      date: '2026-06-10', payee: 'Tesco', amount: 1.234, type: 0, accountId: null, memberId: null,
    }))
  })

  it('preserves existing split amounts and their total with comma decimals', async () => {
    localStorage.setItem('zbb.numberFormat', 'space-comma')
    const transaction = {
      ...tx(), amount: 3.5796, isSplit: true,
      splits: [
        { id: 's1', budgetItemId: 'i-rent', budgetItemName: 'Rent', amount: 1.234 },
        { id: 's2', budgetItemId: 'i-food', budgetItemName: 'Groceries', amount: 2.3456 },
      ],
    }
    mockLoad([transaction])
    mockPut.mockResolvedValue({ data: transaction })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Split transaction: Tesco'))
    expect(screen.getByLabelText('Save split')).toBeEnabled()
    await user.click(screen.getByLabelText('Save split'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1/splits', {
      allocations: [
        { budgetItemId: 'i-rent', amount: 1.234, memberId: null },
        { budgetItemId: 'i-food', amount: 2.3456, memberId: null },
      ],
    }))
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
          { id: 's1', budgetItemId: 'i-rent', budgetItemName: 'Rent', memberId: 'mem-alex', memberName: 'Alex', amount: 70 },
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
    await user.selectOptions(screen.getByLabelText('Split line 1 member'), 'mem-alex')
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
          { budgetItemId: 'i-rent', amount: 70, memberId: 'mem-alex' },
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

describe('TransactionsPage currency conversion (W08)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot')
  })

  const fxRow = (): TransactionDto => ({ ...tx(), id: 't-fx', payee: 'London Cab', currency: 'GBP', amount: 12.5, fxPending: true })

  /** mockLoad plus an answer for the conversion-suggestion endpoint. */
  function mockLoadWithSuggestion(transactions: TransactionDto[], suggestion: Record<string, unknown>) {
    mockLoad(transactions)
    const base = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string, config?: unknown) =>
      url === '/transactions/conversion-suggestion' ? Promise.resolve({ data: suggestion }) : base(url, config),
    )
  }

  it('flags a row waiting for its budget-currency amount and leaves it out of the totals', { timeout: 15000 }, async () => {
    mockLoad([fxRow(), tx()])

    renderPage()

    const tag = await screen.findByText('Needs EUR amount', {}, { timeout: 5000 })
    expect(tag).toHaveAttribute('title', expect.stringContaining('Not counted anywhere until you enter the amount in EUR'))
    expect(screen.getAllByText('Needs EUR amount')).toHaveLength(1) // only the waiting row
    // Its own figure is labelled with its code, never as budget money.
    expect(screen.getByText(/GBP 12\.50/)).toBeInTheDocument()
    // Money out counts only the EUR row (12.50), not 25.00.
    expect(screen.getByText('€12.50')).toBeInTheDocument()
    expect(screen.queryByText('€25.00')).not.toBeInTheDocument()
  })

  it('offers no Enter amount on a waiting row that sits on an account (its balance would change)', { timeout: 15000 }, async () => {
    mockLoad([{ ...fxRow(), accountId: 'acc-gbp', accountName: 'UK Current' }])

    renderPage()

    expect(await screen.findByText('Needs EUR amount', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enter amount in EUR/ })).not.toBeInTheDocument()
  })

  it('Enter amount: Suggest fills an editable amount without saving; Confirm saves it', { timeout: 15000 }, async () => {
    mockLoadWithSuggestion([fxRow()], {
      currency: 'GBP', amount: 12.5, budgetCurrency: 'EUR', date: '2026-06-10',
      rate: 1.1834, suggestedAmount: 14.79, source: 'ECB reference rate',
    })
    mockPut.mockResolvedValue({
      data: { ...fxRow(), currency: 'EUR', amount: 14.8, fxPending: false, originalAmount: 12.5, originalCurrency: 'GBP' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Enter amount in EUR: London Cab' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText(/GBP 12\.50 on/)).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Suggest' }))
    const field = dialog.getByLabelText('Amount in EUR') as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('14.79'))
    expect(mockGet).toHaveBeenCalledWith('/transactions/conversion-suggestion', {
      params: { currency: 'GBP', amount: 12.5, date: '2026-06-10' },
    })
    expect(dialog.getByText(/ECB reference rate: 1 GBP = 1\.1834 EUR/)).toBeInTheDocument()
    // A suggestion alone has no monetary effect: nothing is saved.
    expect(mockPut).not.toHaveBeenCalled()

    // The user's own figure is kept as typed.
    await user.clear(field)
    await user.type(field, '14.8')
    await user.click(dialog.getByRole('button', { name: 'Confirm amount' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-fx/converted-amount', { amount: 14.8 }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The row is replaced: counted in EUR, with a muted note of what was paid.
    expect(screen.queryByText('Needs EUR amount')).not.toBeInTheDocument()
    expect(screen.getByText('GBP 12.50')).toHaveAttribute('title', 'Paid in GBP')
    expect(screen.getAllByText(/€14\.80/).length).toBeGreaterThanOrEqual(1)
  })

  it('Enter amount: says so when no suggestion is available and shows a refusal', { timeout: 15000 }, async () => {
    mockLoadWithSuggestion([fxRow()], {
      currency: 'GBP', amount: 12.5, budgetCurrency: 'EUR', date: '2026-06-10',
      rate: null, suggestedAmount: null, source: 'ECB reference rate',
    })
    mockPut.mockRejectedValue({ response: { status: 400, data: { errors: { Amount: ['This transaction is not waiting for an amount.'] } } } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Enter amount in EUR: London Cab' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Suggest' }))
    expect(await dialog.findByText(/No suggestion is available for GBP on this date/)).toBeInTheDocument()
    expect((dialog.getByLabelText('Amount in EUR') as HTMLInputElement).value).toBe('')

    await user.type(dialog.getByLabelText('Amount in EUR'), '15')
    await user.click(dialog.getByRole('button', { name: 'Confirm amount' }))
    expect(await dialog.findByText('This transaction is not waiting for an amount.')).toBeInTheDocument()
  })

  it('add form: "Paid in another currency" suggests the Amount and sends the foreign figure', { timeout: 15000 }, async () => {
    mockLoadWithSuggestion([], {
      currency: 'USD', amount: 20, budgetCurrency: 'EUR', date: '2026-06-10',
      rate: 0.92, suggestedAmount: 18.4, source: 'ECB reference rate',
    })
    mockPost.mockResolvedValue({
      data: { ...tx(), payee: 'Diner', amount: 18.4, originalAmount: 20, originalCurrency: 'USD' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.clear(dialog.getByLabelText('Transaction date'))
    await user.type(dialog.getByLabelText('Transaction date'), '2026-06-10')
    await user.type(dialog.getByLabelText('Transaction payee'), 'Diner')
    await user.click(dialog.getByLabelText('Paid in another currency'))
    await user.type(dialog.getByLabelText('Currency paid in'), 'usd')
    await user.type(dialog.getByLabelText('Amount paid in that currency'), '20')
    await user.click(dialog.getByRole('button', { name: 'Suggest' }))

    const amount = dialog.getByLabelText('Transaction amount') as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('18.4'))
    expect(mockGet).toHaveBeenCalledWith('/transactions/conversion-suggestion', {
      params: { currency: 'USD', amount: 20, date: '2026-06-10' },
    })
    expect(mockPost).not.toHaveBeenCalled()

    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ payee: 'Diner', amount: 18.4, originalAmount: 20, originalCurrency: 'USD' }),
      ),
    )
  })

  it('add form: a transaction paid in the budget currency carries no foreign figure', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: { ...tx(), payee: 'Cafe' } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Transaction payee'), 'Cafe')
    await user.type(dialog.getByLabelText('Transaction amount'), '4.5')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>
    expect(body).not.toHaveProperty('originalAmount')
    expect(body).not.toHaveProperty('originalCurrency')
  })
})
