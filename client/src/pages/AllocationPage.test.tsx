import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, AllocationProfileDto, AllocationResultDto } from '../types'

const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AllocationPage } from './AllocationPage'
import { AuthProvider } from '../auth/AuthContext'
import { HouseholdProvider } from '../features/HouseholdContext'

const accountsData: AccountDto[] = [
  { id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
]

function profile(): AllocationProfileDto {
  return {
    id: 'p1',
    name: 'Household allocation',
    sourceAccountId: 'acc0',
    balanceLeanPercent: 25,
    rules: [
      { id: 'r0', order: 0, type: 0, split: 0, fixedAmountPerMember: 0 },
      { id: 'r1', order: 1, type: 1, split: 0, fixedAmountPerMember: 0 },
      { id: 'r2', order: 2, type: 2, split: 0, fixedAmountPerMember: 250 },
      { id: 'r3', order: 3, type: 3, split: 2, fixedAmountPerMember: 0 },
    ],
  }
}

function preview(transfersCreated = 0): AllocationResultDto {
  return {
    pool: 8000.75,
    envelopesTotal: 3500,
    jarsTotal: 2000,
    transfersCreated,
    steps: [
      { type: 0, total: 3500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1750 }, { memberId: 'm2', name: 'Sam', amount: 1750 }] },
      { type: 1, total: 2000, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1000 }, { memberId: 'm2', name: 'Sam', amount: 1000 }] },
      { type: 2, total: 500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 250 }, { memberId: 'm2', name: 'Sam', amount: 250 }] },
      // Terminal step is BalanceTilt (rule r3 split:2), tilting the 2000.75 toward Alex's lower balance.
      { type: 3, total: 2000.75, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1250.47 }, { memberId: 'm2', name: 'Sam', amount: 750.28 }] },
    ],
    members: [
      { memberId: 'm1', name: 'Alex', netIncome: 4200.50, residual: 1250.47, savingsBalance: 30000, savingsAccountId: 'acc1' },
      { memberId: 'm2', name: 'Sam', netIncome: 3800.25, residual: 750.28, savingsBalance: 40000, savingsAccountId: 'acc2' },
    ],
  }
}

// `'' ` is a real wire shape, not a hypothetical: a 204 No Content answer arrives from axios as an
// empty-string body, so the bootstrap has to normalise it the same way it normalises null.
let profileData: AllocationProfileDto | null | '' = null

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/allocation/profile') return Promise.resolve({ data: profileData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/budget/current') return Promise.resolve({ data: { year: 2026, month: 6, categories: [] } })
    if (url.startsWith('/allocation/preview/')) return Promise.resolve({ data: preview() })
    return Promise.resolve({ data: [] })
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AllocationPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// Wrapped in a real HouseholdProvider so the page can tell solo from shared.
function renderWithHousehold() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HouseholdProvider>
          <AllocationPage />
        </HouseholdProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AllocationPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    profileData = null
    setupGet()
  })

  it('shows a setup empty-state when no profile exists', { timeout: 15000 }, async () => {
    profileData = null

    renderPage()

    expect(await screen.findByText(/No allocation set up yet/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Set up allocation')).toBeInTheDocument()
  })

  // ALLOC-010/ALLOC-018 regression. GET /allocation/profile used to answer 204 No Content for a
  // profile-less household; axios hands that back as `data: ''`, and the bootstrap's `?? null` let
  // the empty string through. `''?.rules` does NOT short-circuit — optional chaining only guards
  // null/undefined — so openSettings threw before setShowSettings(true) and the first-run modal
  // could never open. The server now emits a JSON null, and the client normalises falsy → null;
  // this test pins the client half so an empty body can't poison profile state again.
  it('opens the first-run setup modal when the profile response has an empty body', { timeout: 15000 }, async () => {
    profileData = ''
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Set up allocation' }, { timeout: 5000 }))
    expect(await screen.findByRole('dialog', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('nudges a solo user to add members instead of the allocation engine', { timeout: 15000 }, async () => {
    profileData = profile() // a profile exists, but with no members the page should still guard

    renderWithHousehold()

    expect(await screen.findByText(/Add people first/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add people' })).toBeInTheDocument()
    // The allocation setup form must not render in solo mode.
    expect(screen.queryByText('Allocation settings')).not.toBeInTheDocument()
  })

  it('renders the waterfall and each member’s surplus', { timeout: 15000 }, async () => {
    profileData = profile()

    renderPage()

    expect(await screen.findByText('How June is allocated', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/8,000\.75/)).toBeInTheDocument() // pool (hero)
    expect(screen.getByText('Pocket money')).toBeInTheDocument()
    expect(screen.getByText('To savings')).toBeInTheDocument() // hero tile
    expect(screen.getByText('Shared spending')).toBeInTheDocument() // hero tile reconciles to the pool
    // Each member's tilted surplus appears in both the step breakdown and their surplus card.
    expect(screen.getAllByText(/1,250\.47/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/750\.28/).length).toBeGreaterThan(0)
  })

  it('disables Allocate and explains when no source account is set', { timeout: 15000 }, async () => {
    profileData = { ...profile(), sourceAccountId: null }

    renderPage()

    await screen.findByText('How June is allocated', {}, { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toBeDisabled()
    expect(screen.getByText(/Set the account to pay shared costs from/)).toBeInTheDocument()
  })

  it('saves a new profile from the setup form', { timeout: 15000 }, async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Set up allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(dialog.getByLabelText('Source account'), 'acc0')
    await user.type(dialog.getByLabelText('Pocket money per member'), '250')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/allocation/profile',
        expect.objectContaining({ sourceAccountId: 'acc0', rules: expect.arrayContaining([]) }),
      ),
    )
    const body = mockPut.mock.calls[0][1]
    expect(body.rules).toHaveLength(4)
  })

  it('commits the allocation', { timeout: 15000 }, async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    // Rules 7/29: the plan becomes recorded transfers only after "I've completed these transfers".
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))
    expect(await screen.findByText(/Confirm that you’ve completed these transfers/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.clear(dialog.getByLabelText('Allocation departure date'))
    await user.type(dialog.getByLabelText('Allocation departure date'), '2026-06-03')
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/6', {
        departedOn: '2026-06-03', receivedOn: null, confirmedCompleted: true,
      }),
    )
    expect(await screen.findByText(/2 savings transfers recorded as in transit/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('reports an unchanged re-run instead of pretending nothing was needed', { timeout: 15000 }, async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: { ...preview(0), transfersRetained: 2 } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    expect(await screen.findByText(/the 2 recorded transfers are unchanged/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
