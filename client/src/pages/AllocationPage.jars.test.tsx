import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, JarAccountLedgerDto } from '../types'

const { monthState } = vi.hoisted(() => ({
  // The app-wide selected month the page allocates (rule 29): June 2026 for this file.
  monthState: { year: 2026, month: 6, label: 'June 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))

// The selected month comes from MonthContext (rule 29); pin it so assertions are clock-independent.
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AllocationPage } from './AllocationPage'
import { jointCurrent, preview, profile } from '../test/fixtures/allocation'
import { hintText, openAllocate, recordTransfers } from '../test/allocationPage'

// Rule 78 on the allocation commit: Alex's savings account backs the Holiday jar, Sam's backs
// none, so only Alex's transfer asks how it is divided.

const accountsData: AccountDto[] = [
  jointCurrent,
  { id: 'acc1', name: 'Alex Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 30000, displayOrder: 1 },
  { id: 'acc2', name: 'Sam Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 40000, displayOrder: 2 },
]

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

const renderPage = () => renderWithProviders(<AllocationPage />)

describe('AllocationPage jar prompt on commit', () => {
  beforeEach(() => {
    resetApiMocks()
    setupGet()
  })

  it('asks how each jar-backed savings transfer is divided and posts jarAllocations', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()
    renderPage()

    const opened = await openAllocate(user, 'June')
    const dialog = within(opened)

    // Alex's account backs a jar; Sam's does not.
    expect(await dialog.findByTestId('alloc-m1-jar-allocation')).toBeInTheDocument()
    expect(dialog.queryByTestId('alloc-m2-jar-allocation')).not.toBeInTheDocument()
    // Whose money and which account: the fields' name, and the "Into jars" (i).
    expect(dialog.getByRole('group', { name: 'Put into jars in Alex Savings' })).toBeInTheDocument()
    expect(dialog.getByText('Into jars')).toBeInTheDocument()
    expect(await hintText(user, 'About putting it into jars', opened)).toMatch(/Alex’s €1,250\.47 lands in Alex Savings/)

    await user.type(dialog.getByLabelText('Amount for Holiday'), '1000')
    // What's left of Alex's transfer stays unallocated, said beside the fields.
    expect(dialog.getByText(/^Stays unallocated/).parentElement).toHaveTextContent('Stays unallocated: €250.47')
    await recordTransfers(user, opened)

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/allocation/commit/2026/6',
        expect.objectContaining({
          confirmedCompleted: true,
          jarAllocations: [{ memberId: 'm1', jarId: 'j-hol', amount: 1000 }],
        }),
      ),
    )
    expect(await screen.findByText('Allocated June · 2 transfers in transit', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await hintText(user, 'About the allocation')).toMatch(/2 savings transfers recorded as in transit/)
  })

  it('sends no jarAllocations when the prompt is left empty', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()
    renderPage()

    const opened = await openAllocate(user, 'June')
    await within(opened).findByTestId('alloc-m1-jar-allocation')
    await recordTransfers(user, opened)

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('jarAllocations')
  })

  it('shows the server’s jar validation message verbatim', { timeout: 15000 }, async () => {
    const message = 'The jar amounts total 1300 but only 1250.47 EUR reached Alex Savings.'
    mockPost.mockRejectedValue({ response: { status: 400, data: { errors: { JarAllocations: [message] } } } })
    const user = userEvent.setup()
    renderPage()

    const opened = await openAllocate(user, 'June')
    await user.type(await within(opened).findByLabelText('Amount for Holiday'), '1300')
    await recordTransfers(user, opened)

    expect(await screen.findByText(message, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
