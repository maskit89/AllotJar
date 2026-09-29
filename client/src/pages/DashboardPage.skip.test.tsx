import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetMonthDto, JarScheduleDto } from '../types'

// W04 — a jar's contribution line on the Budget page (rules 60–61): the ✕ opens the
// skip-or-archive choice with the server's preview of the later months (BUDG-034, BUDG-059),
// skipping keeps the line at €0 with a Skipped tag and Plan it again (BUDG-060), archiving from
// the same dialog (BUDG-061), and a past month offers neither (BUDG-062).
const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

const household = vi.hoisted(() => ({
  current: { members: [] as unknown[], isShared: false, loading: false, refreshHousehold: async () => {} },
}))
vi.mock('../features/HouseholdContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/HouseholdContext')>()),
  useHousehold: () => household.current,
}))

import { DashboardPage } from './DashboardPage'
import { AuthProvider } from '../auth/AuthContext'
import { MonthProvider } from '../features/MonthContext'
import { setMoneyFormat } from '../lib/money'

// The viewed month is the app's current month (MonthProvider's default); the fixture is
// keyed to it so the Savings group renders for "this month".
const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1

// Income 3,000; one Savings group with the Holiday jar's line: 150 planned, nothing in yet.
function month(over: { planned?: number; isSkipped?: boolean } = {}): BudgetMonthDto {
  const planned = over.planned ?? 150
  return {
    id: 'm1',
    key: `${YEAR}-${String(MONTH).padStart(2, '0')}`,
    year: YEAR,
    month: MONTH,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: planned,
    remainingToBudget: 3000 - planned,
    isBalanced: false,
    categories: [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 3000, totalActual: 3000,
        items: [{ id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 3000, remaining: 0 }],
      },
      {
        id: 'c-sav', name: 'Savings', kind: 'Savings', displayOrder: 0, totalPlanned: planned, totalActual: 0,
        items: [
          {
            id: 'i-holiday', name: 'Holiday', displayOrder: 0, plannedAmount: planned, actualAmount: 0, remaining: planned,
            savingsId: 'jar-holiday', savingsAvailable: 450, isSkipped: over.isSkipped ?? false,
          },
        ],
      },
    ],
  }
}

// What the server says skipping this month does: the 150 is spread over the two months left.
function preview(over: Partial<JarScheduleDto> = {}): JarScheduleDto {
  return {
    accrual: 1,
    isOngoing: false,
    hasSchedule: true,
    balance: 450,
    remaining: 450,
    months: [
      { year: YEAR, month: MONTH, planned: 0, hasBudget: true, shortfall: null, skipped: true },
      { year: 2099, month: 1, planned: 225, hasBudget: false, shortfall: null, skipped: false },
      { year: 2099, month: 2, planned: 225, hasBudget: false, shortfall: null, skipped: false },
    ],
    total: 450,
    unplanned: 0,
    deadline: '2099-03-01',
    fundingCompletesOn: '2099-02-28',
    estimatedMonths: null,
    ...over,
  }
}

function mockLoads(data: BudgetMonthDto, skipPreview: JarScheduleDto | { reject: unknown } = preview()) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months' || url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
    if (url === '/budget/items/i-holiday/skip-preview') {
      return 'reject' in skipPreview ? Promise.reject(skipPreview.reject) : Promise.resolve({ data: skipPreview })
    }
    if (url === '/auth/me') return Promise.resolve({ data: {} })
    return Promise.resolve({ data })
  })
}

function renderPage(today?: Date) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MonthProvider>{today ? <DashboardPage today={today} /> : <DashboardPage />}</MonthProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DashboardPage — skipping a jar contribution (W04)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })

  it('BUDG-034: the ✕ on a jar line opens the skip-or-archive choice instead of deleting, with the server\'s preview', { timeout: 15000 }, async () => {
    mockLoads(month())
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Remove Holiday this month', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByText(/^Remove Holiday from .+\?$/)).toBeInTheDocument()
    expect(dialog.getByText(/can’t just be deleted: the jar’s plan would put it back/)).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledWith('/budget/items/i-holiday/skip-preview')
    // The later months, as the server will replant them (rule 61).
    expect(await dialog.findByText(/spreads this month’s €150\.00 over the months that are left/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(dialog.getAllByText('€225.00')).toHaveLength(2)
    expect(dialog.getByLabelText('Skip Holiday this month')).toBeEnabled()
    expect(dialog.getByLabelText('Archive Holiday')).toBeInTheDocument()
    // Nothing was deleted or changed by opening the dialog.
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('BUDG-059: skipping the last plannable month warns what stays unplanned', { timeout: 15000 }, async () => {
    mockLoads(month(), preview({ months: [{ year: YEAR, month: MONTH, planned: 0, hasBudget: true, shortfall: null, skipped: true }], unplanned: 150 }))
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Remove Holiday this month', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(await dialog.findByText(/leaves €150\.00 unplanned: no month is left to spread it over before the deadline/, {}, { timeout: 5000 })).toBeInTheDocument()
    // Allowed all the same (the user decides): the button stays enabled.
    expect(dialog.getByLabelText('Skip Holiday this month')).toBeEnabled()
  })

  it('BUDG-060: Skip this month puts the skip, shows the line at €0 with a Skipped tag, and Plan it again restores it', { timeout: 15000 }, async () => {
    mockLoads(month())
    mockPut.mockImplementation((url: string, body: { skipped: boolean }) =>
      Promise.resolve({ data: body.skipped ? month({ planned: 0, isSkipped: true }) : month() }),
    )
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Remove Holiday this month', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(await dialog.findByLabelText('Skip Holiday this month', {}, { timeout: 5000 }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday/skip', { skipped: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The line stays in the month at €0, marked as skipped (rule 60) — it is never removed.
    expect(await screen.findByText('Skipped', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByLabelText('Planned amount for Holiday')).toHaveTextContent('€0.00')
    // The jars shelf is re-read so its figures follow the replant.
    expect(mockGet.mock.calls.filter(([url]) => url === '/jars').length).toBeGreaterThanOrEqual(2)

    await user.click(screen.getByLabelText('Plan Holiday again this month'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday/skip', { skipped: false }))
    await waitFor(() => expect(screen.queryByText('Skipped')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Planned amount for Holiday')).toHaveTextContent('€150.00')
  })

  it('BUDG-061: Archive the jar from the same dialog takes two clicks, archives it and re-reads the month; a refusal is shown in the server\'s words', { timeout: 15000 }, async () => {
    mockLoads(month())
    mockPut.mockRejectedValueOnce({ response: { status: 400, data: { errors: { Id: ['Holiday still holds €450.00. Move the money out before archiving it.'] } } } })
    mockPut.mockResolvedValueOnce({ data: {} })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Remove Holiday this month', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Archive Holiday'))
    expect(mockPut).not.toHaveBeenCalled()
    await user.click(dialog.getByLabelText('Confirm archive Holiday'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/jars/jar-holiday/archive', { archived: true }))
    expect(await dialog.findByText('Holiday still holds €450.00. Move the money out before archiving it.', {}, { timeout: 5000 })).toBeInTheDocument()

    // Second attempt (once the jar is empty) succeeds: the dialog closes and the month is re-read.
    const monthReads = mockGet.mock.calls.filter(([url]) => String(url).startsWith('/budget/') && !String(url).includes('items')).length
    await user.click(dialog.getByLabelText('Confirm archive Holiday'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(mockGet.mock.calls.filter(([url]) => String(url).startsWith('/budget/') && !String(url).includes('items')).length).toBeGreaterThan(monthReads),
    )
  })

  it('BUDG-062: a past month\'s jar line offers neither ✕ nor Plan it again — its contributions are history', { timeout: 15000 }, async () => {
    mockLoads(month({ planned: 0, isSkipped: true }))

    // "Today" is a month after the viewed one, so the viewed month is over.
    renderPage(new Date(MONTH === 12 ? YEAR + 1 : YEAR, MONTH === 12 ? 0 : MONTH, 15))

    expect(await screen.findByTestId('planned-Holiday', {}, { timeout: 5000 })).toHaveTextContent('€0.00')
    // Its plan is read-only too: typing an amount would un-skip a finished month (rule 46).
    expect(screen.queryByLabelText('Planned amount for Holiday')).not.toBeInTheDocument()
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(screen.queryByLabelText('Remove Holiday this month')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Plan Holiday again this month')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Delete Holiday')).not.toBeInTheDocument()
  })
})
