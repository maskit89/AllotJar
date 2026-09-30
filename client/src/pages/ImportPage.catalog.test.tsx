import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mirror ImportPage.test.tsx's harness exactly: the shared api mock plus hoisted
// previewImport/commitImport spies, and the same AuthProvider/MemoryRouter render tree. This
// file only ADDS catalog cases that the sibling ImportPage.test.tsx does not already cover.
const { mockPreview, mockCommit } = vi.hoisted(() => ({
  mockPreview: vi.fn(),
  mockCommit: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    previewImport: mockPreview,
    commitImport: mockCommit,
  }),
)

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ImportPage } from './ImportPage'
import { accounts, committed, csvPreview, members, month, preview, previewWithTransfer } from '../test/fixtures/import'
import { HouseholdRole } from '../types'

const renderPage = () => renderWithProviders(<ImportPage />)

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(await screen.findByLabelText('Statement file'), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

describe('ImportPage (catalog)', () => {
  beforeEach(() => {
    // The read-only case (IMP-002) writes zbb.role; clear so it never leaks into a later test.
    localStorage.clear()
    resetApiMocks()
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

  // IMP-002 — a login without canWrite (Read-only) sees no upload form, just a pointer to manual entry.
  it('read-only login cannot import and is pointed at manual entry', { timeout: 15000 }, async () => {
    localStorage.setItem('zbb.role', String(HouseholdRole.ReadOnly))
    renderPage()

    expect(
      await screen.findByText(/Importing statements is available to admins and the household owner/),
    ).toBeInTheDocument()
    // Every import phase is suppressed: no format select, no file input, no submit.
    expect(screen.queryByLabelText('File format')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Statement file')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review transactions' })).not.toBeInTheDocument()
  })

  // IMP-003 — the format select offers exactly the three supported formats, in order, and the
  // helper text beneath updates per selection.
  it('offers exactly the three formats and updates the helper text per selection', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()

    const formatSelect = await screen.findByLabelText('File format')
    const optionLabels = within(formatSelect)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(optionLabels).toEqual([
      'Bank CSV (auto-detect)',
      'HSBC transaction history (CSV)',
      'CAMT.053 statement (XML)',
    ])

    // Default (generic) helper text.
    expect(screen.getByText(/Most banks/)).toBeInTheDocument()

    await user.selectOptions(formatSelect, 'camt')
    expect(screen.getByText(/An ISO 20022 SEPA bank-to-customer statement\./)).toBeInTheDocument()
    expect(screen.queryByText(/Most banks/)).not.toBeInTheDocument()

    await user.selectOptions(formatSelect, 'hsbc')
    expect(screen.getByText(/The Date, Details, Amount export from HSBC/)).toBeInTheDocument()
  })

  // IMP-009 — the submit is disabled until a file is chosen, then enables.
  it('keeps "Review transactions" disabled until a file is chosen', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Statement file')
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()

    await user.upload(screen.getByLabelText('Statement file'), csv())
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeEnabled()
  })

  // IMP-005 — changing the format after choosing a file clears the file, disabling submit again.
  it('changing the format clears the previously-chosen file', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeEnabled()

    // The file input remounts on format change and `file` state is reset — no ghost filename,
    // so the submit falls back to disabled.
    await user.selectOptions(screen.getByLabelText('File format'), 'camt')
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()
  })

  // IMP-010 — choosing an import account shows the "Importing into <account>" notice on the review
  // step, and the help text on the account select explains the effect.
  it('stamps the chosen account on the review notice', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()

    // Upload-phase help text on the account picker.
    await screen.findByLabelText(/Add to account/)
    expect(
      screen.getByText('Stamps each transaction onto this account so its balance reflects the import.'),
    ).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')

    const notice = screen.getByText(/Importing into/)
    expect(notice).toHaveTextContent('HSBC Current')
  })

  // IMP-021 — the currency column's first option is "Use <home currency> for every row", and choosing
  // it maps currencyColumn to null on the re-scan.
  it('generic CSV: "Use EUR for every row" maps the currency column to null on re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    const currencySelect = screen.getByLabelText('Currency column') as HTMLSelectElement
    // The first option uses the user's home currency (EUR here).
    expect(within(currencySelect).getAllByRole('option')[0]).toHaveTextContent('Use EUR for every row')

    // Choosing it clears the mapped currency column → server resolves from DefaultCurrency.
    await user.selectOptions(currencySelect, '')
    mockPreview.mockClear()
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(mockPreview).toHaveBeenCalled(), { timeout: 5000 })
    const [, wire, opts] = mockPreview.mock.calls[0]
    expect(wire).toBe('GenericCsv')
    expect(opts.mapping.currencyColumn).toBeNull()
    expect(opts.defaultCurrency).toBe('EUR')
  })

  // IMP-022 — the delimiter select offers comma/semicolon/tab/pipe, and the override is sent on re-scan.
  it('generic CSV: the column-separator override is sent on re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    const delimiter = screen.getByLabelText('Column separator') as HTMLSelectElement
    expect(within(delimiter).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Comma ,',
      'Semicolon ;',
      'Tab',
      'Pipe |',
    ])

    await user.selectOptions(delimiter, ';')
    mockPreview.mockClear()
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(mockPreview).toHaveBeenCalled(), { timeout: 5000 })
    const [, , opts] = mockPreview.mock.calls[0]
    expect(opts.mapping.delimiter).toBe(';')
  })

  // IMP-043 — "Apply to expenses" bulk-categorises only included debit rows; credits are untouched.
  it('bulk category applies to included expenses only, not credits', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({
      totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
      items: [
        { reference: 'x:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
        { reference: 'x:s#0', date: '2026-06-25', payee: 'SALARY', amount: 2500, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      ],
    })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')

    // Bulk-apply the Soap expense line to every included expense.
    await user.selectOptions(screen.getByLabelText('Bulk category'), 'bi2')
    await user.click(screen.getByRole('button', { name: 'Apply to expenses' }))
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const [, items] = mockCommit.mock.calls[0]
    const debit = items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')
    const credit = items.find((i: { payee: string }) => i.payee === 'SALARY')
    // The debit gets the bulk expense line (overriding its Groceries suggestion); the credit stays unassigned.
    expect(debit.budgetItemId).toBe('bi2')
    expect(credit.budgetItemId).toBeNull()
  })

  // IMP-047 — an over-allocated split is flagged "€X over" and blocks the import.
  it('flags and blocks an over-allocated split', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // AUTOMARKET is €35; splitting it 20 + 20 over-allocates by €5.
    await user.click(screen.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }))
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20')
    await user.type(screen.getByLabelText('Split line 2 amount for AUTOMARKET'), '20')

    await waitFor(
      () => expect(screen.getByLabelText('Remaining to allocate')).toHaveTextContent('€5.00 over'),
      { timeout: 5000 },
    )
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  // IMP-048 — a split starts with two lines; "+ Add line" adds (and shows) a removable third line,
  // removing it returns to two, and "Clear split" reverts the row to a single category.
  it('adds and removes split lines, never dropping below two, and clears back to a category', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }))

    // Starts with exactly two lines and no per-line remove control.
    expect(screen.getByLabelText('Split line 1 category for AUTOMARKET')).toBeInTheDocument()
    expect(screen.getByLabelText('Split line 2 category for AUTOMARKET')).toBeInTheDocument()
    expect(screen.queryByLabelText('Split line 3 category for AUTOMARKET')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove split line 1 for AUTOMARKET')).not.toBeInTheDocument()

    // Adding a third line reveals the remove (✕) controls.
    await user.click(screen.getByRole('button', { name: '+ Add line' }))
    expect(await screen.findByLabelText('Split line 3 category for AUTOMARKET')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove split line 3 for AUTOMARKET')).toBeInTheDocument()

    // Removing it returns to two lines with the remove controls gone again.
    await user.click(screen.getByLabelText('Remove split line 3 for AUTOMARKET'))
    await waitFor(() =>
      expect(screen.queryByLabelText('Split line 3 category for AUTOMARKET')).not.toBeInTheDocument(),
    )
    expect(screen.queryByLabelText('Remove split line 1 for AUTOMARKET')).not.toBeInTheDocument()

    // Clearing the split reverts the row to a plain single-category select.
    await user.click(screen.getByRole('button', { name: 'Clear split' }))
    expect(await screen.findByLabelText('Category for AUTOMARKET on 2026-06-17')).toBeInTheDocument()
  })

  // IMP-052 — with no import account chosen, likely-transfer rows offer no Transfer control and an
  // amber note explains that an account must be selected on the previous step.
  it('offers no per-row transfer control without an import account, and explains why', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    // Deliberately do NOT select an account before uploading.
    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    // The row is still hinted as a transfer, but the mark-as-transfer button never renders.
    expect(screen.getByText('Looks like a transfer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Some rows look like transfers between your accounts\./),
    ).toBeInTheDocument()
  })

  // IMP-068 — a mixed-currency import sums each currency separately on the success screen.
  it('sums each currency separately on the success screen', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({
      totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 0, debits: 2,
      items: [
        { reference: 'x:e#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
        { reference: 'x:g#0', date: '2026-06-18', payee: 'LONDON EYE', amount: 10, currency: 'GBP', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      ],
    })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText('Statement file'), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await screen.findByText('Import complete')

    // Money out shows both currencies added within their own group — never a cross-currency sum.
    const moneyOut = screen.getByText('Money out').closest('div')!
    expect(moneyOut).toHaveTextContent('€35.00')
    expect(moneyOut).toHaveTextContent('£10.00')
    // An empty group falls back to the preferred currency at zero.
    const moneyIn = screen.getByText('Money in').closest('div')!
    expect(moneyIn).toHaveTextContent('€0.00')
  })
})
