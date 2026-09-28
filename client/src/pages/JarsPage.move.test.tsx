import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'

// Rule 80 — "Move money" across accounts. Mirrors JarsPage.test.tsx's harness: hoisted mock fns
// + vi.mock('../lib/api') with the importOriginal spread, mockGet routed by URL.
const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { JarsPage } from './JarsPage'
import { AuthProvider } from '../auth/AuthContext'

function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    accrual: 0,
    monthlyContribution: null,
    includeDeadlineMonth: false,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-09-26',
    isArchived: false,
    currentBalance: 400,
    plannedThisMonth: 25,
    contributedThisMonth: 0,
    remainingThisMonth: 25,
    deadline: null,
    fundingCompletesOn: '2026-11-01',
    estimatedMonthsToTarget: null,
    shortfall: null,
    lastCycle: null,
    completedOn: null,
    canDelete: false,
    skippedThisMonth: false,
    status: 'OnTrack',
    ...over,
  }
}

// Two jar-backed accounts plus one that backs no jars (so it appears as "Unallocated funds" only).
const accountsData: AccountDto[] = [
  { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 1000, displayOrder: 0 },
  { id: 'acc2', name: 'Rainy Day', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 350, displayOrder: 1 },
  { id: 'acc3', name: 'Cash Box', type: 2, currency: 'EUR', openingBalance: 0, currentBalance: 50, displayOrder: 2 },
]

function ledger(over: Partial<JarAccountLedgerDto> = {}): JarAccountLedgerDto {
  return {
    accountId: 'acc1',
    accountName: 'Joint Current',
    currency: 'EUR',
    asOf: '2026-09-26',
    accountBalance: 1000,
    unallocated: 600,
    positiveAllocations: 400,
    hasBackingDeficit: false,
    unreconciledAllocations: 0,
    requiresReview: false,
    jars: [{ jarId: 'f1', name: 'Home insurance', balance: 400, isArchived: false }],
    ...over,
  }
}

const rainyDay = () =>
  ledger({
    accountId: 'acc2',
    accountName: 'Rainy Day',
    accountBalance: 350,
    unallocated: 150,
    positiveAllocations: 200,
    jars: [{ jarId: 'f2', name: 'Repairs', balance: 200, isArchived: false }],
  })

let jarsData: JarDto[] = []
let ledgerData: JarAccountLedgerDto[] = []

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <JarsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const today = new Date().toISOString().slice(0, 10)

async function openMove(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText('Move money from Home insurance', {}, { timeout: 5000 }))
  const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
  await dialog.findByLabelText('Move from', {}, { timeout: 5000 })
  return dialog
}

describe('JarsPage — Move money across accounts (rule 80)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    jarsData = [jar(), jar({ id: 'f2', name: 'Repairs', fundingAccountId: 'acc2', currentBalance: 200 })]
    ledgerData = [ledger(), rainyDay()]
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accountsData })
      if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: ledgerData })
      if (url === '/jars') return Promise.resolve({ data: jarsData })
      return Promise.resolve({ data: {} })
    })
  })

  it('lists every account\'s jars and unallocated funds as destinations, grouped by account; the source stays in the jar\'s account', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    const to = dialog.getByLabelText('Move to') as HTMLSelectElement
    const groups = [...to.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups).toEqual(['Joint Current', 'Rainy Day', 'Cash Box'])
    expect([...to.querySelectorAll('option')].map((o) => o.value)).toEqual([
      'f1', 'unallocated:acc1', 'f2', 'unallocated:acc2', 'unallocated:acc3',
    ])
    // The source can only be a place in the jar's own account.
    const from = dialog.getByLabelText('Move from') as HTMLSelectElement
    expect([...from.querySelectorAll('option')].map((o) => o.value)).toEqual(['f1', 'unallocated:acc1'])
    // Inside one account there is no transfer confirmation.
    expect(dialog.queryByLabelText('I have made this transfer')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Move date')).toBeInTheDocument()
  })

  it('records a cross-account move as a confirmed transfer with the source jar, the destination allocation and both dates', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: { id: 't1' } })
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    await user.selectOptions(dialog.getByLabelText('Move to'), 'f2')
    // Choosing another account switches to the transfer confirmation: both dates default to today.
    expect(dialog.getByText(/This moves money between Joint Current and Rainy Day, so it is recorded as a bank transfer you have made/)).toBeInTheDocument()
    const departed = dialog.getByLabelText('Departure date') as HTMLInputElement
    const received = dialog.getByLabelText('Receipt date') as HTMLInputElement
    expect(departed.value).toBe(today)
    expect(departed.max).toBe(today)
    expect(received.value).toBe(today)
    expect(dialog.getByText(/Repairs receives it once you confirm the receipt on the Transactions page/)).toBeInTheDocument()
    // The destination account's money shows alongside the source's.
    expect(dialog.getByLabelText('Money held in Rainy Day')).toBeInTheDocument()

    await user.type(dialog.getByLabelText('Move amount'), '100')
    fireEvent.change(departed, { target: { value: '2026-09-20' } })
    fireEvent.change(received, { target: { value: '2026-09-22' } })

    // The checkbox is required: nothing is posted until the user confirms the transfer was made.
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))
    expect(await dialog.findByText(/Tick “I have made this transfer” to record it/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.click(dialog.getByLabelText('I have made this transfer'))
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/transactions/transfer', {
        departedOn: '2026-09-20',
        receivedOn: '2026-09-22',
        amount: 100,
        fromAccountId: 'acc1',
        toAccountId: 'acc2',
        payee: 'Move money: Home insurance → Repairs',
        fromJarId: 'f1',
        jarAllocations: [{ jarId: 'f2', amount: 100 }],
      }),
    )
    expect(mockPost).not.toHaveBeenCalledWith('/jars/reallocations', expect.anything())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The page re-reads the jars and ledgers after the move.
    await waitFor(() => expect(mockGet.mock.calls.filter(([u]) => u === '/jars').length).toBeGreaterThan(1))
  })

  it('moves unallocated money to another account\'s unallocated funds with the receipt cleared (in transit) and a note as the payee', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: { id: 't1' } })
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    await user.selectOptions(dialog.getByLabelText('Move from'), 'unallocated:acc1')
    await user.selectOptions(dialog.getByLabelText('Move to'), 'unallocated:acc3')
    expect(dialog.getByText(/the unallocated money in Cash Box receives it once you confirm the receipt/)).toBeInTheDocument()
    await user.type(dialog.getByLabelText('Move amount'), '40')
    fireEvent.change(dialog.getByLabelText('Receipt date'), { target: { value: '' } })
    await user.type(dialog.getByLabelText('Move note'), 'Cash withdrawal')
    await user.click(dialog.getByLabelText('I have made this transfer'))
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    const [url, body] = mockPost.mock.calls[0]
    expect(url).toBe('/transactions/transfer')
    expect(body).toEqual({
      departedOn: today,
      receivedOn: null,
      amount: 40,
      fromAccountId: 'acc1',
      toAccountId: 'acc3',
      payee: 'Cash withdrawal',
      fromJarId: null,
    })
    expect(body).not.toHaveProperty('jarAllocations')
  })

  it('refuses a receipt date before the departure date without a request', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    await user.selectOptions(dialog.getByLabelText('Move to'), 'f2')
    await user.type(dialog.getByLabelText('Move amount'), '10')
    fireEvent.change(dialog.getByLabelText('Departure date'), { target: { value: '2026-09-20' } })
    fireEvent.change(dialog.getByLabelText('Receipt date'), { target: { value: '2026-09-19' } })
    await user.click(dialog.getByLabelText('I have made this transfer'))
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    expect(await dialog.findByText(/The receipt date can’t be before the departure date/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('shows the server\'s message verbatim when the transfer is refused (rules 68/74)', { timeout: 15000 }, async () => {
    mockPost.mockRejectedValue({
      response: { status: 400, data: { errors: { Amount: ['Home insurance holds 400.00 EUR; it cannot give 500.00 EUR.'] } } },
    })
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    await user.selectOptions(dialog.getByLabelText('Move to'), 'f2')
    await user.type(dialog.getByLabelText('Move amount'), '500')
    await user.click(dialog.getByLabelText('I have made this transfer'))
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    expect(await dialog.findByText('Home insurance holds 400.00 EUR; it cannot give 500.00 EUR.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still open for a correction
  })

  it('keeps a same-account move on the reallocation endpoint', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: ledger() })
    const user = userEvent.setup()
    renderPage()
    const dialog = await openMove(user)

    await user.selectOptions(dialog.getByLabelText('Move to'), 'unallocated:acc1')
    await user.type(dialog.getByLabelText('Move amount'), '50')
    fireEvent.change(dialog.getByLabelText('Move date'), { target: { value: '2026-09-21' } })
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars/reallocations', {
        accountId: 'acc1',
        sourceJarId: 'f1',
        destinationJarId: null,
        amount: 50,
        date: '2026-09-21',
        note: null,
      }),
    )
    expect(mockPost).not.toHaveBeenCalledWith('/transactions/transfer', expect.anything())
  })
})
