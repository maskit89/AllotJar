import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, BudgetTemplateDto, JarDto } from '../types'

// Control the API from the tests.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

// The household shape drives the income member picker; default = solo (hidden),
// individual tests flip `household.current` to a shared fixture.
const household = vi.hoisted(() => ({
  current: { members: [] as unknown[], isShared: false, loading: false, refreshHousehold: async () => {} },
}))
vi.mock('../features/HouseholdContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/HouseholdContext')>()),
  useHousehold: () => household.current,
}))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { DashboardPage } from './DashboardPage'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'
import { jar } from '../test/fixtures/jars'

// Income(Take-home Pay 3000) at the top + Housing(Rent 1100). Remaining = 1900.
function budget(): BudgetMonthDto {
  return budgetMonth({
    key: '2026-06',
    month: 6,
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
      budgetCategory({ id: 'c1', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1100 })] }),
    ],
  })
}

const renderPage = () => renderWithProviders(<DashboardPage />, { month: true })

describe('DashboardPage optimistic editing', () => {
  beforeEach(() => {
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
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
      expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 3000, version: null }),
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

  // D1: a planned amount with more decimals than cents stays in the editor with a message.
  it('refuses a planned amount with a third decimal, keeping it open with a message', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '1100.555')
    await user.tab()

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Enter at most 2 decimal places.')
    expect(screen.getByLabelText('Planned amount for Rent')).toHaveValue('1100.555')
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('typing into the planned editor replaces the selected value — no leading-zero amounts', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    mockPut.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    // Open the editor; it mounts autofocused with the current value selected.
    await user.click(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })) as HTMLInputElement
    await waitFor(() => expect(input).toHaveFocus(), { timeout: 5000 })
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    // Type WITHOUT clearing — the focus-time selection makes "50" replace "1100"
    // instead of appending into "110050".
    await user.keyboard('50')
    expect(input).toHaveValue('50')
    await user.tab()

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 50, version: null }),
      { timeout: 5000 },
    )
  })

  it('adds an income source and reconciles from the server response', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    const withFreelance = budget()
    withFreelance.categories[0].items.push(budgetItem({ id: 'i-free', name: 'Freelance', displayOrder: 1 }))
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
    withFuel.categories[1].items.push(budgetItem({ id: 'i-fuel', name: 'Fuel', displayOrder: 1 }))
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
    b.categories[1].items.push(budgetItem({ id: 'i-util', name: 'Utilities', displayOrder: 1, plannedAmount: 100 }))
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
    b.categories.push(budgetCategory({
      id: 'jars', name: 'Sinking Funds', kind: 'Savings', totalActual: 0,
      items: [budgetItem({ id: 'i-car', name: 'Car', plannedAmount: 100, actualAmount: 30, savingsId: 'fund-car', savingsAvailable: 170 })],
    }))
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )

    renderPage()

    expect(await screen.findByDisplayValue('Car', {}, { timeout: 5000 })).toBeInTheDocument()
    // The fund's available balance (€170.00) is shown, rolled over across months.
    expect(screen.getByText('€170.00')).toBeInTheDocument()
  })

  it('CAT-023: a Savings group that holds a jar\'s line offers no delete; an empty one does (rule 60)', { timeout: 15000 }, async () => {
    const b = budget()
    b.categories.push(
      budgetCategory({
        id: 'jars', name: 'Sinking Funds', kind: 'Savings',
        items: [budgetItem({ id: 'i-car', name: 'Car', plannedAmount: 100, savingsId: 'fund-car', savingsAvailable: 100 })],
      }),
      budgetCategory({ id: 'later', name: 'Later', kind: 'Savings', displayOrder: 1 }),
    )
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: b }),
    )

    renderPage()

    expect(await screen.findByLabelText('Delete group Later', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Delete group Sinking Funds')).toBeNull()
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

    // Pin "today" to the 20th — past Rent's due day (5th).
    renderWithProviders(<DashboardPage today={new Date(2026, 5, 20)} />, { month: true })

    expect(await screen.findByText(/1 overdue/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTitle(/Overdue/)).toBeInTheDocument()
  })
})

// Rule 73/81: a savings line is a jar, created through the shared jar form (which needs an
// account); the Budget page shows a first-run checklist until accounts, month and a jar exist.
describe('DashboardPage jars and first-run checklist', () => {
  const JOINT: AccountDto = { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 500, openingDate: '2026-01-01', currentBalance: 500, displayOrder: 0 }
  const HOLIDAY: JarDto = jar({
    id: 'jar-holiday', name: 'Holiday', kind: 1, targetAmount: 1200, targetDate: null, recurMonths: null,
    currentBalance: 100, balanceAsOf: '2026-06-15', plannedThisMonth: 100, remainingThisMonth: 100, deadline: null, fundingCompletesOn: null,
  })

  function mockLoads(opts: { month?: BudgetMonthDto | null; accounts?: AccountDto[]; jars?: JarDto[] } = {}) {
    const { month = budget(), accounts = [], jars = [] } = opts
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months' || url === '/budget/templates') return Promise.resolve({ data: [] })
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/jars') return Promise.resolve({ data: jars })
      if (/^\/budget\/\d+\/\d+$/.test(url)) {
        return month ? Promise.resolve({ data: month }) : Promise.reject({ response: { status: 404 } })
      }
      return Promise.resolve({ data: {} })
    })
  }

  function budgetWithSavings(available: number | null): BudgetMonthDto {
    const b = budget()
    b.categories.push(budgetCategory({
      id: 'sav', name: 'Savings', kind: 'Savings',
      items: [budgetItem({ id: 'i-holiday', name: 'Holiday', plannedAmount: 100, savingsId: 'jar-holiday', savingsAvailable: available })],
    }))
    return b
  }

  beforeEach(() => {
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })

  it('replaces the savings "add line" input with an Add jar button that opens the jar form and posts to /jars', { timeout: 15000 }, async () => {
    mockLoads({ month: budgetWithSavings(100), accounts: [JOINT], jars: [HOLIDAY] })
    const planted = budgetWithSavings(100)
    planted.categories[2].items.push(budgetItem({ id: 'i-car', name: 'Car', displayOrder: 1, plannedAmount: 50, savingsId: 'jar-car', savingsAvailable: 0 }))
    mockPost.mockResolvedValue({ data: { ...HOLIDAY, id: 'jar-car', name: 'Car', targetAmount: 600, targetDate: '2027-03-01', deadline: '2027-03-01', currentBalance: 0, plannedThisMonth: 50, remainingThisMonth: 50 } })
    const user = userEvent.setup()

    renderPage()

    // No bare "add a savings goal" line input any more (a savings line is a jar).
    await screen.findByLabelText('Rename group Savings', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Add a savings goal to Savings')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add a jar to Savings' }))

    // The SAME jar form as the Jars page: account required, initial allocation on create
    // (under "More options"), and no Type question — Repeats decides the kind.
    const dialog = within(await screen.findByRole('dialog', { name: 'New jar' }, { timeout: 5000 }))
    expect(dialog.getByLabelText('Funding account')).toHaveValue('acc1')
    await user.click(dialog.getByRole('button', { name: 'More options' }))
    expect(dialog.getByLabelText('Already set aside')).toBeInTheDocument()
    await user.selectOptions(dialog.getByLabelText('Repeats'), '0') // Doesn’t repeat: a Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Car')
    await user.type(dialog.getByLabelText('Target amount'), '600')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-03-01' } })
    // After the POST the page re-reads the month (the server planted the line) and the jars.
    mockGet.mockImplementation((url: string) => {
      if (url === '/jars') return Promise.resolve({ data: [HOLIDAY, { ...HOLIDAY, id: 'jar-car', name: 'Car' }] })
      if (url === '/accounts') return Promise.resolve({ data: [JOINT] })
      if (/^\/budget\/\d+\/\d+$/.test(url)) return Promise.resolve({ data: planted })
      return Promise.resolve({ data: [] })
    })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name: 'Car', kind: 1, targetAmount: 600, fundingAccountId: 'acc1', initialAllocation: 0, savingsCategoryId: 'sav' })),
    )
    // Never a bare line POST to the savings category.
    expect(mockPost).not.toHaveBeenCalledWith(expect.stringMatching(/\/budget\/categories\/.*\/items/), expect.anything())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByDisplayValue('Car', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('Add jar in a second Savings group sends that group, so the jar lands there (jar setup plan, PR 4)', { timeout: 15000 }, async () => {
    const month = budgetWithSavings(100)
    month.categories.push(budgetCategory({ id: 'trips', name: 'Trips', kind: 'Savings', displayOrder: 1, items: [] }))
    mockLoads({ month, accounts: [JOINT], jars: [HOLIDAY] })
    mockPost.mockResolvedValue({ data: { ...HOLIDAY, id: 'jar-rome', name: 'Rome' } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add a jar to Trips' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', { name: 'New jar' }, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Rome')
    await user.type(dialog.getByLabelText('Target amount'), '900')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-05-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name: 'Rome', savingsCategoryId: 'trips' })))
  })

  it('a Savings group still being saved offers Add jar only once it has its real id (#326 review P3-1)', { timeout: 15000 }, async () => {
    mockLoads({ month: budgetWithSavings(100), accounts: [JOINT], jars: [HOLIDAY] })
    let answerGroup: (v: unknown) => void = () => {}
    mockPost.mockImplementation((url: string) =>
      url === '/budget/categories'
        ? new Promise((r) => { answerGroup = r })
        : Promise.resolve({ data: { ...HOLIDAY, id: 'jar-rome', name: 'Rome' } }),
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add a group' }, { timeout: 5000 }))
    await user.type(await screen.findByLabelText('New category group name', {}, { timeout: 5000 }), 'Trips')
    await user.selectOptions(screen.getByLabelText('New group kind'), 'savings')
    await user.click(screen.getByRole('button', { name: 'Add category group' }))
    // The new group shows at once, with no Add jar while its POST is out.
    await screen.findByLabelText('Rename group Trips', {}, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Add a jar to Trips' })).not.toBeInTheDocument()

    const withTrips = budgetWithSavings(100)
    withTrips.categories.push(budgetCategory({ id: '11111111-1111-1111-1111-111111111111', name: 'Trips', kind: 'Savings', displayOrder: 1, items: [] }))
    answerGroup({ data: withTrips })
    await user.click(await screen.findByRole('button', { name: 'Add a jar to Trips' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', { name: 'New jar' }, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Rome')
    await user.type(dialog.getByLabelText('Target amount'), '900')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-05-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name: 'Rome', savingsCategoryId: '11111111-1111-1111-1111-111111111111' })),
    )
  })

  it('shows a savings line\'s Available as "Not available" when the server sends null', { timeout: 15000 }, async () => {
    mockLoads({ month: budgetWithSavings(null), accounts: [JOINT], jars: [{ ...HOLIDAY, currentBalance: null, status: 'Unavailable', plannedThisMonth: 0, remainingThisMonth: 0 }] })

    renderPage()

    await screen.findByDisplayValue('Holiday', {}, { timeout: 5000 })
    // The line keeps the savings layout (avail. column) and says so, never €0.00.
    const row = screen.getByDisplayValue('Holiday').closest('.group') as HTMLElement
    expect(within(row).getByText('Not available')).toBeInTheDocument()
    expect(within(row).getByText('avail.')).toBeInTheDocument()
  })

  it('first-run checklist: nothing set up → three open steps, jar step disabled until an account exists', { timeout: 15000 }, async () => {
    mockLoads({ month: null, accounts: [], jars: [] })

    renderPage()

    const card = within(await screen.findByRole('region', { name: 'Set up your budget' }, { timeout: 5000 }))
    expect(card.getByText('Add your accounts with their opening balances')).toBeInTheDocument()
    expect(card.getByText("Create this month's budget")).toBeInTheDocument()
    expect(card.getByText('Add a jar from an account')).toBeInTheDocument()
    expect(card.getAllByText('(to do)')).toHaveLength(3)
    expect(card.getByRole('link', { name: 'Go to accounts' })).toHaveAttribute('href', '/accounts')
    expect(card.getByRole('button', { name: "Create this month's budget" })).toBeEnabled()
    // No account yet ⇒ a jar can't be created (rule 73).
    expect(card.getByRole('button', { name: 'Add a jar from an account' })).toBeDisabled()
  })

  it('first-run checklist: accounts + month done leaves only the jar step, whose button opens the jar form', { timeout: 15000 }, async () => {
    mockLoads({ month: budget(), accounts: [JOINT], jars: [] })
    const user = userEvent.setup()

    renderPage()

    const card = within(await screen.findByRole('region', { name: 'Set up your budget' }, { timeout: 5000 }))
    expect(card.getByText('Add your accounts with their opening balances').closest('li')!.textContent).toContain('(done)')
    expect(card.getByText("Create this month's budget").closest('li')!.textContent).toContain('(done)')
    expect(card.getByText('Add a jar from an account').closest('li')!.textContent).toContain('(to do)')
    // Done steps carry no action; the open one does.
    expect(card.queryByRole('link', { name: 'Go to accounts' })).not.toBeInTheDocument()
    const addJar = card.getByRole('button', { name: 'Add a jar from an account' })
    expect(addJar).toBeEnabled()
    await user.click(addJar)
    const dialog = within(await screen.findByRole('dialog', { name: 'New jar' }, { timeout: 5000 }))
    // Not from a group: the line goes in the first Savings group, so no group is sent.
    mockPost.mockResolvedValue({ data: { ...HOLIDAY, id: 'jar-pot', name: 'Pot' } })
    await user.type(dialog.getByLabelText('Jar name'), 'Pot')
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    await user.type(dialog.getByLabelText('Each month'), '50')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name: 'Pot' })))
    expect(mockPost.mock.calls.find(([url]) => url === '/jars')![1]).not.toHaveProperty('savingsCategoryId')
  })

  it('first-run checklist: hidden once accounts, the month and a jar all exist', { timeout: 15000 }, async () => {
    mockLoads({ month: budgetWithSavings(100), accounts: [JOINT], jars: [HOLIDAY] })

    renderPage()

    await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })
    expect(screen.queryByRole('region', { name: 'Set up your budget' })).not.toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).not.toBeInTheDocument()
  })

  it('first-run checklist: not shown to a read-only member', { timeout: 15000 }, async () => {
    mockLoads({ month: null, accounts: [], jars: [] })
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { userId: 'u1', email: 'r@x.com', displayName: 'R', role: 3, ownerId: 'o1', memberId: null } })
      if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts' || url === '/jars') return Promise.resolve({ data: [] })
      return Promise.reject({ response: { status: 404 } })
    })

    renderPage()

    expect(await screen.findByText(/Ask an admin or the owner to set this month up/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).not.toBeInTheDocument()
  })
})

describe('DashboardPage month navigation', () => {
  beforeEach(() => {
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
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
    await user.click(screen.getByRole('button', { name: /^Copy / }))

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

  function sharedHousehold() {
    return {
      members: [
        { id: 'mem-alex', name: 'Alex', netMonthlyIncome: 3000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.6 },
        { id: 'mem-robin', name: 'Robin', netMonthlyIncome: 2000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.4 },
      ],
      isShared: true,
      loading: false,
      refreshHousehold: async () => {},
    }
  }

  it('hides the income member picker for solo households', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )

    renderPage()

    await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Who earns Take-home Pay')).not.toBeInTheDocument()
  })

  it('attributes an income line to a person and rolls back on failure', { timeout: 15000 }, async () => {
    household.current = sharedHousehold()
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: budget() }),
    )
    mockPut.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    // Shared household: every income line offers the picker; expense lines never do.
    const picker = await screen.findByLabelText('Who earns Take-home Pay', {}, { timeout: 5000 })
    expect(screen.queryByLabelText('Who earns Rent')).not.toBeInTheDocument()

    await user.selectOptions(picker, 'mem-alex')
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/budget/items/i-pay/member', { memberId: 'mem-alex' }),
    )

    // A failing PUT reverts the optimistic pick (back to the last saved value) and
    // surfaces the error.
    mockPut.mockRejectedValue(new Error('network'))
    await user.selectOptions(screen.getByLabelText('Who earns Take-home Pay'), 'mem-robin')
    expect(await screen.findByText(/Could not update who earns that income — reverted\./, {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Who earns Take-home Pay')).toHaveValue('mem-alex'))
  })
})

describe('DashboardPage edit conflicts (D11)', () => {
  beforeEach(() => {
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })

  // The month as read with the Rent line at `version`, planned at `rent`.
  const versioned = (version: string, rent: number): BudgetMonthDto =>
    budgetMonth({
      key: '2026-06',
      month: 6,
      categories: [
        budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
        budgetCategory({ id: 'c1', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: rent, version })] }),
      ],
    })

  async function editRent(user: ReturnType<typeof userEvent.setup>, amount: string) {
    await user.click(await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 })) as HTMLInputElement
    await user.clear(input)
    await user.type(input, amount)
    await user.tab()
  }

  it('a line save sends the version it was loaded at, and the next one the version the save answered', { timeout: 20000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: versioned('v1', 1100) }),
    )
    mockPut.mockResolvedValueOnce({ data: versioned('v2', 1200) }).mockResolvedValueOnce({ data: versioned('v3', 1300) })
    const user = userEvent.setup()
    renderPage()

    await editRent(user, '1200')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 1200, version: 'v1' }))
    // The user's own save moved the version: their next edit is not taken for someone else's.
    await editRent(user, '1300')
    await waitFor(() => expect(mockPut).toHaveBeenLastCalledWith('/budget/items/i-rent', { plannedAmount: 1300, version: 'v2' }))
  })

  it('a second edit made while the first is still saving waits for it and sends the version it answered', { timeout: 20000 }, async () => {
    // #308 review P2-2: the line stays editable while it saves; the correction must not read as
    // someone else's change.
    mockGet.mockImplementation((url: string) =>
      url === '/budget/months' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: versioned('v1', 1100) }),
    )
    let answerFirst: (v: unknown) => void = () => {}
    mockPut
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
      .mockResolvedValueOnce({ data: versioned('v3', 1250) })
    const user = userEvent.setup()
    renderPage()

    await editRent(user, '1200')
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1))
    // Corrected before the first answer arrives: the line is still editable ...
    await editRent(user, '1250')
    expect(screen.getByLabelText('Planned amount for Rent')).toHaveTextContent('1,250.00')
    // ... and the correction waits for that answer rather than going out with the same version.
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockPut.mock.calls[0][1]).toEqual({ plannedAmount: 1200, version: 'v1' })

    answerFirst({ data: versioned('v2', 1200) })
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(2))
    expect(mockPut.mock.calls[1]).toEqual(['/budget/items/i-rent', { plannedAmount: 1250, version: 'v2' }])
    await waitFor(() => expect(screen.getByLabelText('Planned amount for Rent')).toHaveTextContent('1,250.00'))
    expect(screen.queryByText('Someone else changed this. Reload and try again.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument()
  })

  it('a 409 on a line save says someone else changed it and re-reads the month', { timeout: 20000 }, async () => {
    let reads = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [] })
      if (url.startsWith('/budget/2')) reads++
      return Promise.resolve({ data: reads > 1 ? versioned('v9', 950) : versioned('v1', 1100) })
    })
    mockPut.mockRejectedValueOnce(
      Object.assign(new Error('409'), { response: { status: 409, data: { title: 'Someone else changed this. Reload and try again.' } } }),
    )
    const user = userEvent.setup()
    renderPage()

    await editRent(user, '1200')
    expect(await screen.findByText('Someone else changed this. Reload and try again.', {}, { timeout: 5000 })).toBeInTheDocument()
    // The grid shows what the other login saved, not the rolled-back value.
    await waitFor(() => expect(screen.getByLabelText('Planned amount for Rent')).toHaveTextContent('950.00'), { timeout: 5000 })
  })
})
