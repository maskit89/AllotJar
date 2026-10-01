import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'

// #301 P3-4b: the checklist read today once, when the module loaded, so a tab left open over a
// month's end kept asking about the old month. It reads today's month on every check.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
vi.mock('./OnboardingContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./OnboardingContext')>()),
  useOnboarding: () => ({ dismissChecklist: () => {} }),
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
    expect(await view.findByText('1 of 4 done')).toBeInTheDocument()
  })
})
