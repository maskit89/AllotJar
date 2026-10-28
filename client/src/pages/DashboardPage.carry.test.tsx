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
  return {
    year: prev.year, month: prev.month, carriedIn: 0, newAccounts: 0, received: 3000, spent: 2380, intoJars: 500, setAside: 0,
    privateTransfers: 0, leftOver: 120, toAllot: 0, fxPendingCount: 0, ...over,
  }
}

const twoBefore = prev.month === 1 ? { year: prev.year - 1, month: 12 } : { year: prev.year, month: prev.month - 1 }
const wrapUpUrl = (y: number, m: number) => `/budget/${y}/${m}/wrap-up`

// The page's reads: these months, this wrap-up answer for the month viewed, and a budget for any month.
function serve(months: { year: number; month: number }[], wrap: (url: string) => Promise<unknown> | undefined) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months') return Promise.resolve({ data: months.map((m) => ({ ...m, key: '' })) })
    if (url.endsWith('/wrap-up')) return wrap(url) ?? Promise.resolve({ data: wrapUp({ toAllot: 0 }) })
    if (url === '/budget/templates' || url === '/jars' || url === '/accounts') return Promise.resolve({ data: [] })
    const [, y, m] = url.match(/^\/budget\/(\d+)\/(\d+)$/) ?? []
    return Promise.resolve({ data: y ? budget(Number(y), Number(m)) : budget() })
  })
}

const renderPage = () => renderWithProviders(<DashboardPage />, { month: true })

describe('DashboardPage: a month continues the one before (carry-over)', () => {
  beforeEach(() => resetApiMocks())

  it('carries what the month before left over into Income and Remaining to budget', { timeout: 15000 }, async () => {
    serve([prev, { year: cy, month: cm }], (url) =>
      url === wrapUpUrl(cy, cm) ? Promise.resolve({ data: wrapUp({ year: cy, month: cm, toAllot: 120 }) }) : undefined,
    )

    renderPage()

    const line = await screen.findByTestId('carry-line', {}, { timeout: 5000 })
    expect(line).toHaveTextContent(`From ${MONTHS[prev.month - 1]}`)
    await waitFor(() => expect(within(line).getByTestId('carry-amount')).toHaveTextContent('€120.00'))
    expect(screen.getByLabelText('Remaining to budget: €2,020.00')).toBeInTheDocument()
    // It is not income: the Income tile keeps to the income lines.
    expect(screen.queryByText('€3,120.00')).not.toBeInTheDocument()
  })

  it('an overspent month before takes from this one, in red', { timeout: 15000 }, async () => {
    serve([prev, { year: cy, month: cm }], (url) =>
      url === wrapUpUrl(cy, cm) ? Promise.resolve({ data: wrapUp({ year: cy, month: cm, toAllot: -80 }) }) : undefined,
    )

    renderPage()

    const amount = await screen.findByTestId('carry-amount', {}, { timeout: 5000 })
    await waitFor(() => expect(amount).toHaveTextContent('− €80.00'))
    expect(amount.className).toContain('text-bad')
    expect(screen.getByLabelText('Remaining to budget: €1,820.00')).toBeInTheDocument()
  })

  it('the first budget gives a job to money already in the accounts, and shows nothing when there is none', { timeout: 15000 }, async () => {
    serve([{ year: cy, month: cm }], (url) =>
      url === wrapUpUrl(cy, cm) ? Promise.resolve({ data: wrapUp({ year: cy, month: cm, toAllot: 700 }) }) : undefined,
    )

    renderPage()

    const line = await screen.findByTestId('carry-line', {}, { timeout: 5000 })
    expect(line).toHaveTextContent('In your accounts')
    expect(within(line).getByTestId('carry-amount')).toHaveTextContent('€700.00')
    expect(screen.getByLabelText('Remaining to budget: €2,600.00')).toBeInTheDocument()
  })

  it('a first budget with nothing outside a jar shows no carry line', { timeout: 15000 }, async () => {
    serve([{ year: cy, month: cm }], () => undefined)

    renderPage()

    expect(await screen.findByLabelText('Remaining to budget: €1,900.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByTestId('carry-line')).not.toBeInTheDocument()
  })

  it('while the carry is on its way, neither it nor Remaining to budget shows a figure', { timeout: 15000 }, async () => {
    serve([prev, { year: cy, month: cm }], (url) => (url === wrapUpUrl(cy, cm) ? new Promise(() => {}) : undefined))

    renderPage()

    const amount = await screen.findByTestId('carry-amount', {}, { timeout: 5000 })
    expect(amount).toHaveTextContent('—')
    expect(screen.getByLabelText('Remaining to budget: loading')).toBeInTheDocument()
    expect(screen.queryByText(/has a job/)).not.toBeInTheDocument()
  })

  it('a carry that could not be read says so instead of showing €0.00', { timeout: 15000 }, async () => {
    serve([prev, { year: cy, month: cm }], (url) => (url === wrapUpUrl(cy, cm) ? Promise.reject(new Error('503')) : undefined))
    const user = userEvent.setup()

    renderPage()

    await waitFor(() => expect(screen.getByLabelText("Remaining to budget: couldn't load")).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByTestId('carry-amount')).toHaveTextContent('—')
    await user.click(screen.getByRole('button', { name: `About the money from ${MONTHS[prev.month - 1]}` }))
    expect(await screen.findByText("Couldn't load this. Reload the page to try again.")).toBeInTheDocument()
  })

  it("moving to another month never shows the last month's carry", { timeout: 15000 }, async () => {
    serve([twoBefore, prev, { year: cy, month: cm }], (url) =>
      url === wrapUpUrl(cy, cm)
        ? Promise.resolve({ data: wrapUp({ year: cy, month: cm, toAllot: 120 }) })
        : url === wrapUpUrl(prev.year, prev.month)
          ? new Promise(() => {})
          : undefined,
    )
    const user = userEvent.setup()

    renderPage()
    await waitFor(() => expect(screen.getByTestId('carry-amount')).toHaveTextContent('€120.00'), { timeout: 5000 })
    await user.click(screen.getByLabelText('Previous month'))

    await waitFor(() => expect(screen.getByTestId('carry-line')).toHaveTextContent(`From ${MONTHS[twoBefore.month - 1]}`))
    expect(screen.getByTestId('carry-amount')).toHaveTextContent('—')
  })

  it('a month still ahead says the carry arrives when it starts, and counts nothing yet', { timeout: 15000 }, async () => {
    serve([{ year: cy, month: cm }, next], () => undefined)
    const user = userEvent.setup()

    renderPage()
    await screen.findByLabelText('Remaining to budget: €1,900.00', {}, { timeout: 5000 })
    await user.click(await screen.findByLabelText('Next month', {}, { timeout: 5000 }))

    await waitFor(() => expect(screen.getByTestId('carry-line')).toHaveTextContent(`From ${MONTHS[cm - 1]}`))
    expect(screen.getByTestId('carry-amount')).toHaveTextContent('—')
    expect(screen.getByLabelText('Remaining to budget: €1,900.00')).toBeInTheDocument()
    expect(mockGet).not.toHaveBeenCalledWith(wrapUpUrl(next.year, next.month))
  })

  it('an empty month after a budget offers one Start button and how the month before went', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [{ ...prev, key: '' }] })
      if (url === wrapUpUrl(prev.year, prev.month)) return Promise.resolve({ data: wrapUp({ carriedIn: 400, intoJars: -300, leftOver: 1320 }) })
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

    // The figures add up as shown: 400 + 3,000 − 2,380 + 300 = 1,320.
    const summary = await screen.findByRole('region', { name: `${MONTHS[prev.month - 1]} ${prev.year}` }, { timeout: 5000 })
    expect(summary).toHaveTextContent(`From ${MONTHS[twoBefore.month - 1]}€400.00`)
    expect(summary).toHaveTextContent('In€3,000.00')
    expect(summary).toHaveTextContent('Spent− €2,380.00')
    expect(summary).toHaveTextContent('Out of jars+ €300.00')
    expect(summary).toHaveTextContent('Left over')
    expect(summary).toHaveTextContent('€1,320.00')

    await user.click(start)
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/budget', expect.objectContaining({ year: cy, month: cm, copyFromPrevious: true })),
    )
  })
})
