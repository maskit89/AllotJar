// The Jar spending card on the Reports page (5 October 2026, from Christopher's jar notes:
// "how much I am actually spending from each jar monthly/yearly"). The server reads a draw from
// a jar exactly as the ledger does (rule 79); the page shows the year as one row per jar, the jars
// that paid most first, with a mark per month and a total (Chart), or a column per month with every
// exact figure (Table), and the Trend card's year switcher drives both.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnnualSummaryDto, BudgetTrendsDto, JarSpendingReportDto, MonthReportDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ReportsPage } from './ReportsPage'

const W = { timeout: 5000 }

const trends: BudgetTrendsDto = {
  points: [{ year: 2026, month: 3, key: '2026-03', income: 3000, incomeReceived: 3000, planned: 2400, spent: 2400 }],
  totalIncome: 3000,
  totalIncomeReceived: 3000,
  totalSpent: 2400,
}

const month = (year: number, mo: number): MonthReportDto => ({
  year, month: mo, key: `${year}-${String(mo).padStart(2, '0')}`, hasBudget: true, baseCurrency: 'EUR',
  incomeBudgeted: 3000, incomeReceived: 3000, incomeUncategorised: 0, variance: 0, planned: 2400,
  spentCategorised: 2400, spentUncategorised: 0, refunds: 0, spent: 2400, uncategorisedCount: 0,
  uncategorisedIncomeCount: 0, fxPendingCount: 0, categories: [],
})

/** A year with one budget, in March (the first month with anything recorded). */
const annual = (year: number): AnnualSummaryDto => ({
  year,
  months: Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, key: `${year}-${String(i + 1).padStart(2, '0')}`, hasBudget: i === 2,
    income: i === 2 ? 3000 : 0, incomeReceived: i === 2 ? 3000 : 0, variance: 0, planned: i === 2 ? 2400 : 0, spent: i === 2 ? 2400 : 0,
  })),
  totalIncome: 3000, totalIncomeReceived: 3000, totalVariance: 0, totalPlanned: 2400, totalSpent: 2400, budgetedMonths: 1, categories: [],
})

const twelve = (fill: Partial<Record<number, number>> = {}) => Array.from({ length: 12 }, (_, i) => fill[i + 1] ?? 0)

/** The vet bill: 50 paid from Pets in March after 30 was moved in from Food; Food spent nothing. */
function jars2026(): JarSpendingReportDto {
  return {
    year: 2026,
    jars: [
      { jarId: 'food', name: 'Food', currency: 'EUR', isArchived: false, months: twelve(), refunds: twelve(), total: 0, totalRefunds: 0 },
      { jarId: 'pets', name: 'Pets', currency: 'EUR', isArchived: false, months: twelve({ 3: 50 }), refunds: twelve(), total: 50, totalRefunds: 0 },
      { jarId: 'sofa', name: 'Old sofa', currency: 'EUR', isArchived: true, months: twelve({ 1: 400, 2: -20 }), refunds: twelve({ 2: 20 }), total: 380, totalRefunds: 20 },
    ],
    waitingCount: 0,
  }
}

function wire(jars: Record<number, JarSpendingReportDto | 'reject'>) {
  mockGet.mockImplementation((url?: string) => {
    if (url?.startsWith('/reports/trends')) return Promise.resolve({ data: trends })
    const m = url?.match(/^\/reports\/month\/(\d+)\/(\d+)$/)
    if (m) return Promise.resolve({ data: month(Number(m[1]), Number(m[2])) })
    const a = url?.match(/^\/reports\/annual\/(\d+)$/)
    if (a) return Promise.resolve({ data: annual(Number(a[1])) })
    const j = url?.match(/^\/reports\/jars\/(\d+)$/)
    if (j) {
      const provided = jars[Number(j[1])]
      if (provided === 'reject') return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: provided ?? { year: Number(j[1]), jars: [], waitingCount: 0 } })
    }
    return Promise.resolve({ data: {} })
  })
}

type User = ReturnType<typeof userEvent.setup>

/** The Jar spending card (its <section>), by its exact heading. */
async function findJarCard(): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { level: 2, name: 'Jar spending' }, W)).closest('section') as HTMLElement
}
/** Shows the card's Table side and returns its table of every jar's months. */
async function jarTable(user: User, year = 2026): Promise<HTMLElement> {
  const card = await findJarCard()
  await user.click(within(within(card).getByRole('group', { name: 'Show jars as' })).getByRole('button', { name: 'Table' }))
  return within(card).findByRole('table', { name: `Spending from jars in ${year}` }, W)
}
/** The text of an (i), opened as a pointer would (it renders only while open). */
async function hintText(user: User, name: string): Promise<string> {
  await user.hover(screen.getByRole('button', { name }))
  return (await screen.findByRole('tooltip', {}, W)).textContent ?? ''
}
/** A jar's row on the Chart side: its month marks (role="img", named with the figures) and the row. */
function marksOf(card: HTMLElement, name: string) {
  const marks = within(card).getByRole('img', { name: new RegExp(`^${name} paid out `) })
  return { marks, row: marks.parentElement as HTMLElement }
}

describe('ReportsPage — Jar spending', () => {
  beforeEach(() => resetApiMocks())

  it('lists each jar with the month it paid, the whole bill under the jar it was paid from', async () => {
    wire({ 2026: jars2026() })
    const user = userEvent.setup()
    renderWithProviders(<ReportsPage />)

    const card = await findJarCard()
    // The third card, under Trend and Spending.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Trend', 'Spending', 'Jar spending'])
    expect(await hintText(user, 'About jar spending')).toBe(
      'What each jar paid out in 2026, by the month it was paid. Money moved between jars is not spending.',
    )
    await user.unhover(screen.getByRole('button', { name: 'About jar spending' }))

    const table = await jarTable(user)
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Jar', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Total',
    ])
    const pets = within(table).getByRole('row', { name: /^Pets/ })
    const petsCells = within(pets).getAllByRole('cell')
    expect(petsCells[2]).toHaveTextContent('€50.00') // March
    expect(petsCells[0]).toHaveTextContent('—') // January: nothing paid reads as a dash
    expect(petsCells[12]).toHaveTextContent('€50.00') // Total

    // Food topped Pets up and spent nothing itself.
    const food = within(table).getByRole('row', { name: /^Food/ })
    expect(within(food).getAllByRole('cell')[12]).toHaveTextContent('—')

    // An archived jar stays listed while the year has a figure; a refund reduces its month and
    // the total says so.
    const sofa = within(table).getByRole('row', { name: /^Old sofa/ })
    expect(within(sofa).getByText('(archived)')).toBeInTheDocument()
    expect(within(sofa).getByRole('rowheader')).toHaveTextContent('Old sofa (archived)')
    const sofaCells = within(sofa).getAllByRole('cell')
    expect(sofaCells[1]).toHaveTextContent('-€20.00')
    expect(sofaCells[12]).toHaveTextContent('€380.00')
    expect(sofaCells[12]).toHaveTextContent('after €20.00 refunded')

    // The year total across the jars, one currency.
    const all = within(table).getByRole('row', { name: /^All jars/ })
    const allCells = within(all).getAllByRole('cell')
    expect(allCells[0]).toHaveTextContent('€400.00')
    expect(allCells[2]).toHaveTextContent('€50.00')
    expect(allCells[12]).toHaveTextContent('€430.00')
    expect(card).toContainElement(table)
  })

  // The Chart side (the default): the jars that paid most first, a mark per month paid, a total,
  // and a dash for a jar that paid nothing; every figure in the marks' text alternative.
  it('draws the jars that paid most first, with a mark for each month paid', async () => {
    wire({ 2026: jars2026() })
    const user = userEvent.setup()
    renderWithProviders(<ReportsPage />)

    const card = await findJarCard()
    const show = within(card).getByRole('group', { name: 'Show jars as' })
    expect(within(show).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(card).queryByRole('table')).not.toBeInTheDocument()

    // Sorted by the year's total: Old sofa €380, Pets €50, then Food (nothing); the server sent Food first.
    const named = within(card).getAllByRole('img', { name: / paid out / }).map((m) => m.getAttribute('aria-label'))
    expect(named).toEqual([
      'Old sofa paid out €400.00 in Jan, -€20.00 in Feb',
      'Pets paid out €50.00 in Mar',
      'Food paid out nothing in 2026',
    ])

    // Pets: one mark, March; the other months a flat line, none before the year's first record (March).
    const pets = marksOf(card, 'Pets')
    expect(Array.from(pets.marks.querySelectorAll('[data-paid]')).map((m) => m.getAttribute('data-paid'))).toEqual(['3'])
    expect(pets.marks.querySelector<HTMLElement>('[data-paid="3"]')!.style.height).toBe('13%') // 50 of the top 400
    expect(pets.marks.children[0]).toHaveClass('invisible') // January, before the first record
    expect(pets.marks.children[5]).not.toHaveClass('invisible') // June, a month with nothing paid
    expect(pets.row).toHaveTextContent('Pets€50.00')

    // Old sofa: the January mark is the tallest; February (refunded more than paid) draws no mark.
    const sofa = marksOf(card, 'Old sofa')
    expect(sofa.marks.querySelector<HTMLElement>('[data-paid="1"]')!.style.height).toBe('100%')
    expect(sofa.marks.querySelector('[data-paid="2"]')).toBeNull()
    expect(sofa.row).toHaveTextContent('Old sofa (archived)')
    expect(sofa.row).toHaveTextContent('€380.00 after €20.00 refunded')
    expect(sofa.row).toHaveClass('text-slate-500') // archived rows are muted

    // Food: nothing in the year → a dash, read as "Nothing", and no marks.
    const food = marksOf(card, 'Food')
    expect(food.marks.querySelectorAll('[data-paid]')).toHaveLength(0)
    expect(food.marks).toHaveClass('invisible')
    expect(within(food.row).getByText('Nothing')).toHaveClass('sr-only')
    expect(within(food.row).getByText('—')).toHaveAttribute('aria-hidden', 'true')

    // Table brings the exact figures; Chart brings the marks back. No event for the switch.
    await user.click(within(show).getByRole('button', { name: 'Table' }))
    expect(within(card).getByRole('table', { name: 'Spending from jars in 2026' })).toBeInTheDocument()
    expect(within(card).queryByRole('img', { name: / paid out / })).not.toBeInTheDocument()
    // The table lists them in the same order.
    expect(within(card).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Old sofa (archived)', 'Pets', 'Food', 'All jars'])
    await user.click(within(show).getByRole('button', { name: 'Chart' }))
    expect(within(card).getAllByRole('img', { name: / paid out / })).toHaveLength(3)
  })

  // The month letters over the marks: the month in progress emphasised, the months still to come
  // (and those before the year's first record) faint. Today is pinned to 15 October 2026.
  it('marks the month in progress and leaves the months to come without marks', async () => {
    wire({ 2026: jars2026() })
    renderWithProviders(<ReportsPage />)

    const card = await findJarCard()
    const pets = marksOf(card, 'Pets').marks
    // November and December have not come yet: no mark at all.
    expect(pets.children[10]).toHaveClass('invisible')
    expect(pets.children[11]).toHaveClass('invisible')
    expect(pets.children[9]).not.toHaveClass('invisible') // October, so far
    const letters = card.querySelector('[aria-hidden] .grid-cols-12')!.children
    expect(Array.from(letters).map((l) => l.textContent).join('')).toBe('JFMAMJJASOND')
    expect(letters[9]).toHaveClass('text-slate-900!') // October
    expect(letters[10]).toHaveClass('text-slate-400!') // November
    expect(letters[0]).toHaveClass('text-slate-400!') // January, before the first record
  })

  it('follows the Trend card year, and leaves the card out when the year has no jars or the report fails', async () => {
    const jars2025: JarSpendingReportDto = {
      year: 2025,
      jars: [{ jarId: 'trip', name: 'Holiday', currency: 'EUR', isArchived: false, months: twelve({ 7: 120 }), refunds: twelve(), total: 120, totalRefunds: 0 }],
      waitingCount: 0,
    }
    wire({ 2026: jars2026(), 2025: jars2025, 2024: 'reject' })
    const user = userEvent.setup()
    renderWithProviders(<ReportsPage />)
    await findJarCard()

    // The one year switcher moves the Trend chart and the jars together.
    await user.click(screen.getByRole('button', { name: 'Previous year' }))
    await screen.findByText('2025', {}, W)
    expect(await screen.findByRole('img', { name: 'Holiday paid out €120.00 in Jul' }, W)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Spent each month against income received, 2025: / })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /^Pets paid out/ })).not.toBeInTheDocument()
    // One jar in one currency: no All jars row.
    const table = await jarTable(user, 2025)
    expect(within(table).queryByRole('row', { name: /^All jars/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Previous year' }))
    await screen.findByText('2024', {}, W)
    expect(screen.queryByRole('heading', { name: 'Jar spending' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: /Spending from jars/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Previous year' }))
    await screen.findByText('2023', {}, W)
    expect(screen.queryByRole('heading', { name: 'Jar spending' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Spending from jars/)).not.toBeInTheDocument()
  })

  it('says how many rows paid from a jar still wait for their budget-currency amount', async () => {
    wire({ 2026: { ...jars2026(), waitingCount: 2 } })
    const user = userEvent.setup()
    renderWithProviders(<ReportsPage />)

    const card = await findJarCard()
    const note = within(card).getByRole('status')
    expect(note).toHaveTextContent('Not counted yet')
    expect(note).toHaveTextContent('2 payments')
    const add = within(note).getByRole('link', { name: 'Add the € amounts on Transactions' })
    expect(add).toHaveTextContent('€ amounts')
    expect(add).toHaveAttribute('href', '/transactions')
    expect(await hintText(user, 'About jar spending')).toContain(
      'Payments in another currency aren’t counted until they have their amount in EUR.',
    )
  })

  // Keyboard: after the Spending card, the jar card's (i), then its Chart | Table switch.
  it('reaches the jar card controls after the Spending card by keyboard', async () => {
    wire({ 2026: jars2026() })
    const user = userEvent.setup()
    renderWithProviders(<ReportsPage />)
    const card = await findJarCard()

    act(() => screen.getByLabelText('Breakdown month').focus())
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'About jar spending' }))
    await user.tab()
    const chart = within(card).getByRole('button', { name: 'Chart' })
    expect(document.activeElement).toBe(chart)
    await user.tab()
    const table = within(card).getByRole('button', { name: 'Table' })
    expect(document.activeElement).toBe(table)
    await user.keyboard('{Enter}')
    expect(table).toHaveAttribute('aria-pressed', 'true')
    // The wide table scrolls in its own box, which takes focus next.
    await user.tab()
    expect(document.activeElement).toBe(within(card).getByRole('region', { name: 'Spending from jars in 2026' }))
  })
})
