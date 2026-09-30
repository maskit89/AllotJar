import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import type { FeatureFlags, HouseholdMemberDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AppNav } from './AppNav'

const renderNav = () => renderWithProviders(<AppNav active="budget" />, { features: true, household: true })

const flags = (over: Partial<FeatureFlags>): FeatureFlags => ({
  accounts: true, multiCurrency: true, camtImport: true, reports: true, jars: true, householdAllocation: true, householdAccess: true, ...over,
})

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 6000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

// The nav reads /features and /members; AuthProvider also reads /auth/me (ignored here).
let flagsValue: FeatureFlags = flags({})
let membersData: HouseholdMemberDto[] = []

describe('AppNav (feature flags)', () => {
  beforeEach(() => {
    resetApiMocks()
    flagsValue = flags({})
    membersData = []
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      return Promise.resolve({ data: flagsValue })
    })
  })

  it('shows the core nav items when all features are on', { timeout: 15000 }, async () => {
    flagsValue = flags({})

    renderNav()

    expect(await screen.findByText('Dashboard', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Transactions')).toBeInTheDocument()
    expect(screen.getByText('Accounts')).toBeInTheDocument()
    expect(screen.getByText('Jars')).toBeInTheDocument()
    expect(screen.getByText('Reports')).toBeInTheDocument()
  })

  it('hides Accounts, Funds and Reports when their flags are off', { timeout: 15000 }, async () => {
    flagsValue = flags({ accounts: false, reports: false, jars: false })

    renderNav()

    // The core budgeting items always show…
    expect(await screen.findByText('Dashboard', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Transactions')).toBeInTheDocument()
    // …while the disabled differentiators are removed once the flags load.
    await waitFor(() => expect(screen.queryByText('Accounts')).not.toBeInTheDocument())
    expect(screen.queryByText('Jars')).not.toBeInTheDocument()
    expect(screen.queryByText('Reports')).not.toBeInTheDocument()
  })

  it('shows People but hides Allocation for a solo household (no members)', { timeout: 15000 }, async () => {
    flagsValue = flags({})
    membersData = []

    renderNav()

    // People is always available — it's how a solo user adds/invites someone.
    expect(await screen.findByText('People', {}, { timeout: 5000 })).toBeInTheDocument()
    // …but Allocation (split between 2+ people) stays hidden until the budget is shared.
    await waitFor(() => expect(screen.queryByText('Allocation')).not.toBeInTheDocument())
  })

  it('hides Allocation for a single-member household but still shows People', { timeout: 15000 }, async () => {
    flagsValue = flags({})
    membersData = [member()] // one member is still solo — a person is a member

    renderNav()

    expect(await screen.findByText('People', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Allocation')).not.toBeInTheDocument())
  })

  it('reveals Allocation once the household is shared (2+ members)', { timeout: 15000 }, async () => {
    flagsValue = flags({})
    membersData = [member(), member({ id: 'm2', name: 'Sam' })]

    renderNav()

    expect(await screen.findByText('Allocation', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('People')).toBeInTheDocument()
  })
})
