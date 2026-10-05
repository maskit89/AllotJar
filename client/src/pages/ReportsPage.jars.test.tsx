// The spending-from-jars card on the Reports page (5 October 2026, from Christopher's jar notes:
// "how much I am actually spending from each jar monthly/yearly"). The server reads a draw from
// a jar exactly as the ledger does (rule 79); the page lays the year out as one row per jar and a
// column per month, with the annual overview's year navigator driving both.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
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

describe('ReportsPage — spending from jars', () => {
  beforeEach(() => resetApiMocks())

  it('lists each jar with the month it paid, the whole bill under the jar it was paid from', async () => {
    wire({ 2026: jars2026() })
    renderWithProviders(<ReportsPage />)

    const table = await screen.findByRole('table', { name: 'Spending from jars in 2026' }, W)
    expect(screen.getByText('Spending from jars')).toBeInTheDocument()
    expect(screen.getByText(/Money moved between jars is not spending/)).toBeInTheDocument()

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
  })

  it('follows the annual overview year, and leaves the card out when the year has no jars or the report fails', async () => {
    wire({ 2026: jars2026(), 2025: 'reject' })
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('table', { name: 'Spending from jars in 2026' }, W)

    await userEvent.click(screen.getByRole('button', { name: 'Previous year' }))
    await screen.findByText('2025', {}, W)
    expect(screen.queryByRole('table', { name: /Spending from jars/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Previous year' }))
    await screen.findByText('2024', {}, W)
    expect(screen.queryByRole('table', { name: /Spending from jars/ })).not.toBeInTheDocument()
  })

  it('says how many rows paid from a jar still wait for their budget-currency amount', async () => {
    wire({ 2026: { ...jars2026(), waitingCount: 2 } })
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('table', { name: 'Spending from jars in 2026' }, W)
    expect(screen.getByText(/2 transactions paid from a jar are in another currency/)).toBeInTheDocument()
  })
})
