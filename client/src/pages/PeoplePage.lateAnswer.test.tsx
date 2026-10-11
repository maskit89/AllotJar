import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HouseholdMemberDto, MembershipDto } from '../types'

// CL-P2-3 (end-to-end check 30 Sep, fixed in PR E): PeoplePage's write handlers call `reloadAll()` after their
// await (PeoplePage.tsx:257, 297, 324, 398, 416, 433, 449). `reloadAll` is memoised on [year, month]
// (line 171), so the handler that started on July holds July's copy; when its PUT answers after
// the user moved to August, it re-reads July (`/members?year=2026&month=7`, spending, income) and
// writes July's figures into the state August is showing. The month-change effect's `cancelled`
// flag (173-182) only covers the effect's own read.
const { monthState } = vi.hoisted(() => ({
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { personAction } from '../test/rowMenu'
import { PeoplePage } from './PeoplePage'

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, hasBudget: true, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}
const membership: MembershipDto = { id: 'mem1', email: 'alex@x.eu', displayName: 'Alex', role: 0, status: 0, memberId: 'm1', isOwner: true, isSelf: true, createdUtc: '2026-01-01' }

// July: Alex earns 3,000 and Sam 1,000 (hero €4,000.00). August: Alex alone, 500 (hero €500.00).
const july = () => [member({ budgetIncome: 3000, incomeSharePct: 0.75 }), member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 })]
const august = () => [member({ netMonthlyIncome: 500, budgetIncome: 500, incomeSharePct: 1 })]

function held<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('PeoplePage: a save answered after the month changed', () => {
  beforeEach(() => {
    resetApiMocks()
    monthState.year = 2026
    monthState.month = 7
    monthState.label = 'July 2026'
    mockGet.mockImplementation((url: string) => {
      if (url === '/members?year=2026&month=7' || url === '/members') return Promise.resolve({ data: july() })
      if (url === '/members?year=2026&month=8') return Promise.resolve({ data: august() })
      if (url === '/access/members') return Promise.resolve({ data: [membership] })
      if (url === '/accounts') return Promise.resolve({ data: [] })
      if (url.startsWith('/members/spending/')) return Promise.resolve({ data: [] })
      if (url.startsWith('/members/income/')) return Promise.reject(new Error('404'))
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      return Promise.resolve({ data: {} })
    })
  })

  it('July’s post-save reload never replaces August’s figures', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const put = held<{ data: unknown }>()
    mockPut.mockImplementation(() => put.promise)

    const view = renderWithProviders(<PeoplePage />)
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })
    expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('€4,000.00')

    // Start editing Alex on July and save; the PUT stays open.
    await personAction(user, 'Alex', 'Edit Alex')
    await user.click(screen.getByRole('button', { name: 'Save Alex' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/members/m1', expect.anything()))

    // Move to August: the month effect reads August (Alex alone, 500).
    monthState.year = 2026
    monthState.month = 8
    monthState.label = 'August 2026'
    view.rerender(<PeoplePage />)
    await waitFor(() => expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('€500.00'), { timeout: 5000 })
    expect(screen.queryByText('Sam')).not.toBeInTheDocument()

    // July's save answers; its reloadAll re-reads July and writes it into August's view.
    await act(async () => {
      put.release({ data: {} })
    })
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/members?year=2026&month=7'))
    // Give the stale reload's setState a tick to land.
    await act(async () => {
      await Promise.resolve()
    })

    // Expected: August's figures stay. On main the hero reads €4,000.00 again and Sam is listed under August.
    expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('€500.00')
    expect(screen.queryByText('Sam')).not.toBeInTheDocument()
  })
})
