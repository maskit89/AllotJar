import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type {
  AccountDto,
  BudgetMonthDto,
  HouseholdMemberDto,
  ImportPreviewResult,
  ImportStatementResult,
} from '../types'

const { mockGet, mockPreview, mockCommit } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPreview: vi.fn(),
  mockCommit: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: vi.fn(), post: vi.fn() },
  previewImport: mockPreview,
  commitImport: mockCommit,
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { ImportPage } from './ImportPage'
import { AuthProvider } from '../auth/AuthContext'

const accounts: AccountDto[] = [
  { id: 'acc1', name: 'HSBC Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
  { id: 'acc2', name: 'Joint Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1 },
]
const members: HouseholdMemberDto[] = [
  { id: 'm1', name: 'Chris', netMonthlyIncome: 0, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1 } as unknown as HouseholdMemberDto,
]
const month = {
  id: 'mo1', key: '2026-06', year: 2026, month: 6, baseCurrency: 'EUR',
  totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false,
  categories: [
    { id: 'c1', name: 'Food', kind: 'Expense', displayOrder: 0, totalPlanned: 0, totalActual: 0,
      items: [
        { id: 'bi1', name: 'Groceries', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
        { id: 'bi2', name: 'Soap', displayOrder: 1, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
      ] },
  ],
} as unknown as BudgetMonthDto

function preview(): ImportPreviewResult {
  return {
    totalEntries: 3, newCount: 2, skippedDuplicates: 1, credits: 0, debits: 2,
    items: [
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      { reference: 'hsbc:b#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

// A preview that includes a credit flagged as a likely transfer (e.g. an e-banking top-up).
function previewWithTransfer(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'hsbc:e#0', date: '2026-06-16', payee: 'E-BANKING PAYMENT', amount: 234.24, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: true },
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
    ],
  }
}

// A generic-CSV preview: carries the detected column layout so the mapping panel renders.
function csvPreview(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'csv:a#0', date: '2026-06-20', payee: 'TESCO', amount: 42.5, currency: 'GBP', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'csv:b#0', date: '2026-06-21', payee: 'SALARY', amount: 2500, currency: 'GBP', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
    layout: {
      columns: ['Date', 'Description', 'Amount', 'Currency'],
      sampleRows: [['2026-06-20', 'TESCO', '-42.50', 'GBP']],
      suggested: {
        delimiter: ',', hasHeader: true, dateColumn: 0, amountColumn: 2, descriptionColumn: 1,
        currencyColumn: 3, dateFormat: null, decimalStyle: 0, defaultCurrency: 'GBP',
      },
    },
  }
}

function committed(): ImportStatementResult {
  return { totalEntries: 2, imported: 2, skippedDuplicates: 0, credits: 0, debits: 2, iban: null, autoCategorized: 0, transfers: 0 }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ImportPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(await screen.findByLabelText('Statement file'), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

describe('ImportPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPreview.mockReset()
    mockCommit.mockReset()
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(preview())
    mockCommit.mockResolvedValue(committed())
  })

  it('renders the upload form with account options', { timeout: 15000 }, async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Import transactions', level: 1 })).toBeInTheDocument()
    expect(screen.getByLabelText('File format')).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'HSBC Current' })).toBeInTheDocument()
  })

  it('generic CSV: shows the mapping panel and re-scans with a corrected mapping', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    // Default format is the generic bank CSV; upload and go to review.
    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    // "TESCO" now appears in both the sample-rows table and the review row, so key off the
    // review row's unique include checkbox.
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    // First preview sent no mapping — the home currency fallback plus the (unchosen) account
    // that scopes the server's already-imported filter.
    expect(mockPreview).toHaveBeenCalledWith(
      expect.any(File),
      'GenericCsv',
      { defaultCurrency: 'EUR', accountId: null },
    )

    // The mapping panel is shown, prefilled from the detected layout (amount = column index 2).
    expect(screen.getByRole('heading', { name: 'Column mapping' })).toBeInTheDocument()
    expect((screen.getByLabelText('Amount column') as HTMLSelectElement).value).toBe('2')

    // Editing a column marks the mapping dirty: the re-scan button becomes the primary
    // "Apply changes" action and Import is blocked until the file is re-scanned.
    await user.selectOptions(screen.getByLabelText('Description column'), '3')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    mockPreview.mockClear()
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    const [, wire, opts] = mockPreview.mock.calls[0]
    expect(wire).toBe('GenericCsv')
    expect(opts.mapping.descriptionColumn).toBe(3)
    expect(opts.defaultCurrency).toBe('EUR')
  })

  it('previews, then commits with the suggested category pre-filled', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // The duplicate count from the preview is surfaced.
    expect(screen.getByText(/already imported/)).toBeInTheDocument()
    // AUTOMARKET's category defaulted to the suggested "Groceries" line.
    expect((screen.getByLabelText('Category for AUTOMARKET on 2026-06-17') as HTMLSelectElement).value).toBe('bi1')

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [accountArg, items] = mockCommit.mock.calls[0]
    expect(accountArg).toBeNull()
    expect(items).toHaveLength(2)
    expect(items).toContainEqual(expect.objectContaining({ payee: 'AUTOMARKET', budgetItemId: 'bi1' }))
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
  })

  it('excludes unticked rows from the commit', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15')) // untick
    await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(expect.objectContaining({ payee: 'AUTOMARKET' }))
  })

  // Re-review F3 — a categorised row dated outside the loaded budget month is a deliberate
  // cross-month choice: one confirm per batch, then only the affected rows are re-sent
  // acknowledged (the server rejects them without the flag).
  it('confirms cross-month rows once per batch and flags only them acknowledged', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue({
      totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 0, debits: 2,
      items: [
        { reference: 'hsbc:m#0', date: '2026-05-27', payee: '4 PILLARS', amount: 1770, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
        { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      ],
    })
    renderPage()
    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('4 PILLARS')

    // The May row gets a June line — that's the cross-month case.
    await user.selectOptions(screen.getByLabelText('Category for 4 PILLARS on 2026-05-27'), 'bi1')
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    // The confirm dialog appears INSTEAD of committing.
    expect(await screen.findByText('Budget to a different month?')).toBeInTheDocument()
    expect(mockCommit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Import anyway' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items).toContainEqual(expect.objectContaining({ payee: '4 PILLARS', acknowledgeCrossMonth: true }))
    const sameMonthRow = items.find((i: { payee: string }) => i.payee === 'AUTOMARKET') as
      | { acknowledgeCrossMonth?: boolean }
      | undefined
    expect(sameMonthRow?.acknowledgeCrossMonth).toBeUndefined()
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
  })

  it('bulk-applies a member to the included rows', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.selectOptions(screen.getByLabelText('Bulk member'), 'm1')
    await user.click(screen.getByRole('button', { name: 'Apply to included' }))
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items).toHaveLength(2)
    expect(items.every((i: { memberId: string | null }) => i.memberId === 'm1')).toBe(true)
  })

  it('splits a row across two categories and commits the slices', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }))

    // AUTOMARKET is 35 → 20 to Groceries + 15 to Soap.
    await user.selectOptions(screen.getByLabelText('Split line 1 category for AUTOMARKET'), 'bi1')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20')
    await user.selectOptions(screen.getByLabelText('Split line 2 category for AUTOMARKET'), 'bi2')
    await user.type(screen.getByLabelText('Split line 2 amount for AUTOMARKET'), '15')

    expect(screen.getByLabelText('Remaining to allocate')).toHaveTextContent('Fully allocated')

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    const automarket = items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')
    expect(automarket.budgetItemId).toBeNull()
    expect(automarket.splits).toHaveLength(2)
    expect(automarket.splits).toContainEqual({ budgetItemId: 'bi1', amount: 20, memberId: null })
    expect(automarket.splits).toContainEqual({ budgetItemId: 'bi2', amount: 15, memberId: null })
  })

  it('blocks the import while a split is incomplete', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }))
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20') // 20 of 35 → 15 left

    expect(screen.getByText(/Finish the highlighted rows first/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('marks a flagged row as a transfer and commits it with the counterparty', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    expect(screen.getByText('Looks like a transfer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer' }))
    await user.selectOptions(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16'), 'acc2')

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [accountArg, items] = mockCommit.mock.calls[0]
    expect(accountArg).toBe('acc1')
    const transfer = items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT')
    expect(transfer).toEqual(expect.objectContaining({ transferAccountId: 'acc2', budgetItemId: null, memberId: null }))
  })

  it('blocks import while a transfer has no counterparty chosen', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')
    await user.click(screen.getByRole('button', { name: 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled(),
    )
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('unticks possible duplicates by default, badges them, and keeps them out of the commit', { timeout: 15000 }, async () => {
    const dupPreview = preview()
    dupPreview.items[1] = { ...dupPreview.items[1], possibleDuplicate: true } // WOLT
    mockPreview.mockResolvedValue(dupPreview)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // Badged, counted in the summary, and unticked by default.
    expect(screen.getByText('Possibly already imported')).toBeInTheDocument()
    expect(screen.getByText(/1 possible duplicate unticked/)).toBeInTheDocument()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const [, items] = mockCommit.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(expect.objectContaining({ payee: 'AUTOMARKET' }))
  })

  it('a possible duplicate can be ticked back in and committed', { timeout: 15000 }, async () => {
    const dupPreview = preview()
    dupPreview.items[1] = { ...dupPreview.items[1], possibleDuplicate: true } // WOLT
    mockPreview.mockResolvedValue(dupPreview)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15')) // opt back in
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const [, items] = mockCommit.mock.calls[0]
    expect(items).toHaveLength(2)
  })

  it('explains when a generic upload was recognised as a known bank format', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...preview(), detectedFormat: 'HsbcCsv' })
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    expect(screen.getByText(/recognised this file as an HSBC transaction history export/)).toBeInTheDocument()
  })

  it('shows no recognised-format notice when the generic path was used', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...csvPreview(), detectedFormat: 'GenericCsv' })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(screen.queryByText(/recognised this file as/)).not.toBeInTheDocument()
  })

  it('shows real money sums (not counts) on the success screen', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user) // AUTOMARKET 35 (debit), WOLT 80.90 (debit) — both EUR
    mockCommit.mockResolvedValue({ ...committed(), imported: 2, credits: 0, debits: 2 })

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await screen.findByText('Import complete')

    // "Money out" is the summed amount, not the count "2".
    const moneyOut = screen.getByText('Money out').closest('div')!
    expect(moneyOut).toHaveTextContent('€115.90')
    const moneyIn = screen.getByText('Money in').closest('div')!
    expect(moneyIn).toHaveTextContent('€0.00')
  })

  it('blocks import until an edited mapping is re-scanned, keeping categorisation across the re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    // Categorise TESCO, then edit the mapping — import must block and warn until a re-scan.
    await user.selectOptions(screen.getByLabelText('Category for TESCO on 2026-06-20'), 'bi1')
    await user.selectOptions(screen.getByLabelText('Description column'), '3')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    expect(screen.getByText(/changed the column mapping/)).toBeInTheDocument()

    // Re-scan returns the same rows (unchanged references) → the category is preserved and import unblocks.
    mockPreview.mockResolvedValue(csvPreview())
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() =>
      expect((screen.getByLabelText('Category for TESCO on 2026-06-20') as HTMLSelectElement).value).toBe('bi1'),
    )
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
  })

  it('shows an all-caught-up message when every row was already imported', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...preview(), newCount: 0, skippedDuplicates: 3, items: [] })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))

    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument()
    expect(screen.getByText(/all 3 were skipped as duplicates/)).toBeInTheDocument()
    // No review grid / commit button — just the friendly summary + a way to start over.
    expect(screen.queryByRole('button', { name: /Import \d+ transaction/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import another file' })).toBeInTheDocument()
  })

  it('reports the date format it read for a generic CSV', { timeout: 15000 }, async () => {
    // The server pins the resolved format into the echoed mapping (I1).
    const pinned = csvPreview()
    pinned.layout!.suggested.dateFormat = 'yyyy-MM-dd'
    mockPreview.mockResolvedValue(pinned)
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(screen.getByText(/We read your dates as/)).toHaveTextContent('YYYY-MM-DD')
  })

  it('shows the server error message when the preview fails', { timeout: 15000 }, async () => {
    mockPreview.mockRejectedValue({ response: { data: { title: 'No transactions were found.' } } })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No transactions were found')
  })
})
