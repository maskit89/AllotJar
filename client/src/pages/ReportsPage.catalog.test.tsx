// Catalog-driven Reports tests (docs/testing/cases/18-reports.md, prefix RPT).
//
// They assert the computed money and copy: hero figures
// (saved / avg / rate), the received-vs-budgeted income split, share %,
// annual rows + totals + sign colours, the (Name,Kind) keying, the swallowed
// partial-failure paths, the currency-follows-breakdown behaviour, and the
// empty / error surfaces. Fixtures follow the catalog's "H2" baseline exactly.
//
// Determinism notes: every mock resolves synchronously; async waits carry an
// explicit 5s timeout; the api mock answers /reports/trends, /reports/month/{y}/{m}
// (the W12 month report: non-income groups net of refunds plus an Uncategorised row,
// with a categories[] array so the breakdown memo never dereferences undefined)
// AND /reports/annual/{year}, plus a catch-all for /auth/me.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type {
  AnnualSummaryDto,
  BudgetTrendsDto,
  AnnualCategoryDto,
  MonthReportCategoryDto,
  MonthReportDto,
} from '../types'

const { mockGet, mockTrack } = vi.hoisted(() => ({ mockGet: vi.fn(), mockTrack: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

// Spy on analytics `track` while keeping the real EVENTS map (report_viewed etc.).
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: mockTrack,
}))

import { ReportsPage } from './ReportsPage'
import { AuthProvider } from '../auth/AuthContext'

// --- fixtures ---------------------------------------------------------------

/** One spending group of the month report: its net actual and the refunds already taken off it (rules 38/39). */
function cat(id: string, name: string, kind: 'Expense' | 'Savings', net: number, refunds = 0): MonthReportCategoryDto {
  return { id, name, kind, index: 0, spent: net + refunds, refunds, net, isUncategorised: false, count: 0 }
}

/** The month report's Uncategorised row (rule 37): expenses no line carries yet, flagged for review. */
function uncategorised(net: number, count: number, refunds = 0): MonthReportCategoryDto {
  return { id: null, name: 'Uncategorised', kind: 'Uncategorised', index: -1, spent: net + refunds, refunds, net, isUncategorised: true, count }
}

function month(year: number, mo: number, currency: string, categories: MonthReportCategoryDto[]): MonthReportDto {
  // Hue indexes follow group order, as the server assigns them from the budget's display order.
  let index = 0
  const groups = categories.map((c) => (c.isUncategorised ? c : { ...c, index: index++ }))
  const loose = groups.find((c) => c.isUncategorised)
  const spentCategorised = groups.filter((c) => !c.isUncategorised).reduce((s, c) => s + c.net, 0)
  const spentUncategorised = loose?.net ?? 0
  return {
    year,
    month: mo,
    key: `${year}-${String(mo).padStart(2, '0')}`,
    hasBudget: true,
    baseCurrency: currency,
    incomeBudgeted: 3000,
    incomeReceived: 2950,
    incomeUncategorised: 0,
    variance: -50,
    planned: 0,
    spentCategorised,
    spentUncategorised,
    refunds: groups.reduce((s, c) => s + c.refunds, 0),
    spent: spentCategorised + spentUncategorised,
    uncategorisedCount: loose?.count ?? 0,
    uncategorisedIncomeCount: 0,
    fxPendingCount: 0,
    categories: groups,
  }
}

const emptyMonth = (year: number, mo: number, currency = 'EUR') => month(year, mo, currency, [])

// H2 baseline trends: May + June 2026 (June latest). Received income < budgeted.
function h2Trends(): BudgetTrendsDto {
  return {
    points: [
      { year: 2026, month: 5, key: '2026-05', income: 3000, incomeReceived: 2900, planned: 2400, spent: 2700 },
      { year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2950, planned: 2600, spent: 2400 },
    ],
    totalIncome: 6000,
    totalIncomeReceived: 5850,
    totalSpent: 5100,
  }
}

// June breakdown (H2): Housing 1400, Food 700, Emergency Fund 300 (the month report never lists income).
function juneBreakdown(currency = 'EUR'): MonthReportDto {
  return month(2026, 6, currency, [
    cat('house6', 'Housing', 'Expense', 1400),
    cat('food6', 'Food', 'Expense', 700),
    cat('fund6', 'Emergency Fund', 'Savings', 300),
  ])
}

// May breakdown (H2): Housing 1400, Food 1000, Emergency Fund 300.
function mayBreakdown(currency = 'EUR'): MonthReportDto {
  return month(2026, 5, currency, [
    cat('house5', 'Housing', 'Expense', 1400),
    cat('food5', 'Food', 'Expense', 1000),
    cat('fund5', 'Emergency Fund', 'Savings', 300),
  ])
}

/** An annual row; `received` defaults to the budgeted income (variance 0). */
function annualMonth(mo: number, hasBudget: boolean, income = 0, spent = 0, planned = 0, received = income) {
  return {
    month: mo, key: `2026-${String(mo).padStart(2, '0')}`, hasBudget,
    income, incomeReceived: received, variance: received - income, planned, spent,
  }
}

// H2 annual 2026: May + June budgeted; Budgeted income 3000 next to the 2900/2950 received (rule 41).
function annual2026(year = 2026, categories?: AnnualCategoryDto[], budgetedMonths = 2): AnnualSummaryDto {
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    if (m === 5) return annualMonth(5, true, 3000, 2700, 2400, 2900)
    if (m === 6) return annualMonth(6, true, 3000, 2400, 2600, 2950)
    return annualMonth(m, false)
  })
  return {
    year,
    months,
    totalIncome: 6000,
    totalIncomeReceived: 5850,
    totalVariance: -150,
    totalPlanned: 5000,
    totalSpent: 5100,
    budgetedMonths,
    categories: categories ?? [
      { name: 'Housing', kind: 'Expense', total: 2800, averagePerMonth: 1400 },
      { name: 'Food', kind: 'Expense', total: 1700, averagePerMonth: 850 },
      { name: 'Emergency Fund', kind: 'Savings', total: 600, averagePerMonth: 300 },
    ],
  }
}

function emptyAnnual(year: number): AnnualSummaryDto {
  return {
    year,
    months: Array.from({ length: 12 }, (_, i) => annualMonth(i + 1, false)),
    totalIncome: 0,
    totalIncomeReceived: 0,
    totalVariance: 0,
    totalPlanned: 0,
    totalSpent: 0,
    budgetedMonths: 0,
    categories: [],
  }
}

// --- wiring -----------------------------------------------------------------

interface Wiring {
  trends: BudgetTrendsDto
  months?: Record<string, MonthReportDto>
  annuals?: Record<number, AnnualSummaryDto>
  rejectMonthUrls?: string[]
  rejectAnnualYears?: number[]
}

function wire(w: Wiring) {
  mockGet.mockImplementation((url?: string) => {
    if (url?.startsWith('/reports/trends')) return Promise.resolve({ data: w.trends })

    const mMatch = url?.match(/^\/reports\/month\/(\d+)\/(\d+)$/)
    if (mMatch) {
      if (w.rejectMonthUrls?.includes(url!)) return Promise.reject(new Error('boom'))
      const y = Number(mMatch[1])
      const mo = Number(mMatch[2])
      const provided = w.months?.[`${y}-${mo}`]
      return Promise.resolve({ data: provided ?? emptyMonth(y, mo) })
    }

    const aMatch = url?.match(/^\/reports\/annual\/(\d+)$/)
    if (aMatch) {
      const y = Number(aMatch[1])
      if (w.rejectAnnualYears?.includes(y)) return Promise.reject(new Error('boom'))
      const provided = w.annuals?.[y]
      return Promise.resolve({ data: provided ?? emptyAnnual(y) })
    }

    return Promise.resolve({ data: {} }) // /auth/me and anything else
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ReportsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const T = { timeout: 15000 }
const W = { timeout: 5000 }

/** The single annual <table>, once it has rendered. */
async function annualTable() {
  return screen.findByRole('table', {}, W)
}
function rowFor(table: HTMLElement, monthLabel: string): HTMLElement {
  return within(table).getByText(monthLabel).closest('tr') as HTMLElement
}

describe('ReportsPage — catalog (RPT)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockTrack.mockReset()
  })

  // RPT-001, RPT-010 — page loads with the AppShell title, hero and all four
  // cards in order; the client always requests the 6 most-recent budgets.
  it('renders the hero and all four cards in order (RPT-001, RPT-010)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    // Hero eyebrow + the four card headings, no error banner, no empty state.
    expect(await screen.findByText('Saved this month', {}, W)).toBeInTheDocument()
    // AppShell renders its accessible name as a visually-hidden <h1>.
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()

    // The annual + average cards depend on the (separate) annual fetch — wait for
    // them so the ordering check sees all four cards.
    await screen.findByText('Annual overview', {}, W)
    await screen.findByText('Average monthly spending by category', {}, W)

    const h3s = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    const order = ['Income vs spending', 'Annual overview', 'Average monthly spending by category', 'Spending by category']
    const idxs = order.map((t) => h3s.indexOf(t))
    idxs.forEach((i) => expect(i).toBeGreaterThanOrEqual(0))
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b)) // cards appear in the documented order

    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // The client always asks for the most-recent 6 budgets.
    expect(mockGet).toHaveBeenCalledWith('/reports/trends?months=6')
  })

  // RPT-002 — while the trends fetch is in flight only the loading line shows.
  it('shows only the loading placeholder while trends are pending (RPT-002)', T, async () => {
    mockGet.mockImplementation((url?: string) => {
      if (url?.startsWith('/reports/trends')) return new Promise(() => {}) // never resolves
      return Promise.resolve({ data: {} })
    })
    renderPage()

    expect(await screen.findByText('Loading your reports…', {}, W)).toBeInTheDocument()
    expect(screen.queryByText('Saved this month')).not.toBeInTheDocument()
    expect(screen.queryByText('Income vs spending')).not.toBeInTheDocument()
    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // RPT-003 — hero figures from the latest month and the window.
  it('computes saved-this-month, avg spend and savings rate (RPT-003)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    // Saved = received 2,950 − spent 2,400 = 550, exposed via aria-label.
    expect(await screen.findByLabelText('Saved this month: €550.00', {}, W)).toBeInTheDocument()
    // Avg = round(5,100 / 2) = 2,550.
    expect(screen.getByText('€2,550.00')).toBeInTheDocument()
    // Rate = round(550 / 2,950 × 100) = 19%.
    expect(screen.getByText('19%')).toBeInTheDocument()
  })

  // RPT-004 — overspent latest month → negative saved amount and negative rate.
  it('renders a negative saved amount and negative savings rate when overspent (RPT-004)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [{ year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2300, planned: 2600, spent: 2600 }],
      totalIncome: 3000,
      totalIncomeReceived: 2300,
      totalSpent: 2600,
    }
    wire({ trends, months: { '2026-6': emptyMonth(2026, 6) } })
    renderPage()

    // Saved = 2,300 − 2,600 = −300; rate = round(−300 / 2,300 × 100) = −13%.
    expect(await screen.findByLabelText('Saved this month: -€300.00', {}, W)).toBeInTheDocument()
    expect(screen.getByText('-13%')).toBeInTheDocument()
  })

  // RPT-005 — savings rate guarded to 0% when nothing was received (no NaN%).
  it('shows 0% savings rate (not NaN) when no income was received (RPT-005)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [{ year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 0, planned: 800, spent: 800 }],
      totalIncome: 3000,
      totalIncomeReceived: 0,
      totalSpent: 800,
    }
    wire({ trends, months: { '2026-6': emptyMonth(2026, 6) } })
    renderPage()

    expect(await screen.findByLabelText('Saved this month: -€800.00', {}, W)).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })

  // RPT-006 — legend, one labelled column per budget, current-month tint, bar tooltips.
  it('renders the trend legend, per-month columns and bar tooltips (RPT-006)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    const section = (await screen.findByRole('heading', { name: 'Income vs spending' }, W)).closest(
      'section',
    ) as HTMLElement
    // Legend swatches.
    expect(within(section).getByText('Income')).toBeInTheDocument()
    expect(within(section).getByText('Spent')).toBeInTheDocument()

    // A labelled column per budget.
    const may = screen.getByLabelText('Trend for May 2026')
    const jun = screen.getByLabelText('Trend for Jun 2026')
    expect(may).toBeInTheDocument()
    expect(jun).toBeInTheDocument()
    // The current (last) column's tick is brand-tinted; the earlier one is muted.
    expect(within(jun).getByText('Jun')).toHaveClass('text-brand-700')
    expect(within(may).getByText('May')).toHaveClass('text-slate-500')

    // June bar tooltips use the RECEIVED income and the actual spend.
    expect(screen.getByTitle('Income €2,950.00')).toBeInTheDocument()
    expect(screen.getByTitle('Spent €2,400.00')).toBeInTheDocument()
  })

  // RPT-007, RPT-015 — income bars plot received income, but height scales to a
  // window max that includes the (undrawn) budgeted income; the annual table shows
  // the budgeted and the received income side by side with their Variance (rule 41).
  it('plots received income yet scales bars to the budgeted max (RPT-007, RPT-015)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    // Received (2,950) drawn against window max 3,000 (budgeted) → 98%, never 100%.
    const incomeBar = await screen.findByTitle('Income €2,950.00', {}, W)
    expect(incomeBar.style.height).toBe('98%')

    // Same June in the annual table: Budgeted 3,000 | Received 2,950 | Variance −50 | Spent 2,400 | Net 550.
    const table = await annualTable()
    const juneCells = rowFor(table, 'Jun').querySelectorAll('td')
    expect(juneCells[1]).toHaveTextContent('€3,000.00')
    expect(juneCells[2]).toHaveTextContent('€2,950.00')
    expect(juneCells[3]).toHaveTextContent('-€50.00')
    expect(juneCells[4]).toHaveTextContent('€2,400.00')
    expect(juneCells[5]).toHaveTextContent('€550.00') // net = received 2,950 − spent 2,400
  })

  // RPT-008 — a tiny non-zero bar gets a 2% sliver; a zero value gets 0%.
  it('gives a tiny non-zero bar a 2% sliver and a zero value 0% (RPT-008)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 5, key: '2026-05', income: 0, incomeReceived: 4000, planned: 0, spent: 0 },
        { year: 2026, month: 6, key: '2026-06', income: 0, incomeReceived: 0, planned: 5, spent: 5 },
      ],
      totalIncome: 0,
      totalIncomeReceived: 4000,
      totalSpent: 5,
    }
    wire({ trends, months: { '2026-6': emptyMonth(2026, 6) } })
    renderPage()

    // Spent €5 against max 4,000 → 0.125% clamped up to a visible 2% sliver.
    const sliver = await screen.findByTitle('Spent €5.00', {}, W)
    expect(sliver.style.height).toBe('2%')
    // Received €0 in the current month → truly 0% (no bar).
    expect(screen.getByTitle('Income €0.00').style.height).toBe('0%')
  })

  // RPT-009, RPT-010 — the window is the most-recent N budgets, not the last N
  // calendar months; gaps are skipped, columns are chronological, select is newest-first.
  it('windows the most-recent budgets with no calendar gaps (RPT-009, RPT-010)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 1, key: '2026-01', income: 3000, incomeReceived: 3000, planned: 2000, spent: 2000 },
        { year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2950, planned: 2600, spent: 2400 },
      ],
      totalIncome: 6000,
      totalIncomeReceived: 5950,
      totalSpent: 4400,
    }
    wire({ trends, months: { '2026-6': juneBreakdown() } })
    renderPage()

    // Exactly two columns, chronological (Jan then Jun) — Feb–May are NOT drawn.
    const cols = await screen.findAllByLabelText(/^Trend for /, {}, W)
    expect(cols).toHaveLength(2)
    expect(cols[0]).toHaveAttribute('aria-label', 'Trend for Jan 2026')
    expect(cols[1]).toHaveAttribute('aria-label', 'Trend for Jun 2026')
    expect(screen.queryByLabelText('Trend for Feb 2026')).not.toBeInTheDocument()

    // Breakdown select offers only those two, newest-first.
    const select = screen.getByLabelText('Breakdown month')
    const opts = within(select).getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['Jun 2026', 'Jan 2026'])

    expect(mockGet).toHaveBeenCalledWith('/reports/trends?months=6')
  })

  // RPT-011 — annual table headers, month rows and totals footer.
  it('renders the annual table rows and totals footer (RPT-011)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    const table = await annualTable()
    // Headers (rule 41: budgeted next to received, with the signed Variance).
    ;['Month', 'Budgeted', 'Received', 'Variance', 'Spent', 'Net'].forEach((h) =>
      expect(within(table).getByText(h)).toBeInTheDocument(),
    )
    // May: 3,000 budgeted / 2,900 received / −100 / 2,700 spent / net 200.
    const may = rowFor(table, 'May').querySelectorAll('td')
    expect(may[1]).toHaveTextContent('€3,000.00')
    expect(may[2]).toHaveTextContent('€2,900.00')
    expect(may[3]).toHaveTextContent('-€100.00')
    expect(may[4]).toHaveTextContent('€2,700.00')
    expect(may[5]).toHaveTextContent('€200.00')
    // June: 3,000 / 2,950 / −50 / 2,400 / 550.
    const jun = rowFor(table, 'Jun').querySelectorAll('td')
    expect(jun[4]).toHaveTextContent('€2,400.00')
    expect(jun[5]).toHaveTextContent('€550.00')
    // Footer: 6,000 / 5,850 / −150 / 5,100 / 750.
    const total = rowFor(table, 'Total').querySelectorAll('td')
    expect(total[1]).toHaveTextContent('€6,000.00')
    expect(total[2]).toHaveTextContent('€5,850.00')
    expect(total[3]).toHaveTextContent('-€150.00')
    expect(total[4]).toHaveTextContent('€5,100.00')
    expect(total[5]).toHaveTextContent('€750.00')
  })

  // RPT-012 — non-budgeted months show em dashes; Net is emerald/rose by sign.
  it('dashes non-budgeted months and colours Net by sign (RPT-012)', T, async () => {
    const withJuly = annual2026()
    withJuly.months = withJuly.months.map((m) => (m.month === 7 ? annualMonth(7, true, 3000, 3200, 3000) : m))
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: withJuly } })
    renderPage()

    const table = await annualTable()
    // A non-budgeted month: em dashes + muted row.
    const jan = rowFor(table, 'Jan')
    expect(jan).toHaveClass('text-slate-500')
    const janCells = jan.querySelectorAll('td')
    ;[1, 2, 3, 4, 5].forEach((i) => expect(janCells[i]).toHaveTextContent('—'))
    expect(janCells[5]).not.toHaveClass('text-emerald-600')
    expect(janCells[5]).not.toHaveClass('text-rose-600')

    // Positive net → emerald.
    expect(rowFor(table, 'May').querySelectorAll('td')[5]).toHaveClass('text-emerald-600')
    // July spent 3,200 > received 3,000 → Net −€200.00 in rose; a zero Variance is plain, not an error.
    const julCells = rowFor(table, 'Jul').querySelectorAll('td')
    expect(julCells[3]).toHaveTextContent('€0.00')
    expect(julCells[3]).not.toHaveClass('text-rose-600')
    expect(julCells[5]).toHaveTextContent('-€200.00')
    expect(julCells[5]).toHaveClass('text-rose-600')
  })

  // RPT-013 — year navigation refetches and fires the annual analytics event
  // (never on the initial render).
  it('navigates years, refetches and fires the annual report_viewed event (RPT-013)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2025: annual2026(2025), 2026: annual2026(2026), 2027: annual2026(2027) },
    })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Annual overview', {}, W)).toBeInTheDocument()
    // No report_viewed event for the default render.
    expect(mockTrack.mock.calls.filter((c) => c[0] === 'report_viewed')).toHaveLength(0)

    await user.click(screen.getByLabelText('Previous year'))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2025'), W)
    expect(mockTrack).toHaveBeenCalledWith('report_viewed', { report_type: 'annual' })

    await user.click(screen.getByLabelText('Next year')) // back to 2026
    await user.click(screen.getByLabelText('Next year')) // on to 2027
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2027'), W)
    expect(await screen.findByText('2027', {}, W)).toBeInTheDocument()
    // One event per click, none on mount.
    expect(mockTrack.mock.calls.filter((c) => c[0] === 'report_viewed' && c[1]?.report_type === 'annual')).toHaveLength(3)
  })

  // RPT-014 — a year with no budgets: all-dash table with zero totals, and the
  // average card disappears while trend + breakdown cards stay.
  it('shows an all-dash table and drops the average card for an empty year (RPT-014)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Average monthly spending by category', {}, W)).toBeInTheDocument()

    await user.click(screen.getByLabelText('Next year')) // 2027 → emptyAnnual fallback
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2027'), W)
    expect(await screen.findByText('2027', {}, W)).toBeInTheDocument()

    const table = await annualTable()
    const total = rowFor(table, 'Total')
    const totalCells = total.querySelectorAll('td')
    ;[1, 2, 3, 4, 5].forEach((i) => expect(totalCells[i]).toHaveTextContent('€0.00'))

    // Average card gone; the trend + breakdown cards remain.
    await waitFor(
      () => expect(screen.queryByText('Average monthly spending by category')).not.toBeInTheDocument(),
      W,
    )
    expect(screen.getByText('Income vs spending')).toBeInTheDocument()
    expect(screen.getByText('Spending by category')).toBeInTheDocument()
  })

  // RPT-017 — average card: descending rows, per-mo + total money, Fund badge,
  // plural subtitle.
  it('lists per-category yearly averages with the plural subtitle and Fund badge (RPT-017)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    expect(await screen.findByText('Average monthly spending by category', {}, W)).toBeInTheDocument()
    // Plural subtitle for a 2-month year.
    expect(screen.getByText(/over the 2 budgeted months of 2026\./)).toBeInTheDocument()

    const rows = screen.getAllByLabelText(/^Average spending for /)
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Average spending for Housing',
      'Average spending for Food',
      'Average spending for Emergency Fund',
    ])
    expect(screen.getByLabelText('Average spending for Housing')).toHaveTextContent('€1,400.00/mo · €2,800.00 total')
    expect(screen.getByLabelText('Average spending for Food')).toHaveTextContent('€850.00/mo · €1,700.00 total')
    const fund = screen.getByLabelText('Average spending for Emergency Fund')
    expect(fund).toHaveTextContent('€300.00/mo · €600.00 total')
    expect(within(fund).getByText('Fund')).toBeInTheDocument()
  })

  // RPT-018, RPT-036 — a single-month household: one column, one breakdown
  // option, avg = that month's spend, and a singular subtitle.
  it('renders a single-month household with singular copy (RPT-018, RPT-036)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [{ year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2950, planned: 2600, spent: 2400 }],
      totalIncome: 3000,
      totalIncomeReceived: 2950,
      totalSpent: 2400,
    }
    const singleAnnual = annual2026(2026, [{ name: 'Housing', kind: 'Expense', total: 1400, averagePerMonth: 1400 }], 1)
    wire({ trends, months: { '2026-6': juneBreakdown() }, annuals: { 2026: singleAnnual } })
    renderPage()

    // One trend column.
    const cols = await screen.findAllByLabelText(/^Trend for /, {}, W)
    expect(cols).toHaveLength(1)
    expect(cols[0]).toHaveAttribute('aria-label', 'Trend for Jun 2026')

    // Avg monthly spend = round(2,400 / 1) = 2,400 (scoped to the hero tile —
    // €2,400.00 also appears as June's actual spend in the annual table).
    const avgTile = screen.getByText('Avg monthly spend').closest('div') as HTMLElement
    expect(within(avgTile).getByText('€2,400.00')).toBeInTheDocument()

    // Exactly one breakdown option.
    const opts = within(screen.getByLabelText('Breakdown month')).getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['Jun 2026'])

    // Singular subtitle (wait for the annual-driven average card first).
    expect(await screen.findByText(/over the 1 budgeted month of 2026\./, {}, W)).toBeInTheDocument()
  })

  // RPT-019 — categories keyed by (Name, Kind): same-name kinds render as
  // separate rows and only the Savings one gets the Fund badge.
  it('keys average categories by (Name, Kind) so same-name kinds separate (RPT-019)', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Food', kind: 'Expense', total: 900, averagePerMonth: 300 },
      { name: 'Food', kind: 'Savings', total: 600, averagePerMonth: 200 },
      { name: 'Groceries', kind: 'Expense', total: 300, averagePerMonth: 100 },
    ]
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026(2026, categories) } })
    renderPage()

    expect(await screen.findByText('Average monthly spending by category', {}, W)).toBeInTheDocument()
    // Two distinct 'Food' rows (Expense + Savings) plus the renamed 'Groceries'.
    const foods = screen.getAllByLabelText('Average spending for Food')
    expect(foods).toHaveLength(2)
    expect(screen.getByLabelText('Average spending for Groceries')).toBeInTheDocument()
    // Exactly one of the two Food rows (the Savings one) carries the Fund badge.
    const foodWithFund = foods.filter((r) => within(r).queryByText('Fund'))
    expect(foodWithFund).toHaveLength(1)
  })

  // RPT-020 — breakdown defaults to the latest month, biggest first, share % +
  // bars, Fund badge, income excluded.
  it('breaks the latest month down by category with share % and bars (RPT-020)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()

    const housing = await screen.findByLabelText('Spending for Housing', {}, W)
    // Sorted by spend desc.
    const rows = screen.getAllByLabelText(/^Spending for /)
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Spending for Housing',
      'Spending for Food',
      'Spending for Emergency Fund',
    ])
    // Money · share%, where % is share of the €2,400 category total.
    expect(housing).toHaveTextContent('€1,400.00 · 58%')
    expect(screen.getByLabelText('Spending for Food')).toHaveTextContent('€700.00 · 29%')
    const fund = screen.getByLabelText('Spending for Emergency Fund')
    expect(fund).toHaveTextContent('€300.00 · 13%')
    expect(within(fund).getByText('Fund')).toBeInTheDocument()

    // Bar width is relative to the largest category (Housing → 100%).
    const bar = within(housing).getByRole('img', { name: 'Housing' })
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%')

    // Income group excluded.
    expect(screen.queryByLabelText('Spending for Income')).not.toBeInTheDocument()
  })

  // RPT-021 — changing the breakdown month refetches and fires the breakdown
  // event (never on the default render); hero/annual are untouched.
  it('reloads and fires the breakdown event when the month changes (RPT-021)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown(), '2026-5': mayBreakdown() },
      annuals: { 2026: annual2026() },
    })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByLabelText('Spending for Housing', {}, W)).toBeInTheDocument()
    // No breakdown event for the initial default view.
    expect(mockTrack.mock.calls.filter((c) => c[1]?.report_type === 'breakdown')).toHaveLength(0)

    await user.selectOptions(screen.getByLabelText('Breakdown month'), '2026-05')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/month/2026/5'), W)

    // May's numbers now show, and the breakdown event fired exactly once.
    expect(await screen.findByLabelText('Spending for Food', {}, W)).toHaveTextContent('€1,000.00')
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00')
    expect(mockTrack).toHaveBeenCalledWith('report_viewed', { report_type: 'breakdown' })
    expect(mockTrack.mock.calls.filter((c) => c[1]?.report_type === 'breakdown')).toHaveLength(1)
    // The hero still summarises the window (unchanged by the breakdown select).
    expect(screen.getByLabelText('Saved this month: €550.00')).toBeInTheDocument()
  })

  // RPT-022 — a breakdown month with no non-income spend shows the empty line.
  it('shows the empty line for a breakdown month with no spending (RPT-022)', T, async () => {
    const barrenJune = month(2026, 6, 'EUR', [
      cat('house6', 'Housing', 'Expense', 0),
      cat('food6', 'Food', 'Expense', 0),
    ])
    wire({ trends: h2Trends(), months: { '2026-6': barrenJune }, annuals: { 2026: annual2026() } })
    renderPage()

    expect(await screen.findByText('No spending recorded for this month yet.', {}, W)).toBeInTheDocument()
    expect(screen.queryByLabelText('Spending for Housing')).not.toBeInTheDocument()
    // Hero still populated from the window.
    expect(screen.getByText('Saved this month')).toBeInTheDocument()
  })

  // RPT-023 — a category that netted below zero this month (more refunded than spent, rule 39)
  // stays on the list, labelled with what was refunded, carries no share and is left out of
  // the share denominator.
  it('keeps a negative-net category, labelled, without a share (RPT-023)', T, async () => {
    const withRefund = month(2026, 6, 'EUR', [
      cat('house6', 'Housing', 'Expense', 1400),
      cat('food6', 'Food', 'Expense', 700),
      cat('util6', 'Utilities', 'Expense', -50, 120), // spent 70, refunded 120
    ])
    wire({ trends: h2Trends(), months: { '2026-6': withRefund }, annuals: { 2026: annual2026() } })
    renderPage()

    await screen.findByLabelText('Spending for Housing', {}, W)
    // Utilities is shown last, as a negative figure explained by its refunds, with no share %.
    const utilities = screen.getByLabelText('Spending for Utilities')
    expect(utilities).toHaveTextContent('-€50.00 · after €120.00 refunded')
    expect(utilities).not.toHaveTextContent('%')
    expect(screen.getAllByLabelText(/^Spending for /).map((r) => r.getAttribute('aria-label'))).toEqual([
      'Spending for Housing',
      'Spending for Food',
      'Spending for Utilities',
    ])
    // Denominator is 1,400 + 700 = 2,100 → Housing 67%, Food 33% (the negative row not counted).
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 67%')
    expect(screen.getByLabelText('Spending for Food')).toHaveTextContent('€700.00 · 33%')
  })

  // RPT-038 — rule 37: spending no line carries yet is its own Uncategorised row, in the
  // total and the shares, flagged for review with a link to the register.
  it('lists uncategorised spending as its own row with a review link (RPT-038)', T, async () => {
    const withLoose = month(2026, 6, 'EUR', [cat('house6', 'Housing', 'Expense', 1400), uncategorised(100, 2)])
    wire({ trends: h2Trends(), months: { '2026-6': withLoose }, annuals: { 2026: annual2026() } })
    renderPage()

    const loose = await screen.findByLabelText('Spending for Uncategorised', {}, W)
    // 100 of a 1,500 total → 7%; Housing 93%.
    expect(loose).toHaveTextContent('€100.00 · 7%')
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 93%')
    const review = within(loose).getByRole('link', { name: 'Review uncategorised transactions' })
    expect(review).toHaveTextContent('Review 2 transactions')
    expect(review).toHaveAttribute('href', '/transactions')
  })

  // RPT-039 — rules 38/39: a group's figure is net of the refunds received against it this
  // month, and says so.
  it('shows a group net of its refunds with the refunded amount (RPT-039)', T, async () => {
    const withRefund = month(2026, 6, 'EUR', [
      cat('house6', 'Housing', 'Expense', 1400),
      cat('food6', 'Food', 'Expense', 680, 20), // spent 700, refunded 20
    ])
    wire({ trends: h2Trends(), months: { '2026-6': withRefund }, annuals: { 2026: annual2026() } })
    renderPage()

    const food = await screen.findByLabelText('Spending for Food', {}, W)
    // 680 of 2,080 → 33%, then the refund note.
    expect(food).toHaveTextContent('€680.00 · 33% · after €20.00 refunded')
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 67%')
    expect(screen.getByLabelText('Spending for Housing')).not.toHaveTextContent('refunded')
  })

  // RPT-040 — rule 41 in the annual table: Received next to Budgeted with a signed Variance
  // (plus above plan, minus below, plain at zero), and a month with no budget still shows what
  // its transactions say: its Budgeted cell is dashed and its Variance is all it received, as
  // the year's total counts it.
  it('shows budgeted vs received income with a signed variance per month (RPT-040)', T, async () => {
    const annual = annual2026()
    annual.months = annual.months.map((m) => {
      if (m.month === 7) return annualMonth(7, true, 3000, 2500, 3000, 3200) // +200
      if (m.month === 8) return { ...annualMonth(8, false, 0, 120, 0, 80), uncategorisedCount: 1 } // no budget, loose rows
      return m
    })
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual } })
    renderPage()

    const table = await annualTable()
    const jul = rowFor(table, 'Jul').querySelectorAll('td')
    expect(jul[2]).toHaveTextContent('€3,200.00')
    expect(jul[3]).toHaveTextContent('+€200.00')
    expect(jul[3]).toHaveClass('text-emerald-600')
    const jun = rowFor(table, 'Jun').querySelectorAll('td')
    expect(jun[3]).toHaveTextContent('-€50.00')
    expect(jun[3]).toHaveClass('text-rose-600')
    // August: no budget, but €80 received and €120 spent were recorded.
    const aug = rowFor(table, 'Aug').querySelectorAll('td')
    expect(aug[1]).toHaveTextContent('—')
    expect(aug[2]).toHaveTextContent('€80.00')
    expect(aug[3]).toHaveTextContent('+€80.00')
    expect(aug[4]).toHaveTextContent('€120.00')
    expect(aug[5]).toHaveTextContent('-€40.00')
  })

  // RPT-041 — the yearly average card carries the Uncategorised group with a Review badge and
  // says what was refunded against a group over the year.
  it('lists Uncategorised and refunded amounts in the yearly averages (RPT-041)', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Housing', kind: 'Expense', total: 2800, refunds: 0, averagePerMonth: 1400 },
      { name: 'Food', kind: 'Expense', total: 1660, refunds: 40, averagePerMonth: 830 },
      { name: 'Uncategorised', kind: 'Uncategorised', total: 100, refunds: 0, averagePerMonth: 50 },
    ]
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026(2026, categories) } })
    renderPage()

    const food = await screen.findByLabelText('Average spending for Food', {}, W)
    expect(food).toHaveTextContent('€830.00/mo · €1,660.00 total · after €40.00 refunded')
    const loose = screen.getByLabelText('Average spending for Uncategorised')
    expect(within(loose).getByText('Review')).toBeInTheDocument()
    expect(loose).toHaveTextContent('€50.00/mo · €100.00 total')
    expect(within(screen.getByLabelText('Average spending for Housing')).queryByText('Review')).not.toBeInTheDocument()
  })

  // RPT-027 — brand-new empty account: the EmptyState copy, no hero, no error.
  it('shows the no-data empty state with its description copy (RPT-027)', T, async () => {
    wire({ trends: { points: [], totalIncome: 0, totalIncomeReceived: 0, totalSpent: 0 } })
    renderPage()

    expect(await screen.findByText('No budget data yet', {}, W)).toBeInTheDocument()
    expect(screen.getByText(/your trends will appear here/)).toBeInTheDocument()
    expect(screen.queryByText('Saved this month')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // RPT-028 — trends failure shows the single error banner in place of all content.
  it('shows the error banner (and not the empty state) when trends fail (RPT-028)', T, async () => {
    mockGet.mockImplementation((url?: string) => {
      if (url?.startsWith('/reports/trends')) return Promise.reject(new Error('500'))
      return Promise.resolve({ data: {} })
    })
    renderPage()

    const alert = await screen.findByRole('alert', {}, W)
    expect(alert).toHaveTextContent('Could not load your reports.')
    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved this month')).not.toBeInTheDocument()
  })

  // RPT-029 — a failed breakdown refetch is swallowed: no banner, the select
  // moves, but the previous month's rows stay on screen (stale).
  it('swallows a breakdown fetch failure and keeps the previous month (RPT-029)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: annual2026() },
      rejectMonthUrls: ['/reports/month/2026/5'],
    })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByLabelText('Spending for Housing', {}, W)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Breakdown month'), '2026-05')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/month/2026/5'), W)

    // No error banner; the select shows May; June's rows persist (setBreakdownMonth
    // only ran on success).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect((screen.getByLabelText('Breakdown month') as HTMLSelectElement).value).toBe('2026-05')
    expect(screen.getByLabelText('Spending for Emergency Fund')).toBeInTheDocument()
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 58%')
  })

  // RPT-030 — a failed annual refetch is swallowed: no banner and the table
  // keeps the last successfully-loaded year's data.
  it('swallows an annual fetch failure and keeps the last-loaded year (RPT-030)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: annual2026() },
      rejectAnnualYears: [2025],
    })
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable()
    expect(rowFor(table, 'Jun')).toHaveTextContent('€2,400.00')

    await user.click(screen.getByLabelText('Previous year'))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2025'), W)

    // No banner, and the annual table still shows 2026's data (the last success).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const stillTable = screen.getByRole('table')
    expect(rowFor(stillTable, 'Jun')).toHaveTextContent('€2,400.00')
    expect(rowFor(stillTable, 'Total')).toHaveTextContent('€6,000.00')
  })

  // RPT-035 — the whole page formats in the breakdown month's currency; picking
  // a GBP month re-labels every card (hero, trend, annual) into £.
  it('formats the whole page in the breakdown month currency (RPT-035)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown('EUR'), '2026-5': mayBreakdown('GBP') },
      annuals: { 2026: annual2026() },
    })
    const user = userEvent.setup()
    renderPage()

    // First paint: EUR (June breakdown / fallback).
    expect(await screen.findByLabelText('Saved this month: €550.00', {}, W)).toBeInTheDocument()
    expect((await annualTable()).textContent).toContain('€6,000.00')

    // Switch to the GBP month → every card re-labels to £.
    await user.selectOptions(screen.getByLabelText('Breakdown month'), '2026-05')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/month/2026/5'), W)

    expect(await screen.findByLabelText('Saved this month: £550.00', {}, W)).toBeInTheDocument()
    expect(screen.getByTitle('Income £2,950.00')).toBeInTheDocument() // trend tooltip
    expect(screen.getByRole('table').textContent).toContain('£6,000.00') // annual totals
  })

  // RPT-037 — a blank current month for a jar household: planned>0 but income 0.
  // Hero saved 0 / rate 0%, no empty state, and the annual row is emerald €0.00.
  it('reports a blank jar month as zero-saved, not empty (RPT-037)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [{ year: 2026, month: 7, key: '2026-07', income: 0, incomeReceived: 0, planned: 300, spent: 0 }],
      totalIncome: 0,
      totalIncomeReceived: 0,
      totalSpent: 0,
    }
    const july: AnnualSummaryDto = {
      year: 2026,
      months: Array.from({ length: 12 }, (_, i) => annualMonth(i + 1, i + 1 === 7, 0, 0, i + 1 === 7 ? 300 : 0)),
      totalIncome: 0,
      totalIncomeReceived: 0,
      totalVariance: 0,
      totalPlanned: 300,
      totalSpent: 0,
      budgetedMonths: 1,
      categories: [{ name: 'Emergency Fund', kind: 'Savings', total: 0, averagePerMonth: 0 }],
    }
    wire({ trends, months: { '2026-7': emptyMonth(2026, 7) }, annuals: { 2026: july } })
    renderPage()

    // Hero: saved €0.00, rate 0% — and definitely NOT the empty state.
    expect(await screen.findByLabelText('Saved this month: €0.00', {}, W)).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()

    // Annual July row: has a budget, Net €0.00 shown emerald (net ≥ 0), not dashed.
    const table = await annualTable()
    const julCells = rowFor(table, 'Jul').querySelectorAll('td')
    expect(julCells[5]).toHaveTextContent('€0.00')
    expect(julCells[5]).toHaveClass('text-emerald-600')
  })
})
