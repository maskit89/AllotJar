import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, AllocationProfileDto, AllocationResultDto, JarAccountLedgerDto } from '../types'

const { mockGet, mockPut, mockPost, monthState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  // The app-wide selected month the page allocates (rule 29): June 2026 for this file.
  monthState: { year: 2026, month: 6, label: 'June 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))

// The selected month comes from MonthContext (rule 29); pin it so assertions are clock-independent.
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AllocationPage } from './AllocationPage'
import { AuthProvider } from '../auth/AuthContext'

// Rule 78 on the allocation commit: Alex's savings account backs the Holiday jar, Sam's backs
// none, so only Alex's transfer asks how it is divided.

const accountsData: AccountDto[] = [
  { id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
  { id: 'acc1', name: 'Alex Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 30000, displayOrder: 1 },
  { id: 'acc2', name: 'Sam Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 40000, displayOrder: 2 },
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
      { type: 3, total: 2000.75, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1250.47 }, { memberId: 'm2', name: 'Sam', amount: 750.28 }] },
    ],
    members: [
      { memberId: 'm1', name: 'Alex', netIncome: 4200.5, residual: 1250.47, savingsBalance: 30000, savingsAccountId: 'acc1' },
      { memberId: 'm2', name: 'Sam', netIncome: 3800.25, residual: 750.28, savingsBalance: 40000, savingsAccountId: 'acc2' },
    ],
  }
}

const ledgerData: JarAccountLedgerDto[] = [
  {
    accountId: 'acc1', accountName: 'Alex Savings', currency: 'EUR', asOf: '2026-06-01',
    accountBalance: 30000, unallocated: 29000, positiveAllocations: 1000, hasBackingDeficit: false,
    unreconciledAllocations: 0, requiresReview: false,
    jars: [{ jarId: 'j-hol', name: 'Holiday', balance: 1000, isArchived: false }],
  },
]

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/allocation/profile') return Promise.resolve({ data: profile() })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/budget/2026/6') return Promise.resolve({ data: { year: 2026, month: 6, categories: [] } })
    if (url.startsWith('/allocation/preview/')) return Promise.resolve({ data: preview() })
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: ledgerData })
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

describe('AllocationPage jar prompt on commit', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    setupGet()
  })

  it('asks how each jar-backed savings transfer is divided and posts jarAllocations', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    // Alex's account backs a jar; Sam's does not.
    expect(await dialog.findByTestId('alloc-m1-jar-allocation')).toBeInTheDocument()
    expect(dialog.queryByTestId('alloc-m2-jar-allocation')).not.toBeInTheDocument()
    expect(dialog.getByText(/Alex ·/)).toBeInTheDocument()

    await user.type(dialog.getByLabelText('Amount for Holiday'), '1000')
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/allocation/commit/2026/6',
        expect.objectContaining({
          confirmedCompleted: true,
          jarAllocations: [{ memberId: 'm1', jarId: 'j-hol', amount: 1000 }],
        }),
      ),
    )
    expect(await screen.findByText(/2 savings transfers recorded as in transit/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('sends no jarAllocations when the prompt is left empty', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await dialog.findByTestId('alloc-m1-jar-allocation')
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('jarAllocations')
  })

  it('shows the server’s jar validation message verbatim', { timeout: 15000 }, async () => {
    const message = 'The jar amounts total 1300 but only 1250.47 EUR reached Alex Savings.'
    mockPost.mockRejectedValue({ response: { status: 400, data: { errors: { JarAllocations: [message] } } } })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(await dialog.findByLabelText('Amount for Holiday'), '1300')
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    expect(await screen.findByText(message, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
