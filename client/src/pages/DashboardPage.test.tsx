import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetMonthDto, BudgetTemplateDto } from '../types'

// Control the API from the tests. vi.hoisted lets the mock factory below
// reference these before the module under test is imported.
const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { DashboardPage } from './DashboardPage'
import { AuthProvider } from '../auth/AuthContext'
import { MonthProvider } from '../features/MonthContext'

// Income(Take-home Pay 3000) at the top + Housing(Rent 1100). Remaining = 1900.
function budget(): BudgetMonthDto {
  return {
    id: 'm1',
    key: '2026-06',
    year: 2026,
    month: 6,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: 1100,
    remainingToBudget: 1900,
    isBalanced: false,
    categories: [
      {
        id: 'inc',
        name: 'Income',
        kind: 'Income',
        displayOrder: 0,
        totalPlanned: 3000,
        totalActual: 0,
        items: [
          { id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 0, remaining: 3000 },
        ],
      },
      {
        id: 'c1',
        name: 'Housing',
        kind: 'Expense',
        displayOrder: 0,
        totalPlanned: 1100,
        totalActual: 0,
        items: [
          { id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 0, remaining: 1100 },
        ],
      },
    ],
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MonthProvider>
          <DashboardPage />
        </MonthProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DashboardPage optimistic editing', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
  })

  it('optimistically drives Remaining to €0,00 on a successful edit', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    mockPut.mockResolvedValue({ data: {} })

    renderPage()

    // The planned amount reads as clean text; click it to reveal the editor.
    fireEvent.click(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })) as HTMLInputElement
    // Set the planned amount to €3.000 and commit on blur. The dashboard fires
    // three loads on mount (/budget/{y}/{m}, /budget/months, /budget/templates);
    // the input appears after the first, but the other two settle DURING this
    // interaction. Under parallel-CI CPU contention their re-renders race the
    // controlled input, so a single change event can be reverted before React's
    // onChange runs — leaving the field at "1100", no commit fired, and the banner
    // stuck on amber "Still to assign". Re-apply the value until it actually sticks
    // in the controlled input, then blur — robust to those interleaved re-renders.
    await waitFor(
      () => {
        fireEvent.change(input, { target: { value: '3000' } }) // assign the remaining €1.900 to Rent
        expect(input).toHaveValue('3000')
      },
      { timeout: 5000 },
    )
    fireEvent.blur(input) // blur -> commit

    // The hero flips to the balanced state and the API was called with the amount.
    expect(await screen.findByText(/every euro has a job/i, {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 3000 }),
    )
  })

  it('rolls back to the previous value and shows an error when the save fails', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    mockPut.mockRejectedValue(new Error('network'))
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '3000')
    await user.tab()

    // The failure surfaces and the planned amount reverts to its pre-edit value —
    // the editor closes, so the at-rest "€1,100.00" control shows the rollback.
    expect(await screen.findByText(/reverted to the previous value/, {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByLabelText('Planned amount for Rent')).toHaveTextContent('1,100.00'),
      { timeout: 5000 },
    )
  })

  it('adds an income source and reconciles from the server response', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withFreelance = budget()
    withFreelance.categories[0].items.push({
      id: 'i-free', name: 'Freelance', displayOrder: 1, plannedAmount: 0, actualAmount: 0, remaining: 0,
    })
    mockPost.mockResolvedValue({ data: withFreelance })
    const user = userEvent.setup()

    renderPage()

    const addInput = await screen.findByLabelText('New income source name', {}, { timeout: 5000 })
    await user.type(addInput, 'Freelance')
    await user.click(screen.getByRole('button', { name: 'Add income source' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget/categories/inc/items', {
        name: 'Freelance',
        plannedAmount: 0,
      }),
    )
    expect(await screen.findByDisplayValue('Freelance', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('deletes an income source', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withoutPay = budget()
    withoutPay.categories[0].items = []
    mockDelete.mockResolvedValue({ data: withoutPay })
    const user = userEvent.setup()

    renderPage()

    const del = await screen.findByLabelText('Delete Take-home Pay', {}, { timeout: 5000 })
    await user.click(del)

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/budget/items/i-pay'))
  })

  it('shows the transaction-derived spent amount as read-only', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )

    renderPage()

    // Spent/Received are never editable now — they're totalled from assigned transactions.
    await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Spent for Rent')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Received for Take-home Pay')).not.toBeInTheDocument()
  })

  it('adds a category group and reconciles from the server response', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withSubs = budget()
    withSubs.categories.push({
      id: 'c-subs', name: 'Subscriptions', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0, items: [],
    })
    mockPost.mockResolvedValue({ data: withSubs })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add a group' }, { timeout: 5000 }))
    await user.type(await screen.findByLabelText('New category group name', {}, { timeout: 5000 }), 'Subscriptions')
    await user.click(screen.getByRole('button', { name: 'Add category group' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget/categories', {
        budgetMonthId: 'm1',
        name: 'Subscriptions',
        isSavings: false,
      }),
    )
    expect(await screen.findByDisplayValue('Subscriptions', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('adds an expense line to a group', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withFuel = budget()
    withFuel.categories[1].items.push({
      id: 'i-fuel', name: 'Fuel', displayOrder: 1, plannedAmount: 0, actualAmount: 0, remaining: 0,
    })
    mockPost.mockResolvedValue({ data: withFuel })
    const user = userEvent.setup()

    renderPage()

    const input = await screen.findByLabelText('Add a line to Housing', {}, { timeout: 5000 })
    await user.type(input, 'Fuel{Enter}') // Enter submits — avoids "+ Add" button ambiguity

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget/categories/c1/items', { name: 'Fuel', plannedAmount: 0 }),
    )
  })

  it('deletes a category group only after confirming', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withoutHousing = budget()
    withoutHousing.categories = withoutHousing.categories.filter((c) => c.id !== 'c1')
    mockDelete.mockResolvedValue({ data: withoutHousing })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Delete group Housing', {}, { timeout: 5000 }))
    // Nothing deleted until the second (confirm) click.
    expect(mockDelete).not.toHaveBeenCalled()
    await user.click(await screen.findByLabelText('Confirm delete Housing', {}, { timeout: 5000 }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/budget/categories/c1'))
  })

  it('reorders expense groups via the move buttons', { timeout: 15000 }, async () => {
    const b = budget()
    b.categories.push({
      id: 'c2', name: 'Food', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0, items: [],
    })
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )
    mockPut.mockResolvedValue({ data: b })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move Food up', {}, { timeout: 5000 }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/categories/order', {
        budgetMonthId: 'm1',
        orderedCategoryIds: ['c2', 'c1'],
      }),
    )
  })

  it('reorders lines within a group via the move buttons', { timeout: 15000 }, async () => {
    const b = budget()
    b.categories[1].items.push({
      id: 'i-util', name: 'Utilities', displayOrder: 1,
      plannedAmount: 100, actualAmount: 0, remaining: 100,
    })
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )
    mockPut.mockResolvedValue({ data: b })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move Utilities up', {}, { timeout: 5000 }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/categories/c1/items/order', {
        orderedItemIds: ['i-util', 'i-rent'],
      }),
    )
  })

  it('renders a fund group with its rolled-over Available balance', { timeout: 15000 }, async () => {
    const b = budget()
    b.categories.push({
      id: 'jars', name: 'Sinking Funds', kind: 'Savings', displayOrder: 0, totalPlanned: 100, totalActual: 0,
      items: [
        {
          id: 'i-car', name: 'Car', displayOrder: 0, plannedAmount: 100, actualAmount: 30,
          remaining: 70, savingsId: 'fund-car', savingsAvailable: 170,
        },
      ],
    })
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )

    renderPage()

    expect(await screen.findByDisplayValue('Car', {}, { timeout: 5000 })).toBeInTheDocument()
    // The fund's available balance (€170.00) is shown, rolled over across months.
    expect(screen.getByText('€170.00')).toBeInTheDocument()
  })

  it('creates a fund group when the kind is set to Fund', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withFunds = budget()
    withFunds.categories.push({
      id: 'jars', name: 'Sinking Funds', kind: 'Savings', displayOrder: 0, totalPlanned: 0, totalActual: 0, items: [],
    })
    mockPost.mockResolvedValue({ data: withFunds })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add a group' }, { timeout: 5000 }))
    await user.type(await screen.findByLabelText('New category group name', {}, { timeout: 5000 }), 'Sinking Funds')
    await user.selectOptions(screen.getByLabelText('New group kind'), 'savings')
    await user.click(screen.getByRole('button', { name: 'Add category group' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget/categories', {
        budgetMonthId: 'm1',
        name: 'Sinking Funds',
        isSavings: true,
      }),
    )
  })

  it('marks an expense line as a bill with a due day', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    mockPut.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Add a due date to Rent', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Due day for Rent'), '15')
    await user.click(screen.getByLabelText('Save due day for Rent'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent/bill', { dueDay: 15 }),
    )
  })

  it('toggles a bill line as paid and shows the bills summary', { timeout: 15000 }, async () => {
    const b = budget()
    b.categories[1].items[0] = { ...b.categories[1].items[0], dueDay: 15, isPaid: false }
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )
    mockPut.mockResolvedValue({ data: b })
    const user = userEvent.setup()

    renderPage()

    // The unpaid bill shows in the summary.
    expect(await screen.findByText(/Bills: 0\/1 paid/, {}, { timeout: 5000 })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Mark Rent paid' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent/paid', { isPaid: true }),
    )
  })

  it('flags an overdue bill in the summary and on its row', { timeout: 15000 }, async () => {
    const b = budget() // month 2026-06
    b.categories[1].items[0] = { ...b.categories[1].items[0], dueDay: 5, isPaid: false }
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )

    // Render directly so we can pin "today" to the 20th — past Rent's due day (5th).
    render(
      <MemoryRouter>
        <AuthProvider>
          <MonthProvider>
            <DashboardPage today={new Date(2026, 5, 20)} />
          </MonthProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText(/1 overdue/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTitle(/Overdue/)).toBeInTheDocument()
  })
})

describe('DashboardPage month navigation', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
  })

  it('offers to copy the previous month when navigating to an empty month', { timeout: 15000 }, async () => {
    const now = new Date()
    const cy = now.getFullYear()
    const cm = now.getMonth() + 1
    const ny = cm === 12 ? cy + 1 : cy
    const nm = cm === 12 ? 1 : cm + 1
    const curUrl = `/budget/${cy}/${cm}`
    const nextUrl = `/budget/${ny}/${nm}`

    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') {
        return Promise.resolve({ data: [{ year: cy, month: cm, key: `${cy}-${cm}` }] })
      }
      if (url === nextUrl) return Promise.reject({ response: { status: 404 } })
      if (url === curUrl) return Promise.resolve({ data: budget() })
      return Promise.resolve({ data: budget() })
    })
    mockPost.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })
    await user.click(screen.getByLabelText('Next month'))

    expect(await screen.findByText(/No budget for .* yet/, {}, { timeout: 5000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy last month’s budget' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/budget',
        expect.objectContaining({ year: ny, month: nm, copyFromPrevious: true }),
      ),
    )
    expect(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('offers quick-start templates for an empty month and creates from one', { timeout: 15000 }, async () => {
    const now = new Date()
    const cy = now.getFullYear()
    const cm = now.getMonth() + 1
    const template: BudgetTemplateDto = {
      key: 'essentials',
      name: 'Essentials',
      description: 'A clean start.',
      groups: [
        { name: 'Income', kind: 'Income', lines: ['Take-home Pay'] },
        { name: 'Housing', kind: 'Expense', lines: ['Rent'] },
      ],
    }

    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [] })
      if (url === '/budget/templates') return Promise.resolve({ data: [template] })
      if (url === `/budget/${cy}/${cm}`) return Promise.reject({ response: { status: 404 } })
      return Promise.resolve({ data: budget() })
    })
    mockPost.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Start from the Essentials template', {}, { timeout: 5000 }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget', {
        year: cy,
        month: cm,
        copyFromPrevious: false,
        templateKey: 'essentials',
      }),
    )
  })
})
