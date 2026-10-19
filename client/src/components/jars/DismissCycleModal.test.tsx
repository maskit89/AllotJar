import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

vi.mock('../../lib/api', async (importOriginal) => (await import('../../test/apiMock')).apiModule(importOriginal))

import { resetApiMocks } from '../../test/apiMock'
import { renderWithProviders } from '../../test/render'
import { jar } from '../../test/fixtures/jars'
import { setMoneyFormat } from '../../lib/money'
import { DismissCycleModal, nextCycleDeadline } from './DismissCycleModal'

describe('nextCycleDeadline (as JarSchedule.NextCycleDeadline, rule 62)', () => {
  it('steps from the anchor, so a month clamped once is not clamped again', () => {
    // Monthly, anchored on 31 Jan: missed 30 Apr → 31 May, not 30 May.
    expect(nextCycleDeadline('2026-01-31', '2026-04-30', 1)).toBe('2026-05-31')
    expect(nextCycleDeadline('2026-01-31', '2026-01-31', 1)).toBe('2026-02-28')
    expect(nextCycleDeadline('2026-01-31', '2026-02-28', 1)).toBe('2026-03-31')
  })

  it('handles a yearly anchor on 29 Feb and longer cadences', () => {
    expect(nextCycleDeadline('2024-02-29', '2025-02-28', 12)).toBe('2026-02-28')
    expect(nextCycleDeadline('2024-02-29', '2027-02-28', 12)).toBe('2028-02-29')
    // Quarterly from 31 Aug: 30 Nov → 28 Feb (2027 is not a leap year) → 31 May.
    expect(nextCycleDeadline('2026-08-31', '2026-11-30', 3)).toBe('2027-02-28')
    expect(nextCycleDeadline('2026-08-31', '2027-02-28', 3)).toBe('2027-05-31')
  })
})

describe('DismissCycleModal', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('EUR', 'en-GB')
  })

  const render = (overrides: Parameters<typeof jar>[0]) =>
    renderWithProviders(
      <DismissCycleModal jar={jar(overrides)} currency="EUR" onClose={() => {}} onDismissed={() => {}} onMarkPaidInstead={() => {}} />,
    )

  it('names the due date the server will set, stepped from the anchor', () => {
    render({ name: 'Rent', kind: 2, recurMonths: 1, targetDate: '2026-01-31', deadline: '2026-04-30', status: 'DeadlineMissed', shortfall: 100, monthOnly: false })
    expect(screen.getByText(/carries to the cycle due/).textContent).toMatch(/31 May 2026|May 31, 2026/)
  })

  it('falls back to "its next cycle" for a jar with no anchor date', () => {
    render({ name: 'Rent', kind: 2, recurMonths: 1, targetDate: null, deadline: '2026-04-30', status: 'DeadlineMissed', shortfall: 100 })
    expect(screen.getByText(/carries to its next cycle/)).toBeInTheDocument()
  })
})
