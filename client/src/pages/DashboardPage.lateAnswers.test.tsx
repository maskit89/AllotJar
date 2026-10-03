import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BudgetMonthDto, BudgetTemplateDto, JarScheduleDto } from '../types'

// The Dashboard's late-answer guards (#276), one test per guarded site (DASH-082). Every handler
// that awaits the API belongs to the month it was made on: when its answer (a create, a re-read,
// a reconcile from the server or the rollback to its snapshot) lands after the user changed
// month, it must not paint that month's grid under the month now viewed. Each test starts the
// action on the current month with the request held open, goes to the previous month, then
// answers (or fails) the request and checks the previous month's grid is untouched. The month
// create and "plan it again" guards are DASH-081 in DashboardPage.jars.test.tsx.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

const household = vi.hoisted(() => ({
  current: { members: [] as unknown[], isShared: false, loading: false, refreshHousehold: async () => {} },
}))
vi.mock('../features/HouseholdContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/HouseholdContext')>()),
  useHousehold: () => household.current,
}))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'
import { jar } from '../test/fixtures/jars'
import { DashboardPage } from './DashboardPage'
import { useMonth } from '../features/MonthContext'
import { setMoneyFormat } from '../lib/money'

// The viewed month is the app's current month (MonthProvider's default); the previous month is
// the one the user moves to while a request is in flight.
const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1
const PREV = MONTH === 1 ? { year: YEAR - 1, month: 12 } : { year: YEAR, month: MONTH - 1 }

// The two months share their shape (so every control exists on both) but not their figures:
// Rent is 1,100 this month and 900 last month, which is what each test tells them apart by.
function monthDto(year: number, month: number, figures: { rent: number; utilities: number; groceries: number; holiday: number }, id: string): BudgetMonthDto {
  return budgetMonth({
    id,
    year,
    month,
    categories: [
      budgetCategory({
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0,
        items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000, actualAmount: 3000 })],
      }),
      budgetCategory({
        id: 'c-house', name: 'Housing', kind: 'Expense', displayOrder: 0,
        items: [
          budgetItem({ id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: figures.rent }),
          budgetItem({ id: 'i-util', name: 'Utilities', displayOrder: 1, plannedAmount: figures.utilities, dueDay: 10 }),
        ],
      }),
      budgetCategory({
        id: 'c-food', name: 'Food', kind: 'Expense', displayOrder: 1,
        items: [budgetItem({ id: 'i-groc', name: 'Groceries', plannedAmount: figures.groceries })],
      }),
      budgetCategory({
        id: 'c-sav', name: 'Savings', kind: 'Savings', displayOrder: 2,
        items: [budgetItem({ id: 'i-holiday', name: 'Holiday', plannedAmount: figures.holiday, savingsId: 'jar-holiday', savingsAvailable: 450 })],
      }),
    ],
  })
}
const currentMonth = () => monthDto(YEAR, MONTH, { rent: 1100, utilities: 200, groceries: 400, holiday: 150 }, 'm1')
const previousMonth = () => monthDto(PREV.year, PREV.month, { rent: 900, utilities: 150, groceries: 300, holiday: 100 }, 'm0')

const holidayJar = () => jar({ id: 'jar-holiday', name: 'Holiday', targetAmount: 1200, currentBalance: 450, plannedThisMonth: 150, remainingThisMonth: 150 })

// What the server says skipping this month does (the remove-line dialog's preview).
const preview = (): JarScheduleDto => ({
  accrual: 1, isOngoing: false, hasSchedule: true, balance: 450, remaining: 450,
  months: [
    { year: YEAR, month: MONTH, planned: 0, hasBudget: true, shortfall: null, skipped: true },
    { year: 2099, month: 1, planned: 150, hasBudget: false, shortfall: null, skipped: false },
  ],
  total: 450, unplanned: 0, deadline: '2099-03-01', fundingCompletesOn: '2099-02-28', estimatedMonths: null,
})

const template: BudgetTemplateDto = {
  key: 'essentials',
  name: 'Essentials',
  description: 'A clean start.',
  groups: [{ name: 'Housing', kind: 'Expense', lines: ['Rent'] }],
}

type Answer = () => Promise<{ data: BudgetMonthDto }>
function mockNavigation({
  current = (() => Promise.resolve({ data: currentMonth() })) as Answer,
  templates = [] as BudgetTemplateDto[],
} = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months' || url === '/accounts') return Promise.resolve({ data: [] })
    if (url === '/budget/templates') return Promise.resolve({ data: templates })
    if (url === '/auth/me') return Promise.resolve({ data: {} })
    if (url === '/jars') return Promise.resolve({ data: [holidayJar()] })
    if (url === '/budget/items/i-holiday/skip-preview') return Promise.resolve({ data: preview() })
    if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: previousMonth() })
    if (url === `/budget/${YEAR}/${MONTH}`) return current()
    return Promise.reject({ response: { status: 404 } })
  })
}

// A request held open until the test answers it, one way or the other.
function held<T>() {
  let release: (value: T) => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}
type MonthAnswer = { data: BudgetMonthDto }

function Nav() {
  const { goToMonth } = useMonth()
  return <button onClick={() => goToMonth(PREV.year, PREV.month)}>go-prev</button>
}

function renderWithNav() {
  return renderWithProviders(
    <>
      <Nav />
      <DashboardPage />
    </>,
    { month: true },
  )
}

const rentPlanned = () => screen.getByLabelText('Planned amount for Rent')

// The current month's grid is on screen.
async function currentMonthShown() {
  await waitFor(() => expect(rentPlanned()).toHaveTextContent('€1,100.00'), { timeout: 5000 })
}

// Go to the previous month and wait for its grid.
async function goToPreviousMonth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('go-prev'))
  await waitFor(() => expect(rentPlanned()).toHaveTextContent('€900.00'), { timeout: 5000 })
}

// Let the answered request's continuation run, then check the previous month's grid is still its own.
async function expectPreviousMonthUntouched() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  expect(rentPlanned()).toHaveTextContent('€900.00')
  expect(rentPlanned()).not.toHaveTextContent('1,100')
  expect(screen.queryByText(/No budget for/)).toBeNull()
}

describe('DashboardPage — an answer that lands after the user changed month leaves the viewed grid alone (#276)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })

  // ---- refreshMonth: the re-read after a jar is archived from a line -------------------------

  it('DASH-082: refreshMonth, a re-read answered after the user moved on does not repaint the grid', { timeout: 15000 }, async () => {
    let slow = false
    const refresh = held<MonthAnswer>()
    mockNavigation({ current: () => (slow ? refresh.promise : Promise.resolve({ data: currentMonth() })) })
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Remove Holiday this month'))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Archive Holiday'))
    slow = true
    await user.click(dialog.getByLabelText('Confirm archive Holiday'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/jars/jar-holiday/archive', { archived: true }))
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === `/budget/${YEAR}/${MONTH}`).length).toBe(2))

    await goToPreviousMonth(user)
    await act(async () => { refresh.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: refreshMonth, a re-read that finds no month after the user moved on does not say the viewed month is missing', { timeout: 15000 }, async () => {
    let slow = false
    const refresh = held<MonthAnswer>()
    mockNavigation({ current: () => (slow ? refresh.promise : Promise.resolve({ data: currentMonth() })) })
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Remove Holiday this month'))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Archive Holiday'))
    slow = true
    await user.click(dialog.getByLabelText('Confirm archive Holiday'))
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === `/budget/${YEAR}/${MONTH}`).length).toBe(2))

    await goToPreviousMonth(user)
    await act(async () => { refresh.fail({ response: { status: 404 } }) })

    await expectPreviousMonthUntouched()
    expect(screen.queryByText(/No budget for/)).toBeNull()
  })

  // ---- createFromTemplate ---------------------------------------------------------------------

  it('DASH-082: createFromTemplate, a month created from a template after the user moved on', { timeout: 15000 }, async () => {
    mockNavigation({ current: () => Promise.reject({ response: { status: 404 } }), templates: [template] })
    const create = held<MonthAnswer>()
    mockPost.mockReturnValue(create.promise)
    const user = userEvent.setup()
    renderWithNav()

    await user.click(await screen.findByLabelText('Start from the Essentials template', {}, { timeout: 5000 }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { create.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  // ---- Rollbacks of the optimistic line edits -------------------------------------------------

  it('DASH-082: commitItem, a planned amount whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    // The amount commits on blur, so clicking the month button both saves and changes month.
    await user.click(rentPlanned())
    const input = (await screen.findByLabelText('Planned amount for Rent')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '1200')
    await goToPreviousMonth(user)
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 1200, version: null }))

    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: setItemMember, an attribution whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    household.current = {
      members: [{ id: 'mem-alex', name: 'Alex', netMonthlyIncome: 3000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1 }],
      isShared: true,
      loading: false,
      refreshHousehold: async () => {},
    }
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.selectOptions(screen.getByLabelText('Who earns Take-home Pay'), 'mem-alex')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-pay/member', { memberId: 'mem-alex' }))

    await goToPreviousMonth(user)
    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: setBill, a due day whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Add a due date to Rent'))
    await user.type(screen.getByLabelText('Due day for Rent'), '15')
    await user.click(screen.getByLabelText('Save due day for Rent'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent/bill', { dueDay: 15 }))

    await goToPreviousMonth(user)
    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: setPaid, a paid mark whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByRole('button', { name: 'Mark Utilities paid' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-util/paid', { isPaid: true }))

    await goToPreviousMonth(user)
    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: renameItem, a rename whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    // The name commits on blur: the click on the month button both renames and changes month.
    await user.type(screen.getByLabelText('Rename Rent'), 'al')
    await goToPreviousMonth(user)
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 1100, name: 'Rental', version: null }))

    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- addItem: the reconcile from the server and the rollback ------------------------------

  it('DASH-082: addItem, a line added whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const add = held<MonthAnswer>()
    mockPost.mockReturnValue(add.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Add a line to Housing'))
    await user.type(screen.getByLabelText('Add a line to Housing'), 'Fuel{Enter}')
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/budget/categories/c-house/items', { name: 'Fuel', plannedAmount: 0 }))

    await goToPreviousMonth(user)
    await act(async () => { add.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
    expect(screen.queryByLabelText('Rename Fuel')).toBeNull()
  })

  it('DASH-082: addItem, a line added whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const add = held<MonthAnswer>()
    mockPost.mockReturnValue(add.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Add a line to Housing'))
    await user.type(screen.getByLabelText('Add a line to Housing'), 'Fuel{Enter}')
    await waitFor(() => expect(mockPost).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { add.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- deleteItem: the reconcile from the server and the rollback ---------------------------

  it('DASH-082: deleteItem, a line deleted whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const del = held<MonthAnswer>()
    mockDelete.mockReturnValue(del.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Delete Groceries'))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/budget/items/i-groc'))

    await goToPreviousMonth(user)
    await act(async () => { del.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: deleteItem, a line deleted whose request fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const del = held<MonthAnswer>()
    mockDelete.mockReturnValue(del.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Delete Groceries'))
    await waitFor(() => expect(mockDelete).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { del.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- onJarLineSkipped: the month the skip dialog returns ----------------------------------

  it('DASH-082: onJarLineSkipped, a skip answered after the user moved on does not paint its month under the viewed one', { timeout: 15000 }, async () => {
    mockNavigation()
    const skip = held<MonthAnswer>()
    mockPut.mockReturnValue(skip.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Remove Holiday this month'))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(await dialog.findByLabelText('Skip Holiday this month', {}, { timeout: 5000 }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday/skip', { skipped: true }))

    await goToPreviousMonth(user)
    const skipped = currentMonth()
    skipped.categories[3].items[0] = { ...skipped.categories[3].items[0], plannedAmount: 0, remaining: 0, isSkipped: true }
    await act(async () => { skip.release({ data: skipped }) })

    await expectPreviousMonthUntouched()
    expect(screen.queryByText('Skipped')).toBeNull()
  })

  it('DASH-082: the skip-or-archive dialog closes when the user changes month, so it never offers the old month\u2019s line', { timeout: 15000 }, async () => {
    mockNavigation()
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Remove Holiday this month'))
    await screen.findByRole('dialog', {}, { timeout: 5000 })

    await goToPreviousMonth(user)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // ---- addCategory: the reconcile from the server and the rollback --------------------------

  it('DASH-082: addCategory, a group added whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const add = held<MonthAnswer>()
    mockPost.mockReturnValue(add.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByRole('button', { name: 'Add a group' }))
    await user.type(screen.getByLabelText('New category group name'), 'Subscriptions')
    await user.click(screen.getByRole('button', { name: 'Add category group' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/budget/categories', { budgetMonthId: 'm1', name: 'Subscriptions', isSavings: false }))

    await goToPreviousMonth(user)
    await act(async () => { add.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: addCategory, a group added whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const add = held<MonthAnswer>()
    mockPost.mockReturnValue(add.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByRole('button', { name: 'Add a group' }))
    await user.type(screen.getByLabelText('New category group name'), 'Subscriptions')
    await user.click(screen.getByRole('button', { name: 'Add category group' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { add.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
    expect(screen.queryByLabelText('Rename group Subscriptions')).toBeNull()
  })

  // ---- renameCategory rollback ----------------------------------------------------------------

  it('DASH-082: renameCategory, a group rename whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const save = held<{ data: object }>()
    mockPut.mockReturnValue(save.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    // The group name commits on blur: the click on the month button both renames and changes month.
    await user.type(screen.getByLabelText('Rename group Housing'), ' costs')
    await goToPreviousMonth(user)
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/categories/c-house', { name: 'Housing costs', version: null }))

    await act(async () => { save.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- deleteCategory: the reconcile from the server and the rollback -----------------------

  it('DASH-082: deleteCategory, a group deleted whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const del = held<MonthAnswer>()
    mockDelete.mockReturnValue(del.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Delete group Food'))
    await user.click(screen.getByLabelText('Confirm delete Food'))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/budget/categories/c-food'))

    await goToPreviousMonth(user)
    await act(async () => { del.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: deleteCategory, a group deleted whose request fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const del = held<MonthAnswer>()
    mockDelete.mockReturnValue(del.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Delete group Food'))
    await user.click(screen.getByLabelText('Confirm delete Food'))
    await waitFor(() => expect(mockDelete).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { del.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- moveCategory: the reconcile from the server and the rollback -------------------------

  it('DASH-082: moveCategory, a group move whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const move = held<MonthAnswer>()
    mockPut.mockReturnValue(move.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Move Food up'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/categories/order', { budgetMonthId: 'm1', orderedCategoryIds: ['c-food', 'c-house'] }))

    await goToPreviousMonth(user)
    await act(async () => { move.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: moveCategory, a group move whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const move = held<MonthAnswer>()
    mockPut.mockReturnValue(move.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Move Food up'))
    await waitFor(() => expect(mockPut).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { move.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })

  // ---- reorderItems: the reconcile from the server and the rollback -------------------------

  it('DASH-082: reorderItems, a line move whose answer lands after the user moved on is not reconciled into the viewed month', { timeout: 15000 }, async () => {
    mockNavigation()
    const move = held<MonthAnswer>()
    mockPut.mockReturnValue(move.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Move Utilities up'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/categories/c-house/items/order', { orderedItemIds: ['i-util', 'i-rent'] }))

    await goToPreviousMonth(user)
    await act(async () => { move.release({ data: currentMonth() }) })

    await expectPreviousMonthUntouched()
  })

  it('DASH-082: reorderItems, a line move whose save fails after the user moved on rolls nothing back', { timeout: 15000 }, async () => {
    mockNavigation()
    const move = held<MonthAnswer>()
    mockPut.mockReturnValue(move.promise)
    const user = userEvent.setup()
    renderWithNav()
    await currentMonthShown()

    await user.click(screen.getByLabelText('Move Utilities up'))
    await waitFor(() => expect(mockPut).toHaveBeenCalled())

    await goToPreviousMonth(user)
    await act(async () => { move.fail(new Error('network')) })

    await expectPreviousMonthUntouched()
  })
})
