import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, BudgetMonthDto, JarDto } from '../types'

// W05 — the "Your jars" shelf is the viewed month's view of the jars (rule 48): it is read for
// that month (DASH-028), says which date a past month's balances are as of (DASH-073), reads
// today's balances for a month that has not begun (DASH-074), and is re-read when a jar line's
// planned amount is edited or the month is created (DASH-075, J6's staleness), and never shows
// one month's balances under another month's grid while its read is in flight (DASH-076), nor
// the first-run checklist's "add a jar" step to a household with jars (DASH-077).
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
import { MonthProvider, useMonth } from '../features/MonthContext'
import { setMoneyFormat } from '../lib/money'
import { formatDate } from '../lib/dates'

// The viewed month is the app's current month (MonthProvider's default); "today" is moved
// around it to make the viewed month current, over, or not yet begun.
const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1
const LAST_DAY = new Date(YEAR, MONTH, 0).getDate()
const ISO = (d: number) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const nextMonth = new Date(MONTH === 12 ? YEAR + 1 : YEAR, MONTH === 12 ? 0 : MONTH, 15)
const previousMonth = new Date(MONTH === 1 ? YEAR - 1 : YEAR, MONTH === 1 ? 11 : MONTH - 2, 15)

function month(over: { planned?: number } = {}): BudgetMonthDto {
  const planned = over.planned ?? 150
  return {
    id: 'm1',
    key: `${YEAR}-${String(MONTH).padStart(2, '0')}`,
    year: YEAR,
    month: MONTH,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: planned + 1100,
    remainingToBudget: 3000 - planned - 1100,
    isBalanced: false,
    categories: [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 3000, totalActual: 3000,
        items: [{ id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 3000, remaining: 0 }],
      },
      {
        id: 'c-house', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 1100, totalActual: 0,
        items: [{ id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 0, remaining: 1100 }],
      },
      {
        id: 'c-sav', name: 'Savings', kind: 'Savings', displayOrder: 1, totalPlanned: planned, totalActual: 0,
        items: [
          {
            id: 'i-holiday', name: 'Holiday', displayOrder: 0, plannedAmount: planned, actualAmount: 0, remaining: planned,
            savingsId: 'jar-holiday', savingsAvailable: 450, isSkipped: false,
          },
        ],
      },
    ],
  }
}

function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'jar-holiday', name: 'Holiday', kind: 0, targetAmount: 1200, targetDate: '2099-01-01', accrual: 0,
    monthlyContribution: null, includeDeadlineMonth: false, recurMonths: null, fundingAccountId: 'acc1',
    isArchived: false, completedOn: null, canDelete: false, currentBalance: 450, balanceAsOf: ISO(LAST_DAY),
    plannedThisMonth: 150, contributedThisMonth: 0, remainingThisMonth: 150, skippedThisMonth: false,
    deadline: '2099-01-01', shortfall: null, lastCycle: null, fundingCompletesOn: '2098-12-31',
    estimatedMonthsToTarget: null, status: 'OnTrack',
    ...over,
  }
}

function mockLoads(data: BudgetMonthDto | { notFound: true }, jars: JarDto[] = [jar()]) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
    if (url === '/jars') return Promise.resolve({ data: jars })
    if (url === '/auth/me') return Promise.resolve({ data: {} })
    if ('notFound' in data) return Promise.reject({ response: { status: 404 } })
    return Promise.resolve({ data })
  })
}

const jarReads = () => mockGet.mock.calls.filter(([url]) => url === '/jars')

function renderPage(today?: Date) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MonthProvider>{today ? <DashboardPage today={today} /> : <DashboardPage />}</MonthProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DashboardPage — the jars shelf follows the viewed month (W05)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    household.current = { members: [], isShared: false, loading: false, refreshHousehold: async () => {} }
  })

  it('DASH-028: the shelf is read for the viewed month and shown on the current month without a date', { timeout: 15000 }, async () => {
    mockLoads(month())

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })).toBeInTheDocument()
    expect(jarReads()[0][1]).toEqual({ params: { year: YEAR, month: MONTH } })
    expect(screen.getByText('€450.00 saved')).toBeInTheDocument()
    expect(screen.queryByText(/as of/)).not.toBeInTheDocument()
    expect(screen.getByText('+€150.00/mo')).toBeInTheDocument()
  })

  it('DASH-073: a past month keeps its shelf, dated at the month\'s end as the server read it', { timeout: 15000 }, async () => {
    mockLoads(month(), [jar({ currentBalance: 300, balanceAsOf: ISO(LAST_DAY), plannedThisMonth: 100 })])

    // "Today" is a month after the viewed one, so the viewed month is over.
    renderPage(nextMonth)

    expect(await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('€300.00 saved')).toBeInTheDocument()
    expect(screen.getByText(`as of ${formatDate(ISO(LAST_DAY))}`)).toBeInTheDocument()
    expect(screen.getByText('€300.00')).toBeInTheDocument()
    expect(screen.getByText('+€100.00/mo')).toBeInTheDocument()
  })

  it('DASH-074: a month that has not begun shows today\'s balances and says so', { timeout: 15000 }, async () => {
    mockLoads(month(), [jar({ currentBalance: 450, balanceAsOf: '2026-01-01', plannedThisMonth: 130, contributedThisMonth: 0 })])

    // "Today" is a month before the viewed one.
    renderPage(previousMonth)

    expect(await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('balances as of today')).toBeInTheDocument()
    expect(screen.getByText('+€130.00/mo')).toBeInTheDocument()
  })

  it('DASH-075: editing a jar line\'s planned amount re-reads the shelf; editing an expense line does not', { timeout: 15000 }, async () => {
    mockLoads(month())
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()

    renderPage()
    await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })
    await waitFor(() => expect(jarReads().length).toBe(1))

    // The jar's line: the shelf's "+€/mo" is this figure (rule 14), so it is re-read.
    await user.click(screen.getByLabelText('Planned amount for Holiday'))
    const holiday = (await screen.findByLabelText('Planned amount for Holiday')) as HTMLInputElement
    await user.clear(holiday)
    await user.type(holiday, '200')
    await user.tab()
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday', { plannedAmount: 200 }))
    await waitFor(() => expect(jarReads().length).toBe(2))

    // An expense line moves no jar figure: no re-read.
    await user.click(screen.getByLabelText('Planned amount for Rent'))
    const rent = (await screen.findByLabelText('Planned amount for Rent')) as HTMLInputElement
    await user.clear(rent)
    await user.type(rent, '1200')
    await user.tab()
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-rent', { plannedAmount: 1200 }))
    expect(jarReads().length).toBe(2)
  })

  it('DASH-075: creating the month re-reads the shelf, whose plan is the month\'s seeded lines', { timeout: 15000 }, async () => {
    mockLoads({ notFound: true })
    mockPost.mockResolvedValue({ data: month() })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Start a blank budget' }, { timeout: 5000 }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/budget', { year: YEAR, month: MONTH, copyFromPrevious: false }))
    await waitFor(() => expect(jarReads().length).toBe(2))
    expect(await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })).toBeInTheDocument()
  })

  it('DASH-076: on month navigation the previous month\'s shelf never shows under the new month\'s grid', { timeout: 15000 }, async () => {
    // The month's budget and its jars are two requests; when the budget lands first, the shelf
    // must be empty (not the previous month's balances, unlabelled) until its own read lands.
    const PREV = MONTH === 1 ? { year: YEAR - 1, month: 12 } : { year: YEAR, month: MONTH - 1 }
    const prevKey = `${PREV.year}-${String(PREV.month).padStart(2, '0')}`
    let releaseCurrentJars: () => void = () => {}
    const currentJars = new Promise<{ data: JarDto[] }>((resolve) => {
      releaseCurrentJars = () => resolve({ data: [jar({ currentBalance: 450, balanceAsOf: ISO(15) })] })
    })
    mockGet.mockImplementation((url: string, cfg?: { params?: { year: number; month: number } }) => {
      if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars') {
        if (cfg?.params?.month === PREV.month) return Promise.resolve({ data: [jar({ currentBalance: 300, balanceAsOf: `${prevKey}-28`, plannedThisMonth: 100 })] })
        return currentJars // the current month's jars are slow
      }
      if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: { ...month({ planned: 100 }), id: 'm0', key: prevKey, year: PREV.year, month: PREV.month } })
      if (url === `/budget/${YEAR}/${MONTH}`) return Promise.resolve({ data: month() })
      return Promise.reject({ response: { status: 404 } })
    })
    function Nav() {
      const { goToMonth } = useMonth()
      return (
        <>
          <button onClick={() => goToMonth(PREV.year, PREV.month)}>go-prev</button>
          <button onClick={() => goToMonth(YEAR, MONTH)}>go-current</button>
        </>
      )
    }
    render(
      <MemoryRouter>
        <AuthProvider>
          <MonthProvider>
            <Nav />
            <DashboardPage />
          </MonthProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    // View the previous month: its shelf is dated.
    await act(async () => { screen.getByText('go-prev').click() })
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/as of/)).toBeInTheDocument()

    // Back to the current month: its grid lands at once, its jars do not.
    await act(async () => { screen.getByText('go-current').click() })
    await waitFor(() => expect(screen.getAllByText(/€450\.00/).length).toBeGreaterThan(0))
    expect(screen.queryByText('€300.00 saved')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Your jars' })).toBeNull()

    releaseCurrentJars()
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/as of/)).toBeNull()
  })

  it('DASH-077: on month navigation the first-run checklist never shows while the new month\'s jars are in flight', { timeout: 15000 }, async () => {
    // The shelf is emptied for the new month (DASH-076); the checklist (rule 81) reads an empty
    // shelf as "no jar yet", so it must wait for the month's own read, not flash "add a jar".
    const PREV = MONTH === 1 ? { year: YEAR - 1, month: 12 } : { year: YEAR, month: MONTH - 1 }
    const prevKey = `${PREV.year}-${String(PREV.month).padStart(2, '0')}`
    const joint: AccountDto = { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 500, openingDate: '2026-01-01', currentBalance: 500, displayOrder: 0 }
    let releaseCurrentJars: () => void = () => {}
    const currentJars = new Promise<{ data: JarDto[] }>((resolve) => {
      releaseCurrentJars = () => resolve({ data: [jar({ currentBalance: 450, balanceAsOf: ISO(15) })] })
    })
    mockGet.mockImplementation((url: string, cfg?: { params?: { year: number; month: number } }) => {
      if (url === '/budget/months' || url === '/budget/templates') return Promise.resolve({ data: [] })
      if (url === '/accounts') return Promise.resolve({ data: [joint] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars') {
        if (cfg?.params?.month === PREV.month) return Promise.resolve({ data: [jar({ currentBalance: 300, balanceAsOf: `${prevKey}-28`, plannedThisMonth: 100 })] })
        return currentJars // the current month's jars are slow
      }
      if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: { ...month({ planned: 100 }), id: 'm0', key: prevKey, year: PREV.year, month: PREV.month } })
      if (url === `/budget/${YEAR}/${MONTH}`) return Promise.resolve({ data: month() })
      return Promise.reject({ response: { status: 404 } })
    })
    function Nav() {
      const { goToMonth } = useMonth()
      return (
        <>
          <button onClick={() => goToMonth(PREV.year, PREV.month)}>go-prev</button>
          <button onClick={() => goToMonth(YEAR, MONTH)}>go-current</button>
        </>
      )
    }
    render(
      <MemoryRouter>
        <AuthProvider>
          <MonthProvider>
            <Nav />
            <DashboardPage />
          </MonthProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    // The previous month: accounts, month and a jar all exist, so no checklist.
    await act(async () => { screen.getByText('go-prev').click() })
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).toBeNull()

    // Back to the current month: its grid lands, its jars are still in flight — still no checklist.
    await act(async () => { screen.getByText('go-current').click() })
    await waitFor(() => expect(screen.getAllByText(/€450\.00/).length).toBeGreaterThan(0))
    expect(screen.queryByRole('heading', { name: 'Your jars' })).toBeNull()
    expect(screen.queryByText('Set up your budget')).toBeNull()

    releaseCurrentJars()
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).toBeNull()
  })
})
