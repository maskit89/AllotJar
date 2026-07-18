import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type {
  AccountDto,
  BudgetMonthDto,
  HouseholdMemberDto,
  ImportPreviewResult,
  ImportStatementResult,
} from '../types'

// Mirror ImportPage.test.tsx + ImportPage.catalog.test.tsx harness exactly: hoisted mock fns +
// vi.mock('../lib/api') with the importOriginal spread (load-bearing — new api.ts exports must keep
// working under test), same AuthProvider/MemoryRouter tree. This file only ADDS the remaining
// jsdom-observable catalog cases that neither sibling file already covers (the cheap P2 tail:
// include-all header toggle, amount colour/direction, header-toggle re-scan, transfer undo, full
// reset, and graceful reference-data degradation).
const { mockGet, mockPreview, mockCommit } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPreview: vi.fn(),
  mockCommit: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
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

// Two EUR debits — the default fixture used by most review-grid cases here.
function preview(): ImportPreviewResult {
  return {
    totalEntries: 3, newCount: 2, skippedDuplicates: 1, credits: 0, debits: 2,
    items: [
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      { reference: 'hsbc:b#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

// A credit flagged as a likely transfer (e.g. an e-banking top-up) plus a plain debit.
function previewWithTransfer(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'hsbc:e#0', date: '2026-06-16', payee: 'E-BANKING PAYMENT', amount: 234.24, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: true },
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
    ],
  }
}

// One credit + one debit, both EUR, non-transfer — for the amount colour/direction case.
function previewCreditAndDebit(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'x:s#0', date: '2026-06-25', payee: 'SALARY', amount: 250, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'x:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
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

describe('ImportPage (catalog supplemental)', () => {
  beforeEach(() => {
    // Keep the default Owner role — never let a stray zbb.role from another suite drop canWrite.
    localStorage.clear()
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

  // IMP-041 — the header "Include all rows" checkbox unticks every row (Import disabled at zero)
  // and re-ticks them all; it reads checked only when every row is included.
  it('include-all header checkbox toggles every row and gates the import', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    const headerBox = screen.getByLabelText('Include all rows')
    // Both rows start included, so the header box is checked.
    expect(headerBox).toBeChecked()
    expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).toBeChecked()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).toBeChecked()

    // Untick the header → every row unticks and Import is disabled at zero included.
    await user.click(headerBox)
    await waitFor(
      () => expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).not.toBeChecked(),
      { timeout: 5000 },
    )
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()
    expect(headerBox).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()

    // Re-tick the header → every row re-includes and the box reads checked again.
    await user.click(headerBox)
    await waitFor(
      () => expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).toBeChecked(),
      { timeout: 5000 },
    )
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).toBeChecked()
    expect(headerBox).toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
  })

  // IMP-044 — a credit renders "+€X" in emerald, a debit "−€X" in slate, each in its own currency.
  it('renders credit amounts +emerald and debit amounts −slate', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewCreditAndDebit())
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('SALARY')

    // Amount is the 4th cell (checkbox, Date, Payee, Amount, Category, Member).
    const creditAmt = screen.getByLabelText('Include SALARY on 2026-06-25').closest('tr')!.querySelectorAll('td')[3]
    expect(creditAmt).toHaveTextContent('+€250.00')
    expect(creditAmt.textContent?.trim().startsWith('+')).toBe(true)
    expect(creditAmt).toHaveClass('text-emerald-600')

    const debitAmt = screen.getByLabelText('Include AUTOMARKET on 2026-06-17').closest('tr')!.querySelectorAll('td')[3]
    expect(debitAmt).toHaveTextContent('€35.00')
    // The sign is the true minus glyph U+2212, not a hyphen, and the cell is slate (not emerald).
    expect(debitAmt.textContent?.trim().charCodeAt(0)).toBe(0x2212)
    expect(debitAmt).toHaveClass('text-slate-700')
    expect(debitAmt).not.toHaveClass('text-emerald-600')
  })

  // IMP-023 (+ the clean-state re-scan label of IMP-066/IMP-020) — the "First row is a header" toggle
  // marks the mapping dirty and its flipped value is sent on the re-scan.
  it('generic CSV: the "first row is a header" toggle is sent on re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    // Clean mapping: the re-scan button is the secondary "Re-scan with this mapping" (no dirty warning).
    expect(screen.getByRole('button', { name: 'Re-scan with this mapping' })).toBeInTheDocument()
    const headerToggle = screen.getByLabelText('First row is a header')
    expect(headerToggle).toBeChecked() // detected layout had hasHeader: true

    // Toggling it off marks the mapping dirty (button flips to the primary "Apply changes" action).
    await user.click(headerToggle)
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Apply changes & re-scan' })).toBeInTheDocument(),
      { timeout: 5000 },
    )

    mockPreview.mockClear()
    mockPreview.mockResolvedValue(csvPreview())
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(mockPreview).toHaveBeenCalled(), { timeout: 5000 })
    const [, wire, opts] = mockPreview.mock.calls[0]
    expect(wire).toBe('GenericCsv')
    expect(opts.mapping.hasHeader).toBe(false)
  })

  // IMP-055 — "Undo" on a transfer row returns it to a normal categorised row: the Category select
  // and the "Mark as a transfer" control come back, and the transfer account picker is gone.
  it('undo returns a transfer row to a normal categorised row', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    // An import account is required for the per-row transfer control to appear.
    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    // Mark it a transfer → the transfer account select + Undo appear, the Category select is gone.
    await user.click(screen.getByRole('button', { name: 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer' }))
    expect(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).toBeInTheDocument()
    expect(screen.queryByLabelText('Category for E-BANKING PAYMENT on 2026-06-16')).not.toBeInTheDocument()

    // Undo → back to a plain categorised row: Category returns, the transfer picker is gone, and the
    // "looks like a transfer" hint + the mark-as-transfer control are offered again.
    await user.click(screen.getByRole('button', { name: 'Cancel transfer for E-BANKING PAYMENT on 2026-06-16' }))
    expect(await screen.findByLabelText('Category for E-BANKING PAYMENT on 2026-06-16')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Looks like a transfer')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer' }),
    ).toBeInTheDocument()
  })

  // IMP-083 — both restart controls fully reset to the upload phase: "Choose a different file" from
  // review, and "Import another file" from the done screen.
  it('"Choose a different file" and "Import another file" reset to the upload phase', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // "Choose a different file" (review) → back to a blank upload form.
    await user.click(screen.getByRole('button', { name: 'Choose a different file' }))
    expect(await screen.findByLabelText('Statement file')).toBeInTheDocument()
    // File state cleared → submit disabled again, and no review grid remains.
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()
    expect(screen.queryByLabelText('Include AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()

    // Import to reach the done screen, then "Import another file" → upload phase again.
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await screen.findByText('Import complete')

    await user.click(screen.getByRole('button', { name: 'Import another file' }))
    expect(await screen.findByLabelText('Statement file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()
    expect(screen.queryByText('Import complete')).not.toBeInTheDocument()
  })

  // IMP-089 — when the reference-data fetches (/accounts, /budget/current, /members) fail, the page
  // degrades gracefully: no error banner, no account options, category selects offer only
  // "Unassigned", the bulk buttons disable, and the upload → review flow still completes.
  it('degrades gracefully when the reference-data fetches fail', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts' || url === '/budget/current' || url === '/members') {
        return Promise.reject(new Error('network'))
      }
      return Promise.resolve({ data: [] })
    })
    const user = userEvent.setup()
    renderPage()

    // The account picker renders but offers only the "no account" option (accounts defaulted to []).
    const accountSelect = await screen.findByLabelText(/Add to account/)
    expect(within(accountSelect).getAllByRole('option')).toHaveLength(1)
    expect(within(accountSelect).getByRole('option', { name: "Don't link to an account" })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'HSBC Current' })).not.toBeInTheDocument()

    // The upload → review flow still works despite the missing reference data.
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')

    // Month defaulted to null → category selects offer only "Unassigned".
    const categorySelect = screen.getByLabelText('Category for AUTOMARKET on 2026-06-17')
    const categoryOptions = within(categorySelect).getAllByRole('option')
    expect(categoryOptions).toHaveLength(1)
    expect(categoryOptions[0]).toHaveTextContent('Unassigned')

    // No expense lines / no members → both bulk actions are disabled.
    expect(screen.getByRole('button', { name: 'Apply to expenses' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply to included' })).toBeDisabled()

    // Swallowed failures never surface an error banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
