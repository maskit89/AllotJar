import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BudgetMonthDto, JarDto, JarScheduleDto } from '../types'

// Restyle PR 3: a line's and a group's rarely used actions sit behind a ⋯ menu on wide screens and
// in a bottom sheet (opened from the line itself) on phones — the same list in both. These tests
// pin the paths a keyboard and a finger take to them, and which actions each role is offered.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

const household = vi.hoisted(() => ({
  current: { members: [] as unknown[], isShared: false, loading: false, refreshHousehold: async () => {} },
}))
vi.mock('../features/HouseholdContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/HouseholdContext')>()),
  useHousehold: () => household.current,
}))

import { mockGet, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { menuItems } from '../test/rowMenu'
import { DashboardPage } from './DashboardPage'
import { setMoneyFormat } from '../lib/money'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'
import { jar } from '../test/fixtures/jars'

const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1

// Income, Housing (Rent is a bill due on the 28th, Utilities is not a bill) and a Savings group
// holding the Holiday jar's line — the viewed month is the current one.
function month(): BudgetMonthDto {
  return budgetMonth({
    year: YEAR,
    month: MONTH,
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
      budgetCategory({
        id: 'c-house', name: 'Housing',
        items: [
          budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1100, dueDay: 28 }),
          budgetItem({ id: 'i-util', name: 'Utilities', displayOrder: 1, plannedAmount: 150 }),
        ],
      }),
      budgetCategory({
        id: 'c-sav', name: 'Savings', kind: 'Savings', displayOrder: 1,
        items: [budgetItem({ id: 'i-holiday', name: 'Holiday', plannedAmount: 150, savingsId: 'jar-holiday', savingsAvailable: 450, isSkipped: false })],
      }),
    ],
  })
}

const holiday = (): JarDto =>
  jar({ id: 'jar-holiday', name: 'Holiday', targetAmount: 1200, currentBalance: 450, plannedThisMonth: 150, remainingThisMonth: 150 })

// What the server says skipping Holiday this month does: the 150 moves to the month after.
const skipPreview = (): JarScheduleDto => ({
  accrual: 1, isOngoing: false, hasSchedule: true, balance: 450, remaining: 750,
  months: [
    { year: YEAR, month: MONTH, planned: 0, hasBudget: true, shortfall: null, skipped: true },
    { year: 2099, month: 1, planned: 300, hasBudget: false, shortfall: null, skipped: false },
  ],
  total: 750, unplanned: 0, deadline: '2099-02-01', fundingCompletesOn: '2099-01-31', estimatedMonths: null,
})

function mockLoads(role?: number, m: BudgetMonthDto = month(), jars: JarDto[] = [holiday()]) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/auth/me') {
      return Promise.resolve({
        data: role === undefined ? {} : { userId: 'u1', email: 'm@x.com', displayName: 'M', role, ownerId: 'o1', memberId: null },
      })
    }
    if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
    if (url === '/jars') return Promise.resolve({ data: jars })
    if (url === '/budget/items/i-holiday/skip-preview') return Promise.resolve({ data: skipPreview() })
    return Promise.resolve({ data: m })
  })
}

/** The month with two earners' lines of the same name, each attributed (the mock-up's data). */
function twoEarners(): BudgetMonthDto {
  const m = month()
  m.categories[0] = budgetCategory({
    id: 'inc', name: 'Income', kind: 'Income',
    items: [
      budgetItem({ id: 'i-alex', name: 'Take-home pay', plannedAmount: 2000, memberId: 'mem-alex' }),
      budgetItem({ id: 'i-sam', name: 'Take-home pay', displayOrder: 1, plannedAmount: 1400, memberId: 'mem-sam' }),
    ],
  })
  return m
}

const shared = () => ({
  members: [
    { id: 'mem-alex', name: 'Alex', netMonthlyIncome: 2000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.6 },
    { id: 'mem-sam', name: 'Sam', netMonthlyIncome: 1400, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.4 },
  ],
  isShared: true,
  loading: false,
  refreshHousehold: async () => {},
})

const renderPage = () => renderWithProviders(<DashboardPage />, { month: true })

/** Makes the phone media query (the 700px breakpoint) match, as on a phone. */
function asPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 699.98px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('DashboardPage row actions (restyle PR 3)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    resetApiMocks()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a line’s ⋯ opens from the keyboard, arrows move through it, Escape closes it and returns focus', { timeout: 15000 }, async () => {
    mockLoads()
    const user = userEvent.setup()
    renderPage()

    const more = await screen.findByRole('button', { name: 'Rent: more actions' }, { timeout: 5000 })
    more.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', {}, { timeout: 5000 })
    // The bill's actions, then its order, then the destructive one last.
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Edit amount', 'Rename', 'Bill due day', 'Mark paid', 'Move up', 'Move down', 'Delete',
    ])
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Edit amount' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(more).toHaveFocus()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('Edit amount from the keyboard opens the planned editor with focus in it; Escape leaves it unchanged', { timeout: 15000 }, async () => {
    mockLoads()
    const user = userEvent.setup()
    renderPage()

    const more = await screen.findByRole('button', { name: 'Utilities: more actions' }, { timeout: 5000 })
    more.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu', {}, { timeout: 5000 })
    await user.keyboard('{Enter}') // the first item, Edit amount

    const input = await screen.findByRole('textbox', { name: 'Planned amount for Utilities' }, { timeout: 5000 })
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: /^Planned amount for Utilities:/ })).toHaveTextContent('€150.00')
    expect(mockPut).not.toHaveBeenCalled()
    // Focus goes back to the ⋯ the editor was opened from, not to the page.
    await waitFor(() => expect(more).toHaveFocus())
  })

  it('an inline editor closed by Enter, Escape or a choice gives focus back to where it was opened', { timeout: 20000 }, async () => {
    household.current = shared()
    mockLoads(undefined, twoEarners())
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()

    // The amount opened from itself: Enter saves and focus returns to the amount.
    await user.click(await screen.findByRole('button', { name: /^Planned amount for Utilities:/ }, { timeout: 5000 }))
    const input = await screen.findByRole('textbox', { name: 'Planned amount for Utilities' })
    await user.clear(input)
    await user.type(input, '175{Enter}')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-util', { plannedAmount: 175, version: null }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Planned amount for Utilities:/ })).toHaveFocus())

    // The due day from the ⋯: Escape closes it and focus returns to the ⋯.
    const rentMore = screen.getByRole('button', { name: 'Rent: more actions' })
    await user.click(rentMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Bill due day' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Due day for Rent' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(rentMore).toHaveFocus())

    // Who earns from the ⋯: picking an earner saves and focus returns to the ⋯.
    await user.click(screen.getByRole('button', { name: 'Take-home pay (Sam): more actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Who earns' }))
    const picker = await screen.findAllByRole('combobox', { name: 'Who earns Take-home pay' })
    expect(picker).toHaveLength(1)
    await waitFor(() => expect(picker[0]).toHaveFocus())
    await user.selectOptions(picker[0], 'mem-alex')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-sam/member', { memberId: 'mem-alex' }))
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Take-home pay \(Alex\): more actions$/))

    // The group's add row: Escape closes it and focus returns to the group's ⋯.
    const groupMore = screen.getByRole('button', { name: 'Housing group: more actions' })
    await user.click(groupMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Add line' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add a line to Housing' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(groupMore).toHaveFocus())

    // The group's delete confirmation: Cancel (or Escape) returns focus to the group's ⋯.
    await user.click(groupMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel delete' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Housing group: more actions' })).toHaveFocus())
  })

  it('Rename from a line’s or a group’s ⋯: Enter saves, Escape drops the edit, and both give focus back to the ⋯', { timeout: 20000 }, async () => {
    mockLoads()
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()

    // A line: Rename puts focus in its name; Escape drops the edit without saving.
    const utilMore = await screen.findByRole('button', { name: 'Utilities: more actions' }, { timeout: 5000 })
    await user.click(utilMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const lineName = screen.getByRole('textbox', { name: 'Rename Utilities' })
    await waitFor(() => expect(lineName).toHaveFocus())
    await user.keyboard('Power{Escape}')
    await waitFor(() => expect(utilMore).toHaveFocus())
    expect(lineName).toHaveValue('Utilities')
    expect(mockPut).not.toHaveBeenCalled()

    // Enter saves the new name and focus returns to the ⋯, which stays closed.
    await user.click(utilMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    await waitFor(() => expect(lineName).toHaveFocus())
    await user.keyboard('Power{Enter}')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-util', { plannedAmount: 150, name: 'Power', version: null }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Power: more actions' })).toHaveFocus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // A group: the same, focus going back to the group's ⋯.
    mockPut.mockClear()
    const groupMore = screen.getByRole('button', { name: 'Housing group: more actions' })
    await user.click(groupMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const groupName = screen.getByRole('textbox', { name: 'Rename group Housing' })
    await waitFor(() => expect(groupName).toHaveFocus())
    await user.keyboard('Home{Escape}')
    await waitFor(() => expect(groupMore).toHaveFocus())
    expect(groupName).toHaveValue('Housing')
    expect(mockPut).not.toHaveBeenCalled()

    await user.click(groupMore)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    await waitFor(() => expect(groupName).toHaveFocus())
    await user.keyboard('Home{Enter}')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/categories/c-house', expect.objectContaining({ name: 'Home' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Home group: more actions' })).toHaveFocus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('a shared household’s same-named income lines are told apart by their earner', { timeout: 15000 }, async () => {
    household.current = shared()
    mockLoads(undefined, twoEarners())
    renderPage()

    expect(await screen.findByRole('button', { name: 'Take-home pay (Alex): more actions' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take-home pay (Sam): more actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Take-home pay: more actions' })).not.toBeInTheDocument()
    // Every ⋯ in the card has a name of its own.
    const names = screen.getAllByRole('button', { name: /more actions$/ }).map((b) => b.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(names.length)
  })

  it('on a phone, same-named income lines and their sheets carry the earner', { timeout: 15000 }, async () => {
    asPhone()
    household.current = shared()
    mockLoads(undefined, twoEarners())
    const user = userEvent.setup()
    renderPage()

    const sam = await screen.findByRole('button', { name: 'Take-home pay (Sam)' }, { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Take-home pay (Alex)' })).toBeInTheDocument()
    await user.click(sam)
    expect(await screen.findByRole('dialog', { name: 'Take-home pay · Sam' }, { timeout: 5000 })).toBeInTheDocument()
  })

  it('on a phone, the sheet’s editors give focus back to the line when they close', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads()
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Utilities' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Utilities' })).getByRole('button', { name: 'Edit amount' }))
    const input = await screen.findByRole('textbox', { name: 'Planned amount for Utilities' }, { timeout: 5000 })
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Utilities' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Utilities' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Utilities' })).getByRole('button', { name: 'Rename' }))
    const name = await screen.findByRole('textbox', { name: 'Rename Utilities' }, { timeout: 5000 })
    await waitFor(() => expect(name).toHaveFocus())
    await user.clear(name)
    await user.type(name, 'Power{Enter}')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-util', expect.objectContaining({ name: 'Power' })))
    await waitFor(() => expect(document.activeElement?.tagName).toBe('BUTTON'))
    expect(document.activeElement).toHaveAttribute('data-row-trigger')
  })

  it('on a phone a skipped jar line keeps its (i), above the line’s tap target', { timeout: 15000 }, async () => {
    asPhone()
    const m = month()
    m.categories[2].items[0] = { ...m.categories[2].items[0], plannedAmount: 0, isSkipped: true }
    mockLoads(undefined, m)
    const user = userEvent.setup()
    renderPage()

    const why = await screen.findByRole('button', { name: 'Why Holiday is skipped' }, { timeout: 5000 })
    await user.click(why)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('the rest of the plan was spread over the months that are left')
    // The (i) opened its hint, not the line's sheet.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a jar line whose month is in shows no bar or "to go"; one still to go shows both', { timeout: 15000 }, async () => {
    const m = month()
    m.categories[2].items.push(budgetItem({ id: 'i-car', name: 'Car', displayOrder: 1, plannedAmount: 50, savingsId: 'jar-car', savingsAvailable: 50, isSkipped: false }))
    const car = jar({ id: 'jar-car', name: 'Car', targetAmount: 600, currentBalance: 50, plannedThisMonth: 50, contributedThisMonth: 50, remainingThisMonth: 0 })
    mockLoads(undefined, m, [holiday(), car])
    renderPage()

    const carLine = (await screen.findByRole('button', { name: /^Planned amount for Car:/ }, { timeout: 5000 })).closest('.group') as HTMLElement
    expect(carLine.textContent).not.toContain('to go')
    // Read out all the same: what went in, of the plan.
    expect(within(carLine).getByText('€50.00 in of €50.00')).toHaveClass('sr-only')
    const holidayLine = screen.getByRole('button', { name: /^Planned amount for Holiday:/ }).closest('.group') as HTMLElement
    expect(within(holidayLine).getByText('€150.00 to go')).toBeInTheDocument()
  })

  it('a group’s ⋯ offers adding, renaming, moving and deleting; the ends are disabled', { timeout: 15000 }, async () => {
    mockLoads()
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Housing group: more actions' }, { timeout: 5000 })
    const items = await menuItems(user, 'Housing group: more actions')
    expect(items.map((i) => i.name)).toEqual(['Add line', 'Rename', 'Move up', 'Move down', 'Delete'])
    // Housing is the only spending group: it can move neither way.
    expect(items.find((i) => i.name === 'Move up')!.disabled).toBe(true)
    expect(items.find((i) => i.name === 'Move down')!.disabled).toBe(true)
  })

  it('on a phone a line is the button: it opens a sheet titled with its name holding the same actions', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads()
    const user = userEvent.setup()
    renderPage()

    const rent = await screen.findByRole('button', { name: 'Rent' }, { timeout: 5000 })
    // No ⋯ on a phone line, and the amount is not a button of its own.
    expect(screen.queryByRole('button', { name: 'Rent: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Planned amount for Rent:/ })).not.toBeInTheDocument()

    await user.click(rent)
    const sheet = await screen.findByRole('dialog', { name: 'Rent' }, { timeout: 5000 })
    expect(within(sheet).getByText('€1,100.00 planned · €0.00 spent')).toBeInTheDocument()
    expect(
      within(sheet)
        .getAllByRole('button')
        .map((b) => b.textContent)
        .filter((t) => t),
    ).toEqual(['Edit amount', 'Rename', 'Bill due day', 'Mark paid', 'Move up', 'Move down', 'Delete'])

    // Escape closes it and focus returns to the line.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(rent).toHaveFocus())
  })

  it('on a phone, Edit amount in the sheet opens the editor; Mark paid saves straight away', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads()
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Utilities' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Utilities' })).getByRole('button', { name: 'Edit amount' }))
    const input = await screen.findByRole('textbox', { name: 'Planned amount for Utilities' }, { timeout: 5000 })
    await waitFor(() => expect(input).toHaveFocus())
    await user.clear(input)
    await user.type(input, '175{Enter}')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-util', { plannedAmount: 175, version: null }))

    await user.click(screen.getByRole('button', { name: 'Rent' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Rent' })).getByRole('button', { name: 'Mark paid' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent/paid', { isPaid: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('on a phone a jar line’s sheet says what the jar holds and offers skipping it', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads()
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Holiday' }, { timeout: 5000 }))
    const sheet = await screen.findByRole('dialog', { name: 'Holiday' }, { timeout: 5000 })
    expect(within(sheet).getByText('€450.00 in the jar')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Skip this month' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Archive jar' })).toBeInTheDocument()

    // Skip opens the skip dialog (titled "Skip Holiday this month") once the sheet has closed.
    await user.click(within(sheet).getByRole('button', { name: 'Skip this month' }))
    const skip = await screen.findByRole('dialog', { name: 'Skip Holiday this month' }, { timeout: 5000 })
    expect(within(skip).getByRole('button', { name: 'Skip this month' })).toBeInTheDocument()
  })

  it('Limited access: a bill line’s ⋯ offers only Mark paid; nothing else in the budget is editable', { timeout: 15000 }, async () => {
    mockLoads(2) // Limited
    const user = userEvent.setup()
    renderPage()

    const more = await screen.findByRole('button', { name: 'Rent: more actions' }, { timeout: 5000 })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add a group' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Utilities: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Holiday: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /group: more actions$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Planned amount for Rent:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Rename Rent' })).not.toBeInTheDocument()

    await user.click(more)
    const menu = await screen.findByRole('menu', {}, { timeout: 5000 })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Mark paid'])
  })

  it('read-only access: no ⋯ anywhere, no editors, no Add a group', { timeout: 15000 }, async () => {
    mockLoads(3) // ReadOnly
    renderPage()

    expect(await screen.findByTestId('planned-Rent', {}, { timeout: 5000 })).toHaveTextContent('€1,100.00')
    expect(screen.queryAllByRole('button', { name: /more actions$/ })).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Add a group' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
