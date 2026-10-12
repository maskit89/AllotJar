import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AllocationResultDto } from '../types'

// CL-P2-2 (end-to-end check 30 Sep, fixed in PR E): the Allocation page had no late-answer guard. Every handler
// that awaits the API (commit, saveProfile, syncPocketLines, linkSavings) captures `period` when
// it is created and, once its answer lands, writes the preview/banner/month into state with no check
// that the month it started on is still the one viewed (AllocationPage.tsx:93-100 loadPreview,
// 235-269 commit). The Dashboard's #276/#289 `stillOn()`/`isViewed()` guards have no counterpart here.
const { monthState } = vi.hoisted(() => ({
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AllocationPage } from './AllocationPage'
import { jointCurrent, preview, profile } from '../test/fixtures/allocation'
import { findSteps } from '../test/allocationPage'

/** August's preview: a pool of 100 so the two months cannot be confused. */
function augustPreview(): AllocationResultDto {
  const p = preview()
  return { ...p, pool: 100, steps: p.steps.map((s) => ({ ...s, total: 0, perMember: [] })), members: p.members.map((m) => ({ ...m, residual: 0 })) }
}

function held<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('AllocationPage: answers that land after the month changed', () => {
  beforeEach(() => {
    resetApiMocks()
    monthState.year = 2026
    monthState.month = 7
    monthState.label = 'July 2026'
    mockGet.mockImplementation((url: string) => {
      if (url === '/allocation/profile') return Promise.resolve({ data: profile() })
      if (url === '/accounts') return Promise.resolve({ data: [jointCurrent] })
      if (url === '/allocation/preview/2026/7') return Promise.resolve({ data: preview() })
      if (url === '/allocation/preview/2026/8') return Promise.resolve({ data: augustPreview() })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      if (url === '/jars/ledger') return Promise.resolve({ data: [] })
      return Promise.reject({ response: { status: 404 } })
    })
  })

  it('a July commit answered after moving to August leaves August’s preview and shows no banner', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const commit = held<{ data: AllocationResultDto }>()
    mockPost.mockImplementation((url: string) => (url === '/allocation/commit/2026/7' ? commit.promise : Promise.resolve({ data: {} })))

    const view = renderWithProviders(<AllocationPage />)
    await findSteps('July')
    expect(screen.getByLabelText(/^Income to allocate:/)).toHaveTextContent('€8,000.75')

    await user.click(screen.getByRole('button', { name: 'Allocate July' }))
    await user.click(await screen.findByLabelText('I’ve completed these transfers'))
    await user.click(screen.getByRole('button', { name: 'Record transfers' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/7', expect.anything()))

    // The user moves to August while July's commit is still in flight.
    monthState.year = 2026
    monthState.month = 8
    monthState.label = 'August 2026'
    view.rerender(<AllocationPage />)
    await findSteps('August')
    await waitFor(() => expect(screen.getByLabelText(/^Income to allocate:/)).toHaveTextContent('€100.00'))

    // July's commit answers now.
    await act(async () => {
      commit.release({ data: preview(3) })
    })

    // Expected: August's figures stay and no banner says July was allocated under August's heading.
    // On main the hero flips back to July's €8,000.75 and the banner reads "Allocated August — 3 savings transfers…".
    expect(screen.getByLabelText(/^Income to allocate:/)).toHaveTextContent('€100.00')
    expect(screen.queryByText(/^Allocated /)).not.toBeInTheDocument()
  })
})
