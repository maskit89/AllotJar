// Catalog-driven Reports tests (docs/testing/cases/18-reports.md, prefix RPT).
//
// They assert the computed money and copy: hero figures
// (saved / avg / rate), the received-vs-budgeted income split, share %,
// annual rows + totals + sign colours, the (Name,Kind) keying, the swallowed
// partial-failure paths, the currency-follows-breakdown behaviour, and the
// empty / error surfaces. Fixtures follow the catalog's "H2" baseline exactly.
//
// The page (restyle PR 7): a KPI row, then the Trend card (the year's months as a chart or, on its
// Table side, the old annual overview with the year's averages per category under it), the Spending
// card (the chosen month's groups, with an average month's tick) and the Jar spending card. Headings
// are looked up by exact name (a string name in Testing Library's role queries matches the whole
// name, so "Spending" never finds "Jar spending"). A table on a Table side is
// `hidden` until Table is pressed, and role queries leave hidden elements out, so the tests press it.
// Today is pinned to 15 October 2026 (src/test/setup.ts): no H2 month is the month in progress.
//
// Determinism notes: every mock resolves synchronously; async waits carry an
// explicit 5s timeout; the api mock answers /reports/trends, /reports/month/{y}/{m}
// (the W12 month report: non-income groups net of refunds plus an Uncategorised row,
// with a categories[] array so the breakdown memo never dereferences undefined)
// AND /reports/annual/{year}, plus a catch-all for /auth/me.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AnnualMonthDto,
  AnnualSummaryDto,
  BudgetTrendsDto,
  AnnualCategoryDto,
  MonthReportCategoryDto,
  MonthReportDto,
} from '../types'

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

// Spy on analytics `track` while keeping the real EVENTS map (report_viewed etc.).
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: mockTrack,
}))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ReportsPage } from './ReportsPage'

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
function annualMonth(mo: number, hasBudget: boolean, income = 0, spent = 0, planned = 0, received = income): AnnualMonthDto {
  return {
    month: mo, key: `2026-${String(mo).padStart(2, '0')}`, hasBudget,
    income, incomeReceived: received, variance: received - income, planned, spent,
  }
}

const H2_CATEGORIES: AnnualCategoryDto[] = [
  { name: 'Housing', kind: 'Expense', total: 2800, averagePerMonth: 1400 },
  { name: 'Food', kind: 'Expense', total: 1700, averagePerMonth: 850 },
  { name: 'Emergency Fund', kind: 'Savings', total: 600, averagePerMonth: 300 },
]

// H2 annual 2026: May + June budgeted; Budgeted income 3000 next to the 2900/2950 received (rule 41).
function annual2026(
  year = 2026,
  categories?: AnnualCategoryDto[],
  budgetedMonths = 2,
  countedMonths = budgetedMonths,
): AnnualSummaryDto {
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
    countedMonths,
    categories: categories ?? H2_CATEGORIES,
  }
}

/** A year with only the given months filled in (the rest blank), its totals summed from them. */
function annualOf(year: number, filled: AnnualMonthDto[], categories: AnnualCategoryDto[] = [], budgetedMonths?: number): AnnualSummaryDto {
  const months = Array.from({ length: 12 }, (_, i) => filled.find((m) => m.month === i + 1) ?? annualMonth(i + 1, false))
  const sum = (f: (m: AnnualMonthDto) => number) => months.reduce((s, m) => s + f(m), 0)
  const budgeted = budgetedMonths ?? months.filter((m) => m.hasBudget).length
  return {
    year,
    months,
    totalIncome: sum((m) => m.income),
    totalIncomeReceived: sum((m) => m.incomeReceived),
    totalVariance: sum((m) => m.variance),
    totalPlanned: sum((m) => m.planned),
    totalSpent: sum((m) => m.spent),
    budgetedMonths: budgeted,
    countedMonths: budgeted,
    categories,
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

    // The Jar spending card (5 October 2026): an empty report keeps the card off the page.
    const jMatch = url?.match(/^\/reports\/jars\/(\d+)$/)
    if (jMatch) return Promise.resolve({ data: { year: Number(jMatch[1]), jars: [], waitingCount: 0 } })

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

const renderPage = () => renderWithProviders(<ReportsPage />)

const T = { timeout: 15000 }
const W = { timeout: 5000 }

type User = ReturnType<typeof userEvent.setup>

/** A card (its <section>) by its h2, looked up by exact name. */
async function findCard(name: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { level: 2, name }, W)).closest('section') as HTMLElement
}

/** The Trend chart (a role="img" figure that says every drawn month's figures), once the year has loaded. */
function findChart(year = 2026) {
  return screen.findByRole('img', { name: new RegExp(`^Spent each month against income received, ${year}: `) }, W)
}

/** Shows the Trend card's Table side and returns the year's months table, once it has rendered. */
async function annualTable(user: User, year = 2026): Promise<HTMLElement> {
  const trend = await findCard('Trend')
  const table = within(trend).getByRole('button', { name: 'Table' })
  if (table.getAttribute('aria-pressed') !== 'true') await user.click(table)
  return within(trend).findByRole('table', { name: `Income and spending in ${year}` }, W)
}
function rowFor(table: HTMLElement, monthLabel: string): HTMLElement {
  return within(table).getByText(monthLabel).closest('tr') as HTMLElement
}
/** A months-table row's figures (the month is the row's header cell, not one of these), in the
 *  mock-up's order (Received, Spent, Net), then Budgeted and its Variance. */
function cells(row: HTMLElement) {
  const [received, spent, net, budgeted, variance] = Array.from(row.querySelectorAll('td'))
  return { budgeted, received, variance, spent, net }
}
/** The year's averages table on the Trend card's Table side. */
async function averagesTable(user: User): Promise<HTMLElement> {
  await annualTable(user)
  return screen.findByRole('table', { name: 'Average month by category' }, W)
}
/** The averages table's category rows (its body rows), each named by its cells. */
function averageRows(table: HTMLElement): HTMLElement[] {
  return within(table)
    .getAllByRole('row')
    .filter((r) => r.closest('tbody'))
}
/** A category row's name: its row header's first text (the jars / Review mark follows it). */
const categoryOf = (row: HTMLElement) => within(row).getByRole('rowheader').firstChild?.textContent
/** Every averages row for a category name (a name can be both an Expense and a Savings group). */
const averageRowsFor = (table: HTMLElement, name: string) => averageRows(table).filter((r) => categoryOf(r) === name)
/** The one averages row for a category name. */
function averageRow(table: HTMLElement, name: string): HTMLElement {
  const rows = averageRowsFor(table, name)
  expect(rows).toHaveLength(1)
  return rows[0]
}
/** An average row's figures: the average month and the year's total. */
function averageCells(row: HTMLElement) {
  const [average, year] = Array.from(row.querySelectorAll('td'))
  return { average, year }
}
/** The text of an (i), opened as a pointer would (it renders only while open). */
async function hintText(user: User, name: string): Promise<string> {
  await user.hover(screen.getByRole('button', { name }))
  return (await screen.findByRole('tooltip', {}, W)).textContent ?? ''
}
/** A Spending row's bar (its fill) and its average month's tick, if any. */
function barOf(row: HTMLElement) {
  return row.querySelector<HTMLElement>('[data-bar-fill]')!
}
function tickOf(row: HTMLElement) {
  return row.querySelector<HTMLElement>('[data-tick]')
}

describe('ReportsPage — catalog (RPT)', () => {
  beforeEach(() => {
    resetApiMocks()
    mockTrack.mockReset()
  })

  // RPT-001, RPT-010 — page loads with the AppShell title, the KPI row and the cards in order; the
  // client always requests the 6 most-recent budgets.
  it('renders the KPI row and the cards in order (RPT-001, RPT-010)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    // The hero's label, the card headings, no error banner, no empty state.
    expect(await screen.findByText('Saved this month', {}, W)).toBeInTheDocument()
    // The top bar shows the page title as the screen's <h1>.
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()

    // The chart, the months table and the averages depend on the (separate) annual fetch.
    await findChart()

    // The cards' headings sit directly under the <h1> (no level skipped), in the documented order
    // (no jars here, so no Jar spending card).
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2s).toEqual(['Trend', 'Spending'])
    // The old annual overview and its averages are on the Trend card's Table side.
    expect(await annualTable(user)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Average month by category' })).toBeInTheDocument()

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
    expect(screen.queryByRole('heading', { name: 'Trend' })).not.toBeInTheDocument()
    expect(screen.queryByText('Trend')).not.toBeInTheDocument()
    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // The Trend card shows its heading as soon as the window has loaded, before the year answers
  // (the mocked e2e's loading test releases only the trends call).
  it('shows the Trend heading before the year has loaded', T, async () => {
    mockGet.mockImplementation((url?: string) => {
      if (url?.startsWith('/reports/trends')) return Promise.resolve({ data: h2Trends() })
      if (url?.startsWith('/reports/annual/')) return new Promise(() => {}) // never resolves
      if (url?.startsWith('/reports/month/')) return Promise.resolve({ data: juneBreakdown() })
      return Promise.resolve({ data: {} })
    })
    renderPage()

    expect(await screen.findByRole('heading', { level: 2, name: 'Trend' }, W)).toBeInTheDocument()
    // The year switcher shows the window's year; no chart and no table yet.
    expect(within(screen.getByRole('group', { name: 'Year' })).getByText('2026')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /^Spent each month/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
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

  // The KPI tiles' (i)s say what each figure covers: the latest month (a past one here, so no
  // "so far"), and the window's months for the average.
  it('says in the KPI (i)s which months each figure covers', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()
    await screen.findByLabelText('Saved this month: €550.00', {}, W)

    // The hero's sub-line names the month when it is not this one.
    expect(screen.getByText('€2,400.00 spent in June')).toBeInTheDocument()
    expect(await hintText(user, 'About saved this month')).toBe(
      'Income received in June minus what you spent, refunds taken off. June is the latest month with a budget.',
    )
    await user.unhover(screen.getByRole('button', { name: 'About saved this month' }))
    expect(await hintText(user, 'About avg monthly spend')).toBe('Average spent per month over May–Jun 2026 (2 months).')
    await user.unhover(screen.getByRole('button', { name: 'About avg monthly spend' }))
    expect(await hintText(user, 'About savings rate')).toBe('The share of June’s income you didn’t spend.')
  })

  // RPT-006 — the chart's key, one column per month with its figures, and no month emphasised when
  // none is the month in progress (it moved from "the last column" to "the month in progress").
  it('draws a column per month and says every figure in the chart text (RPT-006)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const chart = await findChart()
    // The figures the old bar tooltips gave (received income and the actual spend), per month.
    expect(chart).toHaveAccessibleName(
      'Spent each month against income received, 2026: May €2,700.00 spent, €2,900.00 income; Jun €2,400.00 spent, €2,950.00 income',
    )
    // A bar per month, labelled under it; the line's label gives the latest month's income.
    expect(chart.querySelectorAll('[data-bar]')).toHaveLength(2)
    expect(chart.querySelector('[data-bar="5"]')).not.toBeNull()
    expect(chart.querySelector('[data-bar="6"]')).not.toBeNull()
    expect(within(chart).getByText('Income €2,950.00')).toBeInTheDocument()
    expect(within(chart).getByText('May').parentElement).toHaveClass('text-slate-500')
    expect(within(chart).getByText('Jun').parentElement).toHaveClass('text-slate-500')
    expect(within(chart).queryByText('so far')).not.toBeInTheDocument()

    // The legend's meaning is in the card's (i).
    const hint = await hintText(user, 'About trend')
    expect(hint).toContain('What you spent each month against the income you received (the dashed line).')
    expect(hint).toContain('Table shows the exact figures and what you budgeted.')
  })

  // RPT-007, RPT-015 — the income line plots received income, but the axis covers the (undrawn)
  // budgeted income too; the table shows the budgeted and the received income side by side with
  // their Variance (rule 41).
  it('plots received income on an axis that covers the budgeted income (RPT-007, RPT-015)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    // Received (2,950) drawn against the axis top 3,000 (the budgeted income) → 98.33%, never 100%.
    const chart = await findChart()
    expect(within(chart).getByText('€3k')).toBeInTheDocument()
    expect(chart.querySelector<HTMLElement>('[data-income~="6"]')!.style.bottom).toBe('98.33%')
    expect(chart.querySelector<HTMLElement>('[data-income~="5"]')!.style.bottom).toBe('96.67%')
    // Spent bars on the same axis: 2,400 → 80%, 2,700 → 90%.
    expect(chart.querySelector<HTMLElement>('[data-bar="6"]')!.style.height).toBe('80%')
    expect(chart.querySelector<HTMLElement>('[data-bar="5"]')!.style.height).toBe('90%')

    // Same June in the table: Budgeted 3,000 | Received 2,950 | Variance −50 | Spent 2,400 | Net 550.
    const table = await annualTable(user)
    const june = cells(rowFor(table, 'Jun'))
    expect(june.budgeted).toHaveTextContent('€3,000.00')
    expect(june.received).toHaveTextContent('€2,950.00')
    expect(june.variance).toHaveTextContent('-€50.00')
    expect(june.spent).toHaveTextContent('€2,400.00')
    expect(june.net).toHaveTextContent('€550.00') // net = received 2,950 − spent 2,400
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
    const year = annualOf(2026, [annualMonth(5, true, 0, 0, 0, 4000), annualMonth(6, true, 0, 5, 5, 0)])
    wire({ trends, months: { '2026-6': emptyMonth(2026, 6) }, annuals: { 2026: year } })
    renderPage()

    const chart = await findChart()
    // Spent €5 against the axis top 4,000 → 0.125% clamped up to a visible 2% sliver.
    expect(chart.querySelector<HTMLElement>('[data-bar="6"]')!.style.height).toBe('2%')
    // Nothing spent in May → truly 0% (no bar).
    expect(chart.querySelector<HTMLElement>('[data-bar="5"]')!.style.height).toBe('0%')
    // Received €0 in June → the income line at 0%; May's 4,000 at the top.
    expect(chart.querySelector<HTMLElement>('[data-income~="6"]')!.style.bottom).toBe('0%')
    expect(chart.querySelector<HTMLElement>('[data-income~="5"]')!.style.bottom).toBe('100%')
  })

  // RPT-009, RPT-010 — the window is the most-recent N budgets, not the last N calendar months:
  // the Breakdown month select offers only those, newest first. The chart draws the year's months
  // from the first recorded one, so a gap reads as a month with nothing recorded (no bar).
  it('windows the most-recent budgets; a gap in the year draws no bar (RPT-009, RPT-010)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 1, key: '2026-01', income: 3000, incomeReceived: 3000, planned: 2000, spent: 2000 },
        { year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2950, planned: 2600, spent: 2400 },
      ],
      totalIncome: 6000,
      totalIncomeReceived: 5950,
      totalSpent: 4400,
    }
    const year = annualOf(2026, [annualMonth(1, true, 3000, 2000, 2000), annualMonth(6, true, 3000, 2400, 2600, 2950)])
    wire({ trends, months: { '2026-6': juneBreakdown() }, annuals: { 2026: year } })
    renderPage()

    // Bars for January and June only, chronological; February to May have none.
    const chart = await findChart()
    expect(Array.from(chart.querySelectorAll('[data-bar]')).map((b) => b.getAttribute('data-bar'))).toEqual(['1', '6'])
    expect(chart).toHaveAccessibleName(
      'Spent each month against income received, 2026: Jan €2,000.00 spent, €3,000.00 income; Feb nothing recorded; ' +
        'Mar nothing recorded; Apr nothing recorded; May nothing recorded; Jun €2,400.00 spent, €2,950.00 income',
    )

    // Breakdown select offers only those two, newest-first.
    const select = screen.getByLabelText('Breakdown month')
    const opts = within(select).getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['Jun 2026', 'Jan 2026'])

    expect(mockGet).toHaveBeenCalledWith('/reports/trends?months=6')
  })

  // RPT-011 — the months table's headers, month rows and totals footer.
  it('renders the months table rows and totals footer (RPT-011)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable(user)
    // Headers: the mock-up's Received | Spent | Net first (a phone shows them without a scroll),
    // then rule 41's Budgeted with the signed Variance beside it.
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Month', 'Received', 'Spent', 'Net', 'Budgeted', 'Variance',
    ])
    // May: 3,000 budgeted / 2,900 received / −100 / 2,700 spent / net 200.
    const may = cells(rowFor(table, 'May'))
    expect(may.budgeted).toHaveTextContent('€3,000.00')
    expect(may.received).toHaveTextContent('€2,900.00')
    expect(may.variance).toHaveTextContent('-€100.00')
    expect(may.spent).toHaveTextContent('€2,700.00')
    expect(may.net).toHaveTextContent('€200.00')
    // June: 3,000 / 2,950 / −50 / 2,400 / 550.
    const jun = cells(rowFor(table, 'Jun'))
    expect(jun.spent).toHaveTextContent('€2,400.00')
    expect(jun.net).toHaveTextContent('€550.00')
    // Footer: 6,000 / 5,850 / −150 / 5,100 / 750.
    const total = cells(rowFor(table, 'Total'))
    expect(total.budgeted).toHaveTextContent('€6,000.00')
    expect(total.received).toHaveTextContent('€5,850.00')
    expect(total.variance).toHaveTextContent('-€150.00')
    expect(total.spent).toHaveTextContent('€5,100.00')
    expect(total.net).toHaveTextContent('€750.00')
  })

  // RPT-012 — a month with nothing recorded shows em dashes and a muted row; Net is ok green /
  // bad red by sign. Months before the year's first recorded one are left out, so the blank month
  // checked is one inside the year's span (August, between July and September).
  it('dashes a month with nothing recorded and colours Net by sign (RPT-012)', T, async () => {
    const year = annual2026()
    year.months = year.months.map((m) =>
      m.month === 7 ? annualMonth(7, true, 3000, 3200, 3000) : m.month === 9 ? annualMonth(9, true, 3000, 1000, 2000) : m,
    )
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: year } })
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable(user)
    // The months before May are left out.
    expect(within(table).queryByText('Jan')).not.toBeInTheDocument()
    expect(within(table).queryByText('Apr')).not.toBeInTheDocument()
    // A month with nothing recorded: em dashes + muted row, Net not coloured.
    const aug = rowFor(table, 'Aug')
    expect(aug).toHaveClass('text-slate-500')
    const augCells = cells(aug)
    Object.values(augCells).forEach((c) => expect(c).toHaveTextContent('—'))
    expect(augCells.net).not.toHaveClass('text-ok')
    expect(augCells.net).not.toHaveClass('text-bad')

    // Positive net → ok green.
    expect(cells(rowFor(table, 'May')).net).toHaveClass('text-ok')
    // July spent 3,200 > received 3,000 → Net −€200.00 in bad red; a zero Variance is plain, not an error.
    const jul = cells(rowFor(table, 'Jul'))
    expect(jul.variance).toHaveTextContent('€0.00')
    expect(jul.variance).not.toHaveClass('text-bad')
    expect(jul.variance).not.toHaveClass('text-ok')
    expect(jul.net).toHaveTextContent('-€200.00')
    expect(jul.net).toHaveClass('text-bad')
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

    expect(await findChart(2026)).toBeInTheDocument()
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

  // RPT-014 — a year with nothing recorded: the chart says so, the table is its zero Total, and the
  // averages table disappears while the Trend and Spending cards stay.
  it('shows a zero Total and drops the averages for an empty year (RPT-014)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    expect(await averagesTable(user)).toBeInTheDocument()

    await user.click(screen.getByLabelText('Next year')) // 2027 → emptyAnnual fallback
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2027'), W)
    expect(await screen.findByText('2027', {}, W)).toBeInTheDocument()

    const table = await annualTable(user, 2027)
    const total = cells(rowFor(table, 'Total'))
    Object.values(total).forEach((c) => expect(c).toHaveTextContent('€0.00'))
    expect(within(table).getAllByRole('row')).toHaveLength(2) // the header and Total: no month rows

    // Averages gone; the Trend and Spending cards remain.
    await waitFor(() => expect(screen.queryByText('Average month by category')).not.toBeInTheDocument(), W)
    expect(screen.getByRole('heading', { level: 2, name: 'Trend' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Spending' })).toBeInTheDocument()

    // The chart side says the year has nothing to draw.
    await user.click(screen.getByRole('button', { name: 'Chart' }))
    expect(screen.getByText('Nothing recorded in 2027.')).toBeVisible()
  })

  // RPT-017 — the averages table: rows in the year's order, the average month and the year's total,
  // the jars mark (a Savings group), and the plural wording in its (i).
  it('lists per-category yearly averages with the plural wording and jars mark (RPT-017)', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const table = await averagesTable(user)
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Category', 'Average', 'Year'])
    // Plural wording for a 2-month year.
    expect(await hintText(user, 'About the averages')).toMatch(/averaged over 2 months of 2026, counting a month with no budget/)

    // The rows in the year's order, each named by its cells (the category, then its figures).
    expect(averageRows(table).map(categoryOf)).toEqual(['Housing', 'Food', 'Emergency Fund'])
    expect(within(table).getByRole('row', { name: /^Housing €1,400\.00 €2,800\.00$/ })).toBe(averageRow(table, 'Housing'))
    const housing = averageCells(averageRow(table, 'Housing'))
    expect(housing.average).toHaveTextContent('€1,400.00')
    expect(housing.year).toHaveTextContent('€2,800.00')
    const food = averageCells(averageRow(table, 'Food'))
    expect(food.average).toHaveTextContent('€850.00')
    expect(food.year).toHaveTextContent('€1,700.00')
    const fund = averageRow(table, 'Emergency Fund')
    expect(averageCells(fund).average).toHaveTextContent('€300.00')
    expect(averageCells(fund).year).toHaveTextContent('€600.00')
    expect(within(fund).getByText('jars')).toBeInTheDocument()
    // No row carries a label of its own any more: a row is named by its cells.
    averageRows(table).forEach((r) => expect(r).not.toHaveAttribute('aria-label'))
  })

  // RPT-018, RPT-036 — a single-month household: one column, one breakdown
  // option, avg = that month's spend, and singular wording.
  it('renders a single-month household with singular copy (RPT-018, RPT-036)', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [{ year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 2950, planned: 2600, spent: 2400 }],
      totalIncome: 3000,
      totalIncomeReceived: 2950,
      totalSpent: 2400,
    }
    const singleAnnual = annualOf(
      2026,
      [annualMonth(6, true, 3000, 2400, 2600, 2950)],
      [{ name: 'Housing', kind: 'Expense', total: 1400, averagePerMonth: 1400 }],
      1,
    )
    wire({ trends, months: { '2026-6': juneBreakdown() }, annuals: { 2026: singleAnnual } })
    const user = userEvent.setup()
    renderPage()

    // One column.
    const chart = await findChart()
    expect(chart.querySelectorAll('[data-bar]')).toHaveLength(1)
    expect(chart).toHaveAccessibleName('Spent each month against income received, 2026: Jun €2,400.00 spent, €2,950.00 income')

    // Avg monthly spend = round(2,400 / 1) = 2,400 (scoped to the KPI tile — €2,400.00 is also
    // June's actual spend in the months table).
    const avgTile = screen.getByText('Avg monthly spend').closest('div') as HTMLElement
    expect(within(avgTile).getByText('€2,400.00')).toBeInTheDocument()
    expect(await hintText(user, 'About avg monthly spend')).toBe('Average spent per month over Jun 2026 (1 month).')
    await user.unhover(screen.getByRole('button', { name: 'About avg monthly spend' }))

    // Exactly one breakdown option.
    const opts = within(screen.getByLabelText('Breakdown month')).getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['Jun 2026'])

    // Singular wording (the averages are on the Table side).
    await averagesTable(user)
    expect(await hintText(user, 'About the averages')).toMatch(/averaged over 1 month of 2026,/)
  })

  // D12 (review RP-P3-2): the averages count calendar months, a month with no budget included,
  // so the wording names the months the server divided by, not the budgeted ones.
  it('names the calendar months the averages divide by, a month with no budget included (D12)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: annual2026(2026, undefined, 2, 5) },
    })
    const user = userEvent.setup()
    renderPage()

    await averagesTable(user)
    const hint = await hintText(user, 'About the averages')
    expect(hint).toMatch(/averaged over 5 months of 2026, counting a month with no budget as a month too\./)
    expect(hint).not.toMatch(/budgeted months/)
    expect(screen.queryByText(/budgeted months/)).not.toBeInTheDocument()
  })

  it('falls back to the budgeted months from a server that sends no counted months (D12)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: { ...annual2026(2026, undefined, 2, 5), countedMonths: undefined } },
    })
    const user = userEvent.setup()
    renderPage()

    await averagesTable(user)
    expect(await hintText(user, 'About the averages')).toMatch(/averaged over 2 months of 2026,/)
  })

  // RPT-019 — categories keyed by (Name, Kind): same-name kinds render as
  // separate rows and only the Savings one gets the jars mark.
  it('keys average categories by (Name, Kind) so same-name kinds separate (RPT-019)', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Food', kind: 'Expense', total: 900, averagePerMonth: 300 },
      { name: 'Food', kind: 'Savings', total: 600, averagePerMonth: 200 },
      { name: 'Groceries', kind: 'Expense', total: 300, averagePerMonth: 100 },
    ]
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026(2026, categories) } })
    const user = userEvent.setup()
    renderPage()

    const table = await averagesTable(user)
    // Two distinct 'Food' rows (Expense + Savings) plus the renamed 'Groceries'.
    const foods = averageRowsFor(table, 'Food')
    expect(foods).toHaveLength(2)
    expect(averageRow(table, 'Groceries')).toBeInTheDocument()
    // Exactly one of the two Food rows (the Savings one) carries the jars mark.
    const foodWithJars = foods.filter((r) => within(r).queryByText('jars'))
    expect(foodWithJars).toHaveLength(1)
    expect(averageCells(foodWithJars[0]).average).toHaveTextContent('€200.00')
  })

  // RPT-020 — the breakdown defaults to the latest month, biggest first, share % + bars, the jars
  // mark on a Savings group, income excluded.
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
    // A Savings group: the jars it holds paid for this.
    expect(within(fund).getByText('jars')).toBeInTheDocument()
    // The share sits on the amount's line, after it (no column of its own beside the bar).
    expect(within(housing).getByText('· 58%').parentElement).toHaveTextContent(/^€1,400\.00 · 58%$/)

    // Bars share one scale: the largest of the spends and the average months (Housing's €1,400)
    // takes 96% of the track, the rest in proportion (Food €700 → 48%).
    await waitFor(() => expect(tickOf(housing)).not.toBeNull(), W)
    expect(barOf(housing).style.width).toBe('96%')
    expect(barOf(screen.getByLabelText('Spending for Food')).style.width).toBe('48%')

    // Income group excluded.
    expect(screen.queryByLabelText('Spending for Income')).not.toBeInTheDocument()
  })

  // The average month's tick (rule: only where the year shown has that group's average): placed on
  // the bars' scale, named for assistive tech, matched by (name, kind), and only while the year shown
  // is the breakdown month's year.
  it('ticks an average month on a group bar only for the same group and year', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Housing', kind: 'Expense', total: 2800, averagePerMonth: 1400 },
      { name: 'Food', kind: 'Savings', total: 1700, averagePerMonth: 850 }, // same name, another kind
      { name: 'Emergency Fund', kind: 'Savings', total: 600, averagePerMonth: 300 },
    ]
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: annual2026(2026, categories), 2025: annual2026(2025) },
    })
    const user = userEvent.setup()
    renderPage()

    const housing = await screen.findByLabelText('Spending for Housing', {}, W)
    await waitFor(() => expect(tickOf(housing)).not.toBeNull(), W)
    // Housing: the average €1,400 sits where Housing's own €1,400 bar ends (96%).
    expect(tickOf(housing)!.style.left).toBe('96%')
    expect(within(housing).getByText('An average month: €1,400.00')).toHaveClass('sr-only')
    // Emergency Fund: €300 of the 1,400 / 0.96 scale → 20.57%.
    const fund = screen.getByLabelText('Spending for Emergency Fund')
    expect(tickOf(fund)!.style.left).toBe('20.57%')
    expect(fund).toHaveTextContent('An average month: €300.00')
    // Food (an Expense group this month) has no Expense average in the year: no tick.
    expect(tickOf(screen.getByLabelText('Spending for Food'))).toBeNull()
    expect(await hintText(user, 'About spending')).toContain('The tick marks an average month of 2026.')
    await user.unhover(screen.getByRole('button', { name: 'About spending' }))

    // The year switcher moves the year away from June 2026: the ticks go, the month stays.
    await user.click(screen.getByRole('button', { name: 'Previous year' }))
    await findChart(2025)
    expect(screen.queryAllByText(/^An average month:/)).toHaveLength(0)
    expect(document.querySelectorAll('[data-tick]')).toHaveLength(0)
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 58%')
    // With no ticks, the longest bar takes 96% of the track.
    expect(barOf(screen.getByLabelText('Spending for Housing')).style.width).toBe('96%')
    expect(await hintText(user, 'About spending')).not.toContain('tick')
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
    // Utilities is shown last, as a negative figure explained by its refunds, with no share % and no bar.
    const utilities = screen.getByLabelText('Spending for Utilities')
    expect(utilities).toHaveTextContent('-€50.00 · after €120.00 refunded')
    expect(utilities).not.toHaveTextContent('%')
    expect(barOf(utilities).style.width).toBe('0%')
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
  // total and the shares, flagged with the dashed Assign chip that leads to the register.
  it('lists uncategorised spending as its own row with the Assign link (RPT-038)', T, async () => {
    const withLoose = month(2026, 6, 'EUR', [cat('house6', 'Housing', 'Expense', 1400), uncategorised(100, 2)])
    wire({ trends: h2Trends(), months: { '2026-6': withLoose }, annuals: { 2026: annual2026() } })
    renderPage()

    const loose = await screen.findByLabelText('Spending for Uncategorised', {}, W)
    // 100 of a 1,500 total → 7%; Housing 93%.
    expect(loose).toHaveTextContent('€100.00 · 7%')
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 93%')
    // The chip shows "Assign 2"; its name starts with that and keeps the old link's name.
    const review = within(loose).getByRole('link', { name: 'Assign 2, review uncategorised transactions' })
    expect(review).toHaveAccessibleName(/review uncategorised transactions$/)
    expect(review).toHaveTextContent('Assign 2')
    expect(review).toHaveAttribute('href', '/transactions')
    // It is the last row, after the groups, and its bar is hatched (no hue of its own).
    expect(screen.getAllByLabelText(/^Spending for /).at(-1)).toBe(loose)
    expect(barOf(loose).style.background).toContain('repeating-linear-gradient')
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

  // RPT-040 — rule 41 in the months table: Received next to Budgeted with a signed Variance
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
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable(user)
    const jul = cells(rowFor(table, 'Jul'))
    expect(jul.received).toHaveTextContent('€3,200.00')
    expect(jul.variance).toHaveTextContent('+€200.00')
    expect(jul.variance).toHaveClass('text-ok')
    const jun = cells(rowFor(table, 'Jun'))
    expect(jun.variance).toHaveTextContent('-€50.00')
    expect(jun.variance).toHaveClass('text-bad')
    // August: no budget, but €80 received and €120 spent were recorded.
    const augRow = rowFor(table, 'Aug')
    expect(augRow).toHaveClass('text-slate-500')
    const aug = cells(augRow)
    expect(aug.budgeted).toHaveTextContent('—')
    expect(aug.received).toHaveTextContent('€80.00')
    expect(aug.variance).toHaveTextContent('+€80.00')
    expect(aug.spent).toHaveTextContent('€120.00')
    expect(aug.net).toHaveTextContent('-€40.00')
    expect(aug.net).toHaveClass('text-bad')
  })

  // RPT-041 — the yearly averages carry the Uncategorised group with a Review mark and say what
  // was refunded against a group over the year.
  it('lists Uncategorised and refunded amounts in the yearly averages (RPT-041)', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Housing', kind: 'Expense', total: 2800, refunds: 0, averagePerMonth: 1400 },
      { name: 'Food', kind: 'Expense', total: 1660, refunds: 40, averagePerMonth: 830 },
      { name: 'Uncategorised', kind: 'Uncategorised', total: 100, refunds: 0, averagePerMonth: 50 },
    ]
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026(2026, categories) } })
    const user = userEvent.setup()
    renderPage()

    const table = await averagesTable(user)
    const food = averageCells(averageRow(table, 'Food'))
    expect(food.average).toHaveTextContent('€830.00')
    expect(food.year).toHaveTextContent('€1,660.00')
    expect(food.year).toHaveTextContent('after €40.00 refunded')
    const loose = averageRow(table, 'Uncategorised')
    expect(within(loose).getByText('Review')).toBeInTheDocument()
    expect(averageCells(loose).average).toHaveTextContent('€50.00')
    expect(averageCells(loose).year).toHaveTextContent('€100.00')
    expect(within(averageRow(table, 'Housing')).queryByText('Review')).not.toBeInTheDocument()
    expect(averageRow(table, 'Housing')).not.toHaveTextContent('refunded')
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

    // No error banner; the select shows May; June's rows persist (setBreakdown
    // only ran on success).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect((screen.getByLabelText('Breakdown month') as HTMLSelectElement).value).toBe('2026-05')
    expect(screen.getByLabelText('Spending for Emergency Fund')).toBeInTheDocument()
    expect(screen.getByLabelText('Spending for Housing')).toHaveTextContent('€1,400.00 · 58%')
  })

  // RPT-030 — a failed annual refetch is swallowed: no banner, and the Trend card keeps the last
  // successfully-loaded year's figures and shows that year in its switcher.
  it('swallows an annual fetch failure and keeps the last-loaded year (RPT-030)', T, async () => {
    wire({
      trends: h2Trends(),
      months: { '2026-6': juneBreakdown() },
      annuals: { 2026: annual2026() },
      rejectAnnualYears: [2025],
    })
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable(user)
    expect(rowFor(table, 'Jun')).toHaveTextContent('€2,400.00')

    await user.click(screen.getByLabelText('Previous year'))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/annual/2025'), W)

    // No banner, and the table still shows 2026's data (the last success), under 2026.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const stillTable = screen.getByRole('table', { name: 'Income and spending in 2026' })
    expect(rowFor(stillTable, 'Jun')).toHaveTextContent('€2,400.00')
    expect(rowFor(stillTable, 'Total')).toHaveTextContent('€6,000.00')
    expect(within(screen.getByRole('group', { name: 'Year' })).getByText('2026')).toBeInTheDocument()
    expect(screen.queryByText('2025')).not.toBeInTheDocument()
  })

  // RPT-035 — the whole page formats in the breakdown month's currency; picking
  // a GBP month re-labels every card (hero, trend, table) into £.
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
    expect((await findChart()).getAttribute('aria-label')).toContain('€2,950.00 income')
    expect((await annualTable(user)).textContent).toContain('€6,000.00')

    // Switch to the GBP month → every card re-labels to £.
    await user.selectOptions(screen.getByLabelText('Breakdown month'), '2026-05')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/reports/month/2026/5'), W)

    expect(await screen.findByLabelText('Saved this month: £550.00', {}, W)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Income and spending in 2026' }).textContent).toContain('£6,000.00') // annual totals
    await user.click(screen.getByRole('button', { name: 'Chart' }))
    const chart = await findChart()
    expect(chart.getAttribute('aria-label')).toContain('Jun £2,400.00 spent, £2,950.00 income') // trend figures
    expect(within(chart).getByText('Income £2,950.00')).toBeInTheDocument()
    expect(within(chart).getByText('£3k')).toBeInTheDocument()
  })

  // RPT-037 — a blank current month for a jar household: planned>0 but income 0.
  // Hero saved 0 / rate 0%, no empty state, and the July row's Net is €0.00 in ok green.
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
    const user = userEvent.setup()
    renderPage()

    // Hero: saved €0.00, rate 0% — and definitely NOT the empty state.
    expect(await screen.findByLabelText('Saved this month: €0.00', {}, W)).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText('No budget data yet')).not.toBeInTheDocument()

    // July row: has a budget, Net €0.00 shown ok green (net ≥ 0), not dashed.
    const table = await annualTable(user)
    const jul = cells(rowFor(table, 'Jul'))
    expect(jul.net).toHaveTextContent('€0.00')
    expect(jul.net).toHaveClass('text-ok')
  })

  // Rows in another currency waiting for their budget-currency amount count in no figure; the
  // report says how many it left out: the window's in the average's (i), the chosen month's at the
  // Spending card's foot with the way to enter them (one visible link, no strip repeating it).
  it('counts the rows waiting for a budget-currency amount, for the window and the chosen month', T, async () => {
    const trends = h2Trends()
    trends.points[0].fxPendingCount = 2
    trends.points[1].fxPendingCount = 1
    wire({ trends, months: { '2026-6': { ...juneBreakdown(), fxPendingCount: 1 } }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    // One note on the page: the month's, at the Spending card's foot, its sentence in the card's (i).
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1), W)
    const monthNote = screen.getByRole('status')
    expect(within(await findCard('Spending')).getByRole('status')).toBe(monthNote)
    expect(monthNote).toHaveTextContent('Not counted yet')
    expect(monthNote).toHaveTextContent('1 payment')
    expect(monthNote).not.toHaveTextContent('1 payments')
    const add = within(monthNote).getByRole('link', { name: 'Add the € amount on Transactions' })
    expect(add).toHaveTextContent('€ amount')
    expect(add).toHaveAttribute('href', '/transactions')
    expect(await hintText(user, 'About spending')).toContain(
      'Payments in another currency aren’t counted until they have their amount in EUR.',
    )
    // The window's count (all six months' figures) in the average's (i).
    await user.unhover(screen.getByRole('button', { name: 'About spending' }))
    expect(await hintText(user, 'About avg monthly spend')).toContain('3 payments in another currency aren’t counted yet.')
    // Said once on the screen: only in the open (i), no strip repeating it.
    expect(screen.getAllByText(/in another currency aren’t counted yet/)).toHaveLength(1)
  })

  it('says one waiting payment in the singular', T, async () => {
    const trends = h2Trends()
    trends.points[1].fxPendingCount = 1
    wire({ trends, months: { '2026-6': { ...juneBreakdown(), fxPendingCount: 1 } }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const note = await screen.findByRole('status', {}, W)
    expect(note).toHaveTextContent('1 payment')
    expect(within(note).getByRole('link', { name: 'Add the € amount on Transactions' })).toHaveAttribute('href', '/transactions')
    expect(await hintText(user, 'About avg monthly spend')).toContain('1 payment in another currency isn’t counted yet.')
  })

  it('says nothing about waiting rows when there are none', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    renderPage()
    await screen.findByText('Saved this month', {}, W)
    await screen.findByLabelText('Spending for Housing', {}, W)
    expect(screen.getByRole('heading', { level: 2, name: 'Spending' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/counted yet/)).not.toBeInTheDocument()
  })

  // --- new behaviour (restyle PR 7) ---------------------------------------------------------

  // Chart | Table: one switch, the chart by default; both sides show the same months; no event.
  it('switches the Trend card between the chart and the table of the same months', T, async () => {
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const trend = await findCard('Trend')
    await findChart()
    const show = within(trend).getByRole('group', { name: 'Show as' })
    const chartBtn = within(show).getByRole('button', { name: 'Chart' })
    const tableBtn = within(show).getByRole('button', { name: 'Table' })
    expect(chartBtn).toHaveAttribute('aria-pressed', 'true')
    expect(tableBtn).toHaveAttribute('aria-pressed', 'false')
    // The table is there but hidden: role queries leave it out.
    expect(within(trend).queryByRole('table')).not.toBeInTheDocument()
    const drawn = Array.from((await findChart()).querySelectorAll('[data-bar]')).map((b) => Number(b.getAttribute('data-bar')))

    await user.click(tableBtn)
    expect(tableBtn).toHaveAttribute('aria-pressed', 'true')
    expect(chartBtn).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('img', { name: /^Spent each month/ })).not.toBeInTheDocument()
    const table = within(trend).getByRole('table', { name: 'Income and spending in 2026' })
    // The same months, by name: May and June (the chart's bars 5 and 6).
    const rowHeads = within(table).getAllByRole('rowheader').map((h) => h.textContent)
    expect(rowHeads).toEqual(['May', 'Jun', 'Total'])
    expect(drawn).toEqual([5, 6])
    // Its scroll box takes focus (a phone scrolls the table sideways in it).
    expect(within(trend).getByRole('region', { name: 'Income and spending in 2026' })).toHaveAttribute('tabindex', '0')

    // By keyboard: Space on Chart brings the chart back.
    chartBtn.focus()
    await user.keyboard(' ')
    expect(chartBtn).toHaveAttribute('aria-pressed', 'true')
    expect(await findChart()).toBeVisible()
    // The switch is presentation only: no report_viewed event.
    expect(mockTrack).not.toHaveBeenCalled()
  })

  // The month in progress: hatched with "so far" in the chart, marked in the table, and the KPI
  // wording says "so far" (today pinned to 15 June 2026 here).
  it('hatches the month in progress and says "so far"', T, async () => {
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    const chart = await findChart()
    expect(chart).toHaveAccessibleName(
      'Spent each month against income received, 2026: May €2,700.00 spent, €2,900.00 income; ' +
        'Jun €2,400.00 spent so far, €2,950.00 income so far',
    )
    const june = chart.querySelector<HTMLElement>('[data-bar="6"]')!
    const may = chart.querySelector<HTMLElement>('[data-bar="5"]')!
    expect(june).toHaveTextContent('so far')
    expect(june).not.toHaveClass('bg-primary')
    expect(june.style.background).toContain('repeating-linear-gradient')
    expect(may).toHaveClass('bg-primary')
    expect(may).not.toHaveTextContent('so far')
    // The month in progress's label is the emphasised one (it was the last column's).
    expect(within(chart).getByText('Jun').parentElement).toHaveClass('text-slate-900')
    expect(within(chart).getByText('May').parentElement).toHaveClass('text-slate-500')
    expect(await hintText(user, 'About trend')).toContain('June is so far.')
    await user.unhover(screen.getByRole('button', { name: 'About trend' }))

    // KPI wording for the month in progress.
    expect(screen.getByText('€2,400.00 spent so far')).toBeInTheDocument()
    expect(await hintText(user, 'About saved this month')).toBe(
      'Income received this month minus what you’ve spent so far, refunds taken off.',
    )
    await user.unhover(screen.getByRole('button', { name: 'About saved this month' }))
    expect(await hintText(user, 'About avg monthly spend')).toBe('Average spent per month over May–Jun 2026 (2 months, June so far).')
    await user.unhover(screen.getByRole('button', { name: 'About avg monthly spend' }))
    expect(await hintText(user, 'About savings rate')).toBe('The share of this month’s income you haven’t spent so far.')
    await user.unhover(screen.getByRole('button', { name: 'About savings rate' }))

    // The table marks it too, muted as a month not yet over.
    const table = await annualTable(user)
    const junRow = rowFor(table, 'Jun')
    expect(within(junRow).getByRole('rowheader')).toHaveTextContent('Jun so far')
    expect(junRow).toHaveClass('text-slate-500')
    expect(rowFor(table, 'May')).toHaveClass('text-slate-900')
  })

  // The year switcher moves the chart and the table together, and says the year once.
  it('moves the chart and the table to the year chosen', T, async () => {
    const lastYear = annualOf(2025, [annualMonth(11, true, 2800, 2100, 2000), annualMonth(12, true, 2800, 2600, 2400, 3000)])
    wire({ trends: h2Trends(), months: { '2026-6': juneBreakdown() }, annuals: { 2025: lastYear, 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()

    await findChart(2026)
    const year = screen.getByRole('group', { name: 'Year' })
    expect(within(year).getByText('2026')).toBeInTheDocument()

    await user.click(within(year).getByRole('button', { name: 'Previous year' }))
    const chart = await findChart(2025)
    expect(chart).toHaveAccessibleName(
      'Spent each month against income received, 2025: Nov €2,100.00 spent, €2,800.00 income; Dec €2,600.00 spent, €3,000.00 income',
    )
    expect(within(year).getByText('2025')).toBeInTheDocument()
    const table = await annualTable(user, 2025)
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Nov', 'Dec', 'Total'])
    expect(cells(rowFor(table, 'Dec')).variance).toHaveTextContent('+€200.00')
    // Still on the Table side, the next year's table replaces it.
    await user.click(within(year).getByRole('button', { name: 'Next year' }))
    expect(await screen.findByRole('table', { name: 'Income and spending in 2026' }, W)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Income and spending in 2025' })).not.toBeInTheDocument()
  })

  // Keyboard: the page's controls in reading order, Trend before Spending; the (i)s are buttons,
  // the month is a native select, and the Table side's scroll boxes take focus.
  it('reaches every control in reading order by keyboard', T, async () => {
    const trends = h2Trends()
    const june = { ...month(2026, 6, 'EUR', [cat('house6', 'Housing', 'Expense', 1400), uncategorised(100, 2)]), fxPendingCount: 1 }
    wire({ trends, months: { '2026-6': june }, annuals: { 2026: annual2026() } })
    const user = userEvent.setup()
    renderPage()
    await findChart()
    await screen.findByLabelText('Spending for Uncategorised', {}, W)

    const order = [
      'About saved this month',
      'About avg monthly spend',
      'About savings rate',
      'About trend',
      'Chart',
      'Table',
      'Previous year',
      'Next year',
      'About spending',
      'Breakdown month',
      'Assign 2, review uncategorised transactions',
      'Add the € amount on Transactions',
    ]
    act(() => screen.getByRole('button', { name: order[0] }).focus())
    const reached = [order[0]]
    for (let i = 1; i < order.length; i++) {
      await user.tab()
      reached.push(document.activeElement?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement).textContent ?? '')
    }
    expect(reached).toEqual(order)

    // Table by keyboard (Enter), then the Table side's focusable scroll boxes and the averages' (i).
    act(() => screen.getByRole('button', { name: 'Table' }).focus())
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous year' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next year' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Income and spending in 2026' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'About the averages' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Average month by category, 2026' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'About spending' }))
  })
  // December, with next January's budget made ahead (the window's last point is next year's): the
  // Trend opens on the year of the latest month up to this one, which has the figures, not on an
  // empty next year. The breakdown still opens on the newest month, as it always has.
  it('opens on the latest month’s year when next January is budgeted ahead', T, async () => {
    vi.setSystemTime(new Date('2026-12-10T12:00:00Z'))
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 11, key: '2026-11', income: 3000, incomeReceived: 3000, planned: 2000, spent: 2100 },
        { year: 2026, month: 12, key: '2026-12', income: 3000, incomeReceived: 3000, planned: 2000, spent: 900 },
        { year: 2027, month: 1, key: '2027-01', income: 3000, incomeReceived: 0, planned: 2000, spent: 0 },
      ],
      totalIncome: 9000,
      totalIncomeReceived: 6000,
      totalSpent: 3000,
    }
    const year = annualOf(2026, [annualMonth(11, true, 3000, 2100, 2000), annualMonth(12, true, 3000, 900, 2000)])
    wire({ trends, annuals: { 2026: year } })
    renderPage()

    const chart = await findChart(2026)
    expect(Array.from(chart.querySelectorAll('[data-bar]')).map((b) => b.getAttribute('data-bar'))).toEqual(['11', '12'])
    expect(within(await findCard('Trend')).getByRole('group', { name: 'Year' })).toHaveTextContent('2026')
    expect(mockGet).toHaveBeenCalledWith('/reports/annual/2026')
    expect(mockGet).toHaveBeenCalledWith('/reports/jars/2026')
    expect(mockGet).not.toHaveBeenCalledWith('/reports/annual/2027')
    expect(screen.queryByText(/^Nothing recorded/)).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Breakdown month' })).toHaveValue('2027-01')
  })

  // A group's bar is never too thin to see (the old bars' 2% rule), and Uncategorised has no
  // average tick (the mock-up draws none there): its average stays in the averages table.
  it('gives a small group a visible sliver and Uncategorised no tick', T, async () => {
    const categories: AnnualCategoryDto[] = [
      { name: 'Housing', kind: 'Expense', total: 2800, averagePerMonth: 1400 },
      { name: 'Coffee', kind: 'Expense', total: 2, averagePerMonth: 1 },
      { name: 'Uncategorised', kind: 'Uncategorised', total: 100, refunds: 0, averagePerMonth: 50 },
    ]
    const june = month(2026, 6, 'EUR', [cat('house6', 'Housing', 'Expense', 1400), cat('coffee6', 'Coffee', 'Expense', 1), uncategorised(40, 1)])
    wire({ trends: h2Trends(), months: { '2026-6': june }, annuals: { 2026: annual2026(2026, categories) } })
    const user = userEvent.setup()
    renderPage()

    const housing = await screen.findByLabelText('Spending for Housing', {}, W)
    await waitFor(() => expect(tickOf(housing)).not.toBeNull(), W)
    // €1 beside €1,400 (0.07% of the track): drawn as a 2% sliver, its tick still there.
    const coffee = screen.getByLabelText('Spending for Coffee')
    expect(barOf(coffee).style.width).toBe('2%')
    expect(tickOf(coffee)).not.toBeNull()
    // Uncategorised: its bar on the same scale (€40 → 2.74%), and no tick though the year has its average.
    const loose = screen.getByLabelText('Spending for Uncategorised')
    expect(barOf(loose).style.width).toBe('2.74%')
    expect(tickOf(loose)).toBeNull()
    expect(loose).not.toHaveTextContent('An average month')
    const table = await averagesTable(user)
    expect(averageCells(averageRow(table, 'Uncategorised')).average).toHaveTextContent('€50.00')
  })

  // The month in progress is muted across its whole row, its signed figures too (they are not
  // final yet), and so is a month budgeted ahead; a finished month keeps its colours. Today is
  // pinned to 15 October 2026.
  it('mutes the month in progress throughout the table, its signed figures too', T, async () => {
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 9, key: '2026-09', income: 3000, incomeReceived: 3000, planned: 2000, spent: 2000 },
        { year: 2026, month: 10, key: '2026-10', income: 3000, incomeReceived: 0, planned: 2000, spent: 1000 },
      ],
      totalIncome: 6000,
      totalIncomeReceived: 3000,
      totalSpent: 3000,
    }
    const year = annualOf(2026, [
      annualMonth(9, true, 3000, 2000, 2000),
      annualMonth(10, true, 3000, 1000, 2000, 0),
      annualMonth(11, true, 3400, 0, 2000, 0),
    ])
    wire({ trends, annuals: { 2026: year } })
    const user = userEvent.setup()
    renderPage()

    const table = await annualTable(user)
    const oct = rowFor(table, 'Oct')
    expect(within(oct).getByRole('rowheader')).toHaveTextContent('Oct so far')
    expect(oct).toHaveClass('text-slate-500')
    const now = cells(oct)
    expect(now.net).toHaveTextContent('-€1,000.00')
    expect(now.net).not.toHaveClass('text-bad')
    expect(now.variance).toHaveTextContent('-€3,000.00')
    expect(now.variance).not.toHaveClass('text-bad')
    const sep = cells(rowFor(table, 'Sep'))
    expect(sep.net).toHaveTextContent('€1,000.00')
    expect(sep.net).toHaveClass('text-ok')
    // November is budgeted ahead: muted, not "so far", its Variance not coloured red.
    const nov = rowFor(table, 'Nov')
    expect(nov).toHaveClass('text-slate-500')
    expect(within(nov).getByRole('rowheader')).toHaveTextContent(/^Nov$/)
    expect(cells(nov).variance).toHaveTextContent('-€3,400.00')
    expect(cells(nov).variance).not.toHaveClass('text-bad')
    expect(cells(nov).net).not.toHaveClass('text-ok')
  })

  // The income line: one dashed stretch per run of months at the same level (the dashes run on
  // unbroken), a step where it changes; a gridline at the line's level keeps only its label, so
  // the dashes are not drawn over a solid line. The year shown is said when it changes.
  it('draws the income line in runs, off the gridlines, and says the year shown', T, async () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const trends: BudgetTrendsDto = {
      points: [
        { year: 2026, month: 4, key: '2026-04', income: 3000, incomeReceived: 2900, planned: 2000, spent: 2400 },
        { year: 2026, month: 5, key: '2026-05', income: 3000, incomeReceived: 3000, planned: 2000, spent: 3200 },
        { year: 2026, month: 6, key: '2026-06', income: 3000, incomeReceived: 3000, planned: 2000, spent: 1300 },
      ],
      totalIncome: 9000,
      totalIncomeReceived: 8900,
      totalSpent: 6900,
    }
    const year = annualOf(2026, [
      annualMonth(4, true, 3000, 2400, 2000, 2900),
      annualMonth(5, true, 3000, 3200, 2000),
      annualMonth(6, true, 3000, 1300, 2000),
    ])
    wire({ trends, annuals: { 2026: year } })
    renderPage()

    const chart = await findChart()
    expect(Array.from(chart.querySelectorAll('[data-income]')).map((l) => l.getAttribute('data-income'))).toEqual(['4', '5 6'])
    // The axis runs to €3.5k: the €3k gridline sits under May and June's line.
    expect(within(chart).getByText('€3k').parentElement).not.toHaveClass('border-t')
    expect(within(chart).getByText('€2k').parentElement).toHaveClass('border-t')
    // The year is a polite live region: a new year is said once it has loaded.
    const years = within(await findCard('Trend')).getByRole('group', { name: 'Year' })
    expect(within(years).getByText('2026')).toHaveAttribute('aria-live', 'polite')
  })
})
