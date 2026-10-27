import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BudgetMonthDto, MonthWrapUpDto } from '../types'

// Control the API from the tests.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { DashboardPage } from './DashboardPage'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const now = new Date()
const cy = now.getUTCFullYear()
const cm = now.getUTCMonth() + 1
const prev = cm === 1 ? { year: cy - 1, month: 12 } : { year: cy, month: cm - 1 }
const next = cm === 12 ? { year: cy + 1, month: 1 } : { year: cy, month: cm + 1 }

// Income 3000, Rent 1100: Remaining 1900 before any carry.
function budget(year = cy, month = cm): BudgetMonthDto {
  return budgetMonth({
    key: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
      budgetCategory({ id: 'c1', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1100 })] }),
    ],
  })
}

function wrapUp(over: Partial<MonthWrapUpDto> = {}): MonthWrapUpDto {
  return { year: prev.year, month: prev.month, carriedIn: 0, received: 3000, spent: 2380, intoJars: 500, leftOver: 120, isOver: true, fxPendingCount: 0, ...over }
}

const renderPage = () => renderWithProviders(<DashboardPage />, { month: true })

describe('DashboardPage: a month continues the one before (carry-over)', () => {
  beforeEach(() => resetApiMocks())

  it('carries what the month before left over into Income and Remaining to budget', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ ...prev, key: '' }, { year: cy, month: cm, key: '' }] })
      if (url === `/budget/${prev.year}/${prev.month}/wrap-up`) return Promise.resolve({ data: wrapUp() })
      if (url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: budget() })
    })

    renderPage()

    const line = await screen.findByTestId('carry-line', {}, { timeout: 5000 })
    expect(line).toHaveTextContent(`From ${MONTHS[prev.month - 1]}`)
    await waitFor(() => expect(within(line).getByTestId('carry-amount')).toHaveTextContent('€120.00'))
    expect(screen.getByLabelText('Remaining to budget: €2,020.00')).toBeInTheDocument()
    // It is not income: the Income tile keeps to the income lines.
    expect(screen.queryByText('€3,120.00')).not.toBeInTheDocument()
  })

  it('an overspent month before takes from this one, in red', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ ...prev, key: '' }, { year: cy, month: cm, key: '' }] })
      if (url === `/budget/${prev.year}/${prev.month}/wrap-up`) return Promise.resolve({ data: wrapUp({ leftOver: -80 }) })
      if (url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: budget() })
    })

    renderPage()

    const amount = await screen.findByTestId('carry-amount', {}, { timeout: 5000 })
    await waitFor(() => expect(amount).toHaveTextContent('− €80.00'))
    expect(amount.className).toContain('text-bad')
    expect(screen.getByLabelText('Remaining to budget: €1,820.00')).toBeInTheDocument()
  })

  it('the first budget carries nothing in', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ year: cy, month: cm, key: '' }] })
      if (url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: budget() })
    })

    renderPage()

    expect(await screen.findByLabelText('Remaining to budget: €1,900.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByTestId('carry-line')).not.toBeInTheDocument()
    expect(mockGet).not.toHaveBeenCalledWith(expect.stringMatching(/wrap-up$/))
  })

  it('a month still ahead says the carry arrives when it starts, and counts nothing yet', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ year: cy, month: cm, key: '' }, { ...next, key: '' }] })
      if (url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === `/budget/${next.year}/${next.month}`) return Promise.resolve({ data: budget(next.year, next.month) })
      return Promise.resolve({ data: budget() })
    })
    const user = userEvent.setup()

    renderPage()
    await screen.findByLabelText('Remaining to budget: €1,900.00', {}, { timeout: 5000 })
    await user.click(await screen.findByLabelText('Next month', {}, { timeout: 5000 }))

    await waitFor(() => expect(screen.getByTestId('carry-line')).toHaveTextContent(`From ${MONTHS[cm - 1]}`))
    expect(screen.getByTestId('carry-amount')).toHaveTextContent('—')
    expect(screen.getByLabelText('Remaining to budget: €1,900.00')).toBeInTheDocument()
  })

  it('an empty month after a budget offers one Start button and how the month before went', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ ...prev, key: '' }] })
      if (url === `/budget/${prev.year}/${prev.month}/wrap-up`) return Promise.resolve({ data: wrapUp() })
      if (url === '/budget/templates') return Promise.resolve({ data: [{ key: 'essentials', name: 'Essentials', description: '', groups: [] }] })
      if (url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
      if (url === `/budget/${cy}/${cm}`) return Promise.reject({ response: { status: 404 } })
      return Promise.resolve({ data: budget() })
    })
    mockPost.mockResolvedValue({ data: budget() })
    const user = userEvent.setup()

    renderPage()

    const start = await screen.findByRole('button', { name: `Start ${MONTHS[cm - 1]}` }, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Start a blank budget' })).not.toBeInTheDocument()
    expect(screen.queryByText('Or start from a template')).not.toBeInTheDocument()

    const summary = await screen.findByRole('region', { name: `${MONTHS[prev.month - 1]} ${prev.year}` }, { timeout: 5000 })
    expect(summary).toHaveTextContent('In€3,000.00')
    expect(summary).toHaveTextContent('Spent− €2,380.00')
    expect(summary).toHaveTextContent('Into jars− €500.00')
    expect(summary).toHaveTextContent('Left over')
    expect(summary).toHaveTextContent('€120.00')

    await user.click(start)
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget', expect.objectContaining({ year: cy, month: cm, copyFromPrevious: true })),
    )
  })
})
