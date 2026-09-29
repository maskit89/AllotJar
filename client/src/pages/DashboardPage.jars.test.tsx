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
// the first-run checklist's "add a jar" step to a household with jars (DASH-077), nor another
// month's jars when a save made on that month returns after the user moved on (DASH-078); a
// failed read says so instead of passing for "no jars" (DASH-079). Typing an amount on a skipped
// jar line clears the line's Skipped tag as the server does (DASH-080), and a month created, or a
// line planned again, whose answer returns after the user moved on never repaints the grid of
// the month now viewed (DASH-081).
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

// Month navigation between the previous month and the current one. Each month's budget and
// jars are separate requests; `currentJars` / `previousJars` decide how each month's jars read
// answers (a value, a promise held open, or a rejection).
const PREV = MONTH === 1 ? { year: YEAR - 1, month: 12 } : { year: YEAR, month: MONTH - 1 }
const prevKey = `${PREV.year}-${String(PREV.month).padStart(2, '0')}`
const previousMonthDto = (): BudgetMonthDto => ({ ...month({ planned: 100 }), id: 'm0', key: prevKey, year: PREV.year, month: PREV.month })
const previousJars = () => [jar({ currentBalance: 300, balanceAsOf: `${prevKey}-28`, plannedThisMonth: 100 })]
const currentJars = () => [jar({ currentBalance: 450, balanceAsOf: ISO(15) })]
const joint: AccountDto = { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 500, openingDate: '2026-01-01', currentBalance: 500, displayOrder: 0 }

type JarsAnswer = () => Promise<{ data: JarDto[] }>
function mockNavigation({
  accounts = [] as AccountDto[],
  current = (() => Promise.resolve({ data: currentJars() })) as JarsAnswer,
  previous = (() => Promise.resolve({ data: previousJars() })) as JarsAnswer,
} = {}) {
  mockGet.mockImplementation((url: string, cfg?: { params?: { year: number; month: number } }) => {
    if (url === '/budget/months' || url === '/budget/templates') return Promise.resolve({ data: [] })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/auth/me') return Promise.resolve({ data: {} })
    if (url === '/jars') return cfg?.params?.month === PREV.month && cfg?.params?.year === PREV.year ? previous() : current()
    if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: previousMonthDto() })
    if (url === `/budget/${YEAR}/${MONTH}`) return Promise.resolve({ data: month() })
    return Promise.reject({ response: { status: 404 } })
  })
}

function held<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { release = resolve })
  return { promise, release }
}

function Nav() {
  const { goToMonth } = useMonth()
  return (
    <>
      <button onClick={() => goToMonth(PREV.year, PREV.month)}>go-prev</button>
      <button onClick={() => goToMonth(YEAR, MONTH)}>go-current</button>
    </>
  )
}

function renderWithNav() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MonthProvider>
          <Nav />
          <DashboardPage />
        </MonthProvider>
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
    let slow = false
    const currentRead = held<{ data: JarDto[] }>()
    mockNavigation({ current: () => (slow ? currentRead.promise : Promise.resolve({ data: currentJars() })) })
    renderWithNav()

    // View the previous month: its shelf is dated.
    await act(async () => { screen.getByText('go-prev').click() })
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/as of/)).toBeInTheDocument()

    // Back to the current month: its grid lands at once, its jars do not.
    slow = true
    await act(async () => { screen.getByText('go-current').click() })
    await waitFor(() => expect(screen.getAllByText(/€450\.00/).length).toBeGreaterThan(0))
    expect(screen.queryByText('€300.00 saved')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Your jars' })).toBeNull()

    currentRead.release({ data: currentJars() })
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/as of/)).toBeNull()
  })

  it('DASH-077: on month navigation the first-run checklist never shows while the new month\'s jars are in flight', { timeout: 15000 }, async () => {
    // The shelf is emptied for the new month (DASH-076); the checklist (rule 81) reads an empty
    // shelf as "no jar yet", so it must wait for the month's own read, not flash "add a jar".
    let slow = false
    const currentRead = held<{ data: JarDto[] }>()
    mockNavigation({ accounts: [joint], current: () => (slow ? currentRead.promise : Promise.resolve({ data: currentJars() })) })
    renderWithNav()

    // The previous month: accounts, month and a jar all exist, so no checklist.
    await act(async () => { screen.getByText('go-prev').click() })
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).toBeNull()

    // Back to the current month: its grid lands, its jars are still in flight — still no checklist.
    slow = true
    await act(async () => { screen.getByText('go-current').click() })
    await waitFor(() => expect(screen.getAllByText(/€450\.00/).length).toBeGreaterThan(0))
    expect(screen.queryByRole('heading', { name: 'Your jars' })).toBeNull()
    expect(screen.queryByText('Set up your budget')).toBeNull()

    currentRead.release({ data: currentJars() })
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set up your budget')).toBeNull()
  })

  it('DASH-078: a jar line\'s save that returns after the user changed month leaves the new month\'s shelf alone', { timeout: 15000 }, async () => {
    // The planned amount commits on blur, so one click on the month arrow both saves the edit
    // and changes month; the save's shelf refresh is for the month it was made on.
    const put = held<{ data: object }>()
    mockPut.mockReturnValue(put.promise)
    mockNavigation()
    const user = userEvent.setup()
    renderWithNav()
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()

    await user.click(screen.getByLabelText('Planned amount for Holiday'))
    const holiday = (await screen.findByLabelText('Planned amount for Holiday')) as HTMLInputElement
    await user.clear(holiday)
    await user.type(holiday, '200')
    await user.click(screen.getByText('go-prev'))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday', { plannedAmount: 200 }))
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    const readsBefore = jarReads().length

    await act(async () => { put.release({ data: {} }) })

    expect(jarReads().length).toBe(readsBefore)
    expect(screen.getByText('€300.00 saved')).toBeInTheDocument()
    expect(screen.queryByText('€450.00 saved')).toBeNull()
  })

  it('DASH-079: a failed jars read after a month change says so and does not show the first-run checklist', { timeout: 15000 }, async () => {
    mockNavigation({ accounts: [joint], previous: () => Promise.reject({ response: { status: 500 } }) })
    renderWithNav()
    expect(await screen.findByText('€450.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()

    await act(async () => { screen.getByText('go-prev').click() })

    expect(await screen.findByText(/Could not load your jars for this month/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getAllByText(/€300\.00|€100\.00/).length).toBeGreaterThan(0) // the month's grid is there
    expect(screen.queryByRole('heading', { name: 'Your jars' })).toBeNull()
    expect(screen.queryByText('Set up your budget')).toBeNull()
  })
  it('DASH-080: typing an amount on a skipped jar line clears its Skipped tag, as the shelf\'s re-read does', { timeout: 15000 }, async () => {
    // The server un-skips the month when a jar line gets an amount (rule 60), and the shelf
    // re-reads it as planned; the line itself must not still say "Skipped".
    const skipped = (): BudgetMonthDto => {
      const m = month({ planned: 0 })
      const sav = m.categories.find((c) => c.id === 'c-sav')!
      sav.items = sav.items.map((i) => ({ ...i, plannedAmount: 0, remaining: 0, isSkipped: true }))
      return m
    }
    let unskipped = false
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars') {
        return Promise.resolve({ data: [unskipped
          ? jar({ plannedThisMonth: 200, remainingThisMonth: 200 })
          : jar({ plannedThisMonth: 0, remainingThisMonth: 0, skippedThisMonth: true })] })
      }
      if (url === `/budget/${YEAR}/${MONTH}`) return Promise.resolve({ data: skipped() })
      return Promise.reject({ response: { status: 404 } })
    })
    mockPut.mockImplementation(() => { unskipped = true; return Promise.resolve({ data: month({ planned: 200 }) }) })
    const user = userEvent.setup()

    renderPage()
    expect(await screen.findByRole('heading', { name: 'Your jars' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Skipped')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Planned amount for Holiday'))
    const holiday = (await screen.findByLabelText('Planned amount for Holiday')) as HTMLInputElement
    await user.clear(holiday)
    await user.type(holiday, '200')
    await user.tab()

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday', { plannedAmount: 200 }))
    expect(await screen.findByText('+€200.00/mo', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Skipped')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Plan Holiday again this month' })).toBeNull()
  })

  it('DASH-081: a month created after the user moved to another month leaves the viewed month\'s grid alone', { timeout: 15000 }, async () => {
    // The current month has no budget yet; the user starts one, then goes back a month before
    // the create returns. The answer is the current month's: it must not land under the
    // previous month's label.
    mockGet.mockImplementation((url: string, cfg?: { params?: { year: number; month: number } }) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ year: PREV.year, month: PREV.month }] })
      if (url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars') return Promise.resolve({ data: cfg?.params?.month === PREV.month && cfg?.params?.year === PREV.year ? previousJars() : currentJars() })
      if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: previousMonthDto() })
      return Promise.reject({ response: { status: 404 } })
    })
    const create = held<{ data: BudgetMonthDto }>()
    mockPost.mockReturnValue(create.promise)
    const user = userEvent.setup()
    renderWithNav()

    await user.click(await screen.findByRole('button', { name: 'Start a blank budget' }, { timeout: 5000 }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    await user.click(screen.getByText('go-prev'))
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByLabelText('Planned amount for Holiday').textContent).toContain('100')

    await act(async () => { create.release({ data: month() }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(screen.getByLabelText('Planned amount for Holiday').textContent).toContain('100')
    expect(screen.getByLabelText('Planned amount for Holiday').textContent).not.toContain('150')
  })

  it('DASH-081: planning a skipped line again, answered after the user moved on, leaves the viewed month\'s grid alone', { timeout: 15000 }, async () => {
    const skippedCurrent = (): BudgetMonthDto => {
      const m = month({ planned: 0 })
      const sav = m.categories.find((c) => c.id === 'c-sav')!
      sav.items = sav.items.map((i) => ({ ...i, plannedAmount: 0, remaining: 0, isSkipped: true }))
      return m
    }
    mockGet.mockImplementation((url: string, cfg?: { params?: { year: number; month: number } }) => {
      if (url === '/budget/months' || url === '/budget/templates' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars') return Promise.resolve({ data: cfg?.params?.month === PREV.month && cfg?.params?.year === PREV.year ? previousJars() : currentJars() })
      if (url === `/budget/${PREV.year}/${PREV.month}`) return Promise.resolve({ data: previousMonthDto() })
      if (url === `/budget/${YEAR}/${MONTH}`) return Promise.resolve({ data: skippedCurrent() })
      return Promise.reject({ response: { status: 404 } })
    })
    const restore = held<{ data: BudgetMonthDto }>()
    mockPut.mockReturnValue(restore.promise)
    const user = userEvent.setup()
    renderWithNav()

    await user.click(await screen.findByRole('button', { name: 'Plan Holiday again this month' }, { timeout: 5000 }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday/skip', { skipped: false }))
    await user.click(screen.getByText('go-prev'))
    expect(await screen.findByText('€300.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()

    await act(async () => { restore.release({ data: month() }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(screen.getByLabelText('Planned amount for Holiday').textContent).toContain('100')
    expect(screen.getByLabelText('Planned amount for Holiday').textContent).not.toContain('150')
  })
})
