import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarDto } from '../types'

const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { JarsPage } from './JarsPage'
import { AuthProvider } from '../auth/AuthContext'

function fund(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    coverStart: null,
    coverEnd: null,
    accrual: 0,
    recurAnnually: true,
    openingBalance: 0,
    openingAsOf: null,
    fundingAccountId: null,
    isArchived: false,
    currentBalance: 120,
    requiredMonthlyContribution: 25,
    projectedFullyFundedDate: '2026-11-01',
    status: 'OnTrack',
    ...over,
  }
}

// Account names deliberately don't collide with fund names so the funding-account
// <option>s don't create duplicate text matches.
const accountsData: AccountDto[] = [
  { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
]

let fundsData: JarDto[] = []

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <JarsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('JarsPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    fundsData = []
    mockGet.mockImplementation((url: string) =>
      url === '/accounts'
        ? Promise.resolve({ data: accountsData })
        : Promise.resolve({ data: fundsData }),
    )
  })

  it('lists funds as jars with their balances and funded percentage', { timeout: 15000 }, async () => {
    fundsData = [
      fund(),
      fund({ id: 'f2', name: 'Holiday', kind: 0, targetAmount: 1000, currentBalance: -40, requiredMonthlyContribution: 0, status: 'Overspent', targetDate: null, projectedFullyFundedDate: null }),
    ]

    renderPage()

    expect(await screen.findByText('Home insurance', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Holiday')).toBeInTheDocument()
    // Each jar shows its balance and a funded-percentage pill (120 of 300 = 40%).
    expect(screen.getByText(/120.00/)).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('adds a fund from the New jar modal', { timeout: 15000 }, async () => {
    fundsData = []
    mockPost.mockResolvedValue({ data: fund({ id: 'f9', name: 'Vacation', kind: 0, targetAmount: 1200, status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Vacation')
    await user.type(dialog.getByLabelText('Target amount'), '1200')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/jars',
        expect.objectContaining({ name: 'Vacation', targetAmount: 1200, kind: 0, accrual: 1 }),
      ),
    )
    expect(await screen.findByText('Vacation', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('offers Recurring/Goal as the jar Type and drops the renews checkbox', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const type = dialog.getByLabelText('Jar type')
    expect(within(type).getByRole('option', { name: 'Recurring' })).toBeInTheDocument()
    expect(within(type).getByRole('option', { name: 'Goal' })).toBeInTheDocument()
    // The renewal bit is now derived from Type, so the standalone checkbox is gone.
    expect(dialog.queryByLabelText('Renews each year')).not.toBeInTheDocument()
  })

  it('echoes the stored cover window and opening as-of when editing', { timeout: 15000 }, async () => {
    // The form doesn't surface these fields; an unrelated edit must not wipe them.
    fundsData = [
      fund({ coverStart: '2026-01-01', coverEnd: '2026-12-31', openingAsOf: '2025-12-31' }),
    ]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/jars/f1',
        expect.objectContaining({
          coverStart: '2026-01-01',
          coverEnd: '2026-12-31',
          openingAsOf: '2025-12-31',
        }),
      ),
    )
  })

  it('labels the opening amount "Saved so far" on create but "Opening balance" on edit', { timeout: 15000 }, async () => {
    fundsData = [fund()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Saved so far')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel edit' }))

    await user.click(screen.getByLabelText('Edit Home insurance'))
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Opening balance')).toBeInTheDocument()
    expect(dialog.queryByText('Saved so far')).not.toBeInTheDocument()
  })

  it('archives a fund from its edit modal', { timeout: 15000 }, async () => {
    fundsData = [
      fund(),
      fund({ id: 'f2', name: 'Holiday', kind: 0 }),
    ]
    mockPut.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Archive Home insurance' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1/archive', { archived: true }),
    )
    await waitFor(() => expect(screen.queryByText('Home insurance')).not.toBeInTheDocument())
  })

  it('shows an empty state when there are no funds', { timeout: 15000 }, async () => {
    fundsData = []

    renderPage()

    expect(await screen.findByText(/No jars yet/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
