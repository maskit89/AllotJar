import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor, within } from '@testing-library/react'

// #301 P3-4b: the checklist read today once, when the module loaded, so a tab left open over a
// month's end kept asking about the old month. It reads today's month on every check.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
const { dismissChecklist } = vi.hoisted(() => ({ dismissChecklist: vi.fn() }))
vi.mock('./OnboardingContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./OnboardingContext')>()),
  useOnboarding: () => ({ dismissChecklist }),
}))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { GettingStartedChecklist } from './GettingStartedChecklist'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

describe('GettingStartedChecklist: the month it asks about', () => {
  beforeEach(() => {
    resetApiMocks()
    mockGet.mockResolvedValue({ data: [] })
  })

  it('asks about the new month once the month has turned', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:00:00Z'))
    renderWithProviders(<GettingStartedChecklist />)
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/budget/2026/10'))

    vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
    await act(async () => {
      fireEvent.focus(window)
    })

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/budget/2026/11'))
  })
})

describe('GettingStartedChecklist: checks that answer out of order', () => {
  beforeEach(() => resetApiMocks())

  it('keeps the latest check when an earlier one answers last (#302 review P3-3)', async () => {
    const months: Array<(value: { data: unknown }) => void> = []
    mockGet.mockImplementation((url: string) =>
      url === '/budget/2026/10' ? new Promise((resolve) => months.push(resolve)) : Promise.resolve({ data: [] }),
    )
    const view = renderWithProviders(<GettingStartedChecklist />)
    await waitFor(() => expect(months).toHaveLength(1))
    await act(async () => {
      fireEvent.focus(window)
    })
    await waitFor(() => expect(months).toHaveLength(2))

    const withIncome = budgetMonth({
      categories: [budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'pay', name: 'Pay', plannedAmount: 3000 })] })],
    })
    await act(async () => {
      months[1]({ data: withIncome })
    })
    await act(async () => {
      months[0]({ data: budgetMonth({ categories: [] }) })
    })

    // The later check found income; the earlier one, answering last, found none and is dropped.
    expect(await view.findByText('1 of 6 done')).toBeInTheDocument()
  })
})

describe('GettingStartedChecklist: the jar step', () => {
  beforeEach(() => resetApiMocks())

  it('ticks once a jar exists, and is left out where the Jars page is off', async () => {
    let jarsOn = true
    mockGet.mockImplementation((url: string) => {
      if (url === '/features') return Promise.resolve({ data: { jars: jarsOn } })
      if (url === '/jars') return Promise.resolve({ data: [{ id: 'j1' }] })
      return Promise.resolve({ data: [] })
    })
    const on = renderWithProviders(<GettingStartedChecklist />, { features: true })
    const step = await on.findByRole('link', { name: /Add a jar/ })
    expect(step).toHaveAttribute('href', '/jars')
    expect(await on.findByText('1 of 6 done')).toBeInTheDocument()
    on.unmount()

    jarsOn = false
    const off = renderWithProviders(<GettingStartedChecklist />, { features: true })
    expect(await off.findByText('0 of 5 done')).toBeInTheDocument()
    expect(off.queryByText('Add a jar')).not.toBeInTheDocument()
  })
})

describe('GettingStartedChecklist: the account step', () => {
  beforeEach(() => resetApiMocks())

  it('comes first, ticks once an account exists, and is left out where the Accounts page is off', async () => {
    let accountsOn = true
    mockGet.mockImplementation((url: string) => {
      if (url === '/features') return Promise.resolve({ data: { accounts: accountsOn } })
      if (url === '/accounts') return Promise.resolve({ data: [{ id: 'a1' }] })
      return Promise.resolve({ data: [] })
    })
    const on = renderWithProviders(<GettingStartedChecklist />, { features: true })
    const step = await on.findByRole('link', { name: /Add an account/ })
    expect(step).toHaveAttribute('href', '/accounts')
    expect(await on.findByText('1 of 6 done')).toBeInTheDocument()
    const region = on.getByRole('region', { name: 'Getting started' })
    expect(within(region).getAllByRole('listitem')[0]).toHaveTextContent('Add an account')
    on.unmount()

    accountsOn = false
    const off = renderWithProviders(<GettingStartedChecklist />, { features: true })
    expect(await off.findByText('0 of 5 done')).toBeInTheDocument()
    expect(off.queryByText('Add an account')).not.toBeInTheDocument()
  })
})

// Restyle PR 19: the collapsed pill and the done line.
describe('GettingStartedChecklist: the collapsed pill and the done line', () => {
  beforeEach(() => {
    resetApiMocks()
    dismissChecklist.mockReset()
  })

  it('collapses to a quiet pill with the count in a chip and a chevron, never a green button', async () => {
    mockGet.mockResolvedValue({ data: [] })
    const view = renderWithProviders(<GettingStartedChecklist />)
    const region = await view.findByRole('region', { name: 'Getting started' })
    fireEvent.click(within(region).getByRole('button', { name: 'Collapse getting started' }))

    const pill = await view.findByRole('button', { name: /^Getting started/ })
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    expect(pill).not.toHaveClass('bg-brand-600')
    const chip = pill.querySelector('[data-tone]')
    expect(chip).toHaveTextContent('0 of 6')
    expect(chip).toHaveAttribute('data-tone', 'neutral')
    expect(pill.querySelector('svg')).not.toBeNull()
    await waitFor(() => expect(pill).toHaveFocus())
  })

  it('all done: one line, "Every euro has a job.", no emoji, and a quiet Dismiss in place of the ✕', async () => {
    const balanced = budgetMonth({
      categories: [
        budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'pay', name: 'Pay', plannedAmount: 3000 })] }),
        budgetCategory({ id: 'hou', name: 'Housing', kind: 'Expense', items: [budgetItem({ id: 'rent', name: 'Rent', plannedAmount: 3000 })] }),
      ],
    })
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/wrap-up')) return Promise.resolve({ data: { toAllot: 0, leftOver: 0 } })
      if (url.startsWith('/budget/') && url !== '/budget/months') return Promise.resolve({ data: balanced })
      return Promise.resolve({ data: [{ id: 'x1' }] })
    })
    const view = renderWithProviders(<GettingStartedChecklist />)
    const region = await view.findByRole('region', { name: 'Getting started' })
    expect(await within(region).findByText('Every euro has a job.')).toBeInTheDocument()
    expect(region.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(within(region).queryByRole('button', { name: 'Dismiss getting started' })).not.toBeInTheDocument()

    const dismiss = within(region).getByRole('button', { name: 'Dismiss' })
    expect(dismiss).not.toHaveClass('bg-brand-600')
    fireEvent.click(dismiss)
    expect(dismissChecklist).toHaveBeenCalledTimes(1)
  })

  it('a balanced plan with money still to give a job (rule 94 carry) is not done yet', async () => {
    const balanced = budgetMonth({
      categories: [
        budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'pay', name: 'Pay', plannedAmount: 3000 })] }),
        budgetCategory({ id: 'hou', name: 'Housing', kind: 'Expense', items: [budgetItem({ id: 'rent', name: 'Rent', plannedAmount: 3000 })] }),
      ],
    })
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/wrap-up')) return Promise.resolve({ data: { toAllot: 500, leftOver: 500 } })
      if (url.startsWith('/budget/') && url !== '/budget/months') return Promise.resolve({ data: balanced })
      return Promise.resolve({ data: [{ id: 'x1' }] })
    })
    const view = renderWithProviders(<GettingStartedChecklist />)
    expect(await view.findByText('5 of 6 done')).toBeInTheDocument()
    expect(view.queryByText('Every euro has a job.')).not.toBeInTheDocument()
  })

  it('reads the carry only for a month with income, as nothing is balanced without it', async () => {
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
    mockGet.mockImplementation((url: string) =>
      url === '/budget/2026/10' ? Promise.resolve({ data: budgetMonth({ categories: [] }) }) : Promise.resolve({ data: [{ id: 'x1' }] }),
    )
    const view = renderWithProviders(<GettingStartedChecklist />)
    expect(await view.findByText('4 of 6 done')).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledWith('/budget/2026/10')
    expect(mockGet).not.toHaveBeenCalledWith('/budget/2026/10/wrap-up')
  })
})
