import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
import { formatDate } from '../lib/dates'
import { chooseFromMenu } from '../test/rowMenu'
import { categoryChip, chooseMatch, closeHint, done, matchGroup, matchOptions, openHint, pickCategory, rowAction } from '../test/importReview'

const renderPage = () => renderWithProviders(<ImportPage />)

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(await screen.findByLabelText(/^Statement file/), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

describe('ImportPage', () => {
  beforeEach(() => {
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
    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
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

    // The mapping sits behind the file strip's "Columns" (a dialog), prefilled from the detected
    // layout (amount = column index 2).
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect(screen.getByRole('dialog', { name: 'Columns' })).toBeInTheDocument()
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
    // A successful re-scan closes the dialog.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Columns' })).not.toBeInTheDocument())
  })

  it('generic CSV: switches between one amount column and separate debit and credit columns', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()
    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect((screen.getByLabelText('Amounts') as HTMLSelectElement).value).toBe('one')
    expect(screen.queryByLabelText('Debit column')).not.toBeInTheDocument()

    // Debit and credit start from the amount column and the one after it.
    await user.selectOptions(screen.getByLabelText('Amounts'), 'split')
    expect(screen.queryByLabelText('Amount column')).not.toBeInTheDocument()
    expect((screen.getByLabelText('Debit column') as HTMLSelectElement).value).toBe('2')
    expect((screen.getByLabelText('Credit column') as HTMLSelectElement).value).toBe('3')
    await user.selectOptions(screen.getByLabelText('Credit column'), '1')
    // A direction column only goes with one amount column; lines before the table can be skipped.
    expect(screen.queryByLabelText('Direction column')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Skip lines'), '2')

    mockPreview.mockClear()
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))
    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    const [, , opts] = mockPreview.mock.calls[0]
    expect(opts.mapping.debitColumn).toBe(2)
    expect(opts.mapping.creditColumn).toBe(1)
    expect(opts.mapping.skipRows).toBe(2)
  })

  it('generic CSV: a direction column can be chosen for one amount column', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()
    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect((screen.getByLabelText('Direction column') as HTMLSelectElement).value).toBe('')
    await user.selectOptions(screen.getByLabelText('Direction column'), '3')
    mockPreview.mockClear()
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))
    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    expect(mockPreview.mock.calls[0][2].mapping.directionColumn).toBe(3)
  })

  it('generic CSV: rows without a currency are read in the chosen import account’s currency', { timeout: 15000 }, async () => {
    // A legacy account in another currency: its statement's rows are in that currency.
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [{ ...accounts[0], currency: 'GBP' }, accounts[1]] })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      return Promise.resolve({ data: [] })
    })
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(mockPreview).toHaveBeenCalledWith(expect.any(File), 'GenericCsv', { defaultCurrency: 'GBP', accountId: 'acc1' })
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByText('More options'))
    const currencySelect = screen.getByLabelText('Currency column') as HTMLSelectElement
    expect(within(currencySelect).getAllByRole('option')[0]).toHaveTextContent('Use GBP for every row')
  })

  it('previews, then commits with the suggested category pre-filled', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // The duplicate count from the preview is surfaced.
    expect(screen.getByText(/already imported/)).toBeInTheDocument()
    // AUTOMARKET's category defaulted to the suggested "Groceries" line (its chip reads it; the
    // chip opens the select, which holds the line's id).
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveTextContent('Groceries')
    await user.click(categoryChip('AUTOMARKET on 2026-06-17'))
    expect((screen.getByLabelText('Category for AUTOMARKET on 2026-06-17') as HTMLSelectElement).value).toBe('bi1')
    await user.keyboard('{Escape}')

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
    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('4 PILLARS')

    // The May row gets a June line — that's the cross-month case.
    await pickCategory(user, '4 PILLARS on 2026-05-27', 'bi1')
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

    await chooseFromMenu(user, 'Bulk actions', 'Member for included rows')
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

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Split AUTOMARKET on 2026-06-17')
    expect(screen.getByRole('dialog', { name: 'Split' })).toBeInTheDocument()

    // AUTOMARKET is 35 → 20 to Groceries + 15 to Soap.
    await user.selectOptions(screen.getByLabelText('Split line 1 category for AUTOMARKET'), 'bi1')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20')
    await user.selectOptions(screen.getByLabelText('Split line 2 category for AUTOMARKET'), 'bi2')
    await user.type(screen.getByLabelText('Split line 2 amount for AUTOMARKET'), '15')

    expect(screen.getByLabelText('Remaining to allocate')).toHaveTextContent('Fully allocated')
    await done(user)
    // The row's category cell reads the slices.
    expect(screen.getByRole('button', { name: /^Edit split for AUTOMARKET on 2026-06-17:/ })).toHaveTextContent('Groceries €20 · Soap €15')

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

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Split AUTOMARKET on 2026-06-17')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20') // 20 of 35 → 15 left
    expect(screen.getByLabelText('Remaining to allocate')).toHaveTextContent('€15.00 left')
    // Done is held back while the split does not add up; Escape leaves the split as it is.
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Split' })).not.toBeInTheDocument())

    expect(screen.getByText(/Finish the highlighted rows first/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('marks a flagged row as a transfer and commits it with the counterparty', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    expect(screen.getByText('Looks like a transfer')).toBeInTheDocument()
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    expect(screen.getByRole('dialog', { name: 'Transfer' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16'), 'acc2')
    await done(user)
    // The row's category cell names the other side.
    expect(screen.getByRole('button', { name: /^Edit transfer for E-BANKING PAYMENT on 2026-06-16:/ })).toHaveTextContent('from Joint Savings')

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [accountArg, items] = mockCommit.mock.calls[0]
    expect(accountArg).toBe('acc1')
    const transfer = items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT')
    expect(transfer).toEqual(expect.objectContaining({ transferAccountId: 'acc2', budgetItemId: null, memberId: null }))
  })

  // Rules 50/51/72 — a credit marked as a transfer is held for review unless the user picks the
  // recorded transfer it confirms; candidates are suggestions, choosing one fixes the counterparty,
  // and the commit carries the chosen transfer so no second balance movement is recorded.
  it('offers recorded-transfer candidates on a transfer row and commits the chosen match', { timeout: 15000 }, async () => {
    const preview = previewWithTransfer()
    const credit = preview.items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT') as { transferMatches?: unknown[] }
    credit.transferMatches = [
      {
        transferId: 'tr-1', counterpartyAccountId: 'acc2', counterpartyAccountName: 'Pot',
        amount: 234.24, currency: 'EUR', departedOn: '2026-06-15', receivedOn: null, payee: 'Transfer',
      },
    ]
    mockPreview.mockResolvedValue(preview)
    mockCommit.mockResolvedValue({
      totalEntries: 2, imported: 1, skippedDuplicates: 0, credits: 0, debits: 1,
      autoCategorized: 0, transfers: 1, matchedTransfers: 1, pendingReviewTransfers: 0,
    })
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    // Without a chosen match a credit is a receipt with an unknown departure.
    expect(screen.getByText(/Held for review until the departure date is known/)).toBeInTheDocument()
    const match = matchGroup('E-BANKING PAYMENT on 2026-06-16')
    expect(matchOptions('E-BANKING PAYMENT on 2026-06-16')).toHaveLength(2) // "record as new" + the one candidate
    expect(match).toHaveTextContent('From Pot')

    await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /From Pot/)
    expect(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).toHaveValue('acc2')
    expect(screen.getByText(/Confirms the other side of the recorded transfer/)).toBeInTheDocument()
    await done(user)

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    const transfer = items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT')
    expect(transfer).toEqual(expect.objectContaining({ transferAccountId: 'acc2', matchTransferId: 'tr-1' }))
    // The result reports the confirmation separately from newly recorded transfers.
    expect(await screen.findByText('Matched')).toBeInTheDocument()
  })

  // A matched transfer's fee is judged as the server judges it on every commit that carries a
  // fee: the bank's departure date against the fee line's own month. A fee left on the May line
  // the recorded transfer gave it, departed 28 May, needs no question (#279 P3-8); the same fee
  // on a June line, or on a recorded line that is in June, does (#286 P2-1).
  it('asks the cross-month question for a fee only when its date leaves its line’s month', { timeout: 20000 }, async () => {
    const withCandidate = (feeBudgetItemId: string, feeBudgetItemMonth: string) => {
      const preview = previewWithTransfer()
      const credit = preview.items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT') as { transferMatches?: unknown[] }
      credit.transferMatches = [
        {
          transferId: 'tr-1', counterpartyAccountId: 'acc2', counterpartyAccountName: 'Pot',
          amount: 240, currency: 'EUR', departedOn: '2026-05-28', receivedOn: null, payee: 'Transfer',
          fee: 5.76, feeBudgetItemId, feeBudgetItemMonth,
        },
      ]
      return preview
    }
    mockPreview.mockResolvedValue(withCandidate('bi-may-fees', '2026-05-01'))
    mockCommit.mockResolvedValue({
      totalEntries: 2, imported: 1, skippedDuplicates: 0, credits: 0, debits: 1,
      autoCategorized: 0, transfers: 1, matchedTransfers: 1, pendingReviewTransfers: 0,
    })
    const user = userEvent.setup()
    renderPage()

    const review = async () => {
      await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
      await user.upload(screen.getByLabelText(/^Statement file/), csv())
      await user.click(screen.getByRole('button', { name: 'Review transactions' }))
      await screen.findByText('E-BANKING PAYMENT')
      await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
      await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /From Pot/)
    }
    await review()
    // The fee's line is pre-filled with the one the recorded transfer already has (May's line).
    expect(screen.getByLabelText('Fee category for E-BANKING PAYMENT on 2026-06-16')).toHaveValue('bi-may-fees')
    await done(user)

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Budget to a different month?')).not.toBeInTheDocument()
    const [, items] = mockCommit.mock.calls[0]
    const transfer = items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT') as { acknowledgeCrossMonth?: boolean }
    expect(transfer.acknowledgeCrossMonth).toBeUndefined()
    expect(await screen.findByText('Import complete')).toBeInTheDocument()

    // The same fee moved to a June line while dated 28 May asks the question.
    mockCommit.mockClear()
    await user.click(screen.getByRole('button', { name: 'Import another file' }))
    await review()
    await user.selectOptions(screen.getByLabelText('Fee category for E-BANKING PAYMENT on 2026-06-16'), 'bi2')
    await done(user)
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    expect(await screen.findByText('Budget to a different month?')).toBeInTheDocument()
    expect(mockCommit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Go back' }))

    // A recorded fee whose line is in June (the transfer was entered by hand on 1 June) is
    // refused by the server once the bank dates the departure 28 May, so the question is asked
    // before sending, with the line left as it is.
    mockPreview.mockResolvedValue(withCandidate('bi2', '2026-06-01'))
    await user.click(screen.getByRole('button', { name: 'Choose a different file' }))
    await review()
    expect(screen.getByLabelText('Fee category for E-BANKING PAYMENT on 2026-06-16')).toHaveValue('bi2')
    await done(user)
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    expect(await screen.findByText('Budget to a different month?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Import anyway' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, acknowledged] = mockCommit.mock.calls[0]
    expect(acknowledged.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT')).toEqual(
      expect.objectContaining({ feeBudgetItemId: 'bi2', acknowledgeCrossMonth: true }),
    )
    expect(await screen.findByText('Import complete')).toBeInTheDocument()

    // A receipt credited on 16 June before a departure recorded on 2 July pulls the departure
    // back to 16 June, and the fee with it: its July line is now a month away, so ask.
    mockCommit.mockClear()
    mockPreview.mockResolvedValue(withCandidate('bi-july-fees', '2026-07-01'))
    const preview = mockPreview.mock.results.length ? await mockPreview() : null
    if (preview) (preview.items[0] as { transferMatches: { departedOn: string }[] }).transferMatches[0].departedOn = '2026-07-02'
    mockPreview.mockResolvedValue(preview)
    await user.click(screen.getByRole('button', { name: 'Import another file' }))
    await review()
    await done(user)
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    expect(await screen.findByText('Budget to a different month?')).toBeInTheDocument()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  // The server's own cross-month refusal (a case the screen did not foresee) is the same
  // question, not a dead-end banner: "Import anyway" re-sends with the lines acknowledged.
  it('turns the server’s cross-month refusal into the question and re-sends acknowledged', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    mockCommit
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { errors: { crossMonth: ['The fee is dated 2026-05 but that budget line is in 2026-06.'] } },
        },
      })
      .mockResolvedValueOnce(committed())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await goToReview(user)
    await pickCategory(user, 'AUTOMARKET on 2026-06-17', 'bi2')
    await user.click(screen.getByRole('button', { name: /Import \d+ transactions?/ }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Budget to a different month?')).toBeInTheDocument()
    expect(screen.getByText(/The fee is dated 2026-05 but that budget line is in 2026-06\./)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import anyway' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(2))
    const [, items] = mockCommit.mock.calls[1]
    expect(items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')).toEqual(expect.objectContaining({ budgetItemId: 'bi2', acknowledgeCrossMonth: true }))
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
  })

  // Rule 71 — a debit marked as a transfer is a confirmed departure with the receipt still unknown.
  it('explains that a debit transfer row is recorded as departed and in transit', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    expect(screen.getByText(/Recorded as departed on/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Match recorded transfer for AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()
  })

  it('blocks import while a transfer has no counterparty chosen', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    await done(user)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled(),
    )
    // The row says what is missing.
    expect(screen.getByRole('button', { name: /^Edit transfer for E-BANKING PAYMENT on 2026-06-16:/ })).toHaveTextContent('Choose account…')
    expect(screen.getByText(/Finish the highlighted rows first/)).toBeInTheDocument()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('unticks possible duplicates by default, badges them, and keeps them out of the commit', { timeout: 15000 }, async () => {
    const dupPreview = preview()
    dupPreview.items[1] = { ...dupPreview.items[1], possibleDuplicate: true } // WOLT
    mockPreview.mockResolvedValue(dupPreview)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // Badged, counted behind the list bar's (i), and unticked by default.
    expect(screen.getByText('Possible duplicate')).toBeInTheDocument()
    expect(await openHint(user, 'About skipped rows')).toHaveTextContent(/1 possible duplicate unticked \(tick to include\)\./)
    await closeHint(user, 'About skipped rows')
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

    // The file strip names the format chosen; the (i) beside it says what was recognised.
    expect(screen.getByText('Bank CSV')).toBeInTheDocument()
    expect(await openHint(user, 'About the format')).toHaveTextContent(/recognised this file as an HSBC transaction history export/)
  })

  it('shows no recognised-format notice when the generic path was used', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...csvPreview(), detectedFormat: 'GenericCsv' })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(screen.queryByRole('button', { name: 'About the format' })).not.toBeInTheDocument()
    expect(screen.queryByText(/recognised this file as/)).not.toBeInTheDocument()
  })

  it('takes a PDF statement through the Bank CSV path and names it PDF', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...csvPreview(), detectedFormat: 'GenericCsv' })
    const user = userEvent.setup()
    renderPage()

    const input = await screen.findByLabelText(/^Statement file/)
    expect(input).toHaveAttribute('accept', expect.stringContaining('.pdf'))
    await user.upload(input, new File(['%PDF-1.7'], 'statement.pdf', { type: 'application/pdf' }))
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(mockPreview.mock.calls[0][1]).toBe('GenericCsv')
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument()
  })

  it('says how many lines with an amount were not read', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...csvPreview(), detectedFormat: 'GenericCsv', unreadLines: 2 })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    expect(screen.getByText('2 not read')).toBeInTheDocument()
    expect(await openHint(user, 'About lines not read')).toHaveTextContent(/2 lines with an amount were left out/)
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

  // A row the server skipped as already imported moved no money, so the done screen's sums leave
  // it out (it names the skipped rows by reference); a row still waiting for its amount in the
  // budget currency is counted and explained.
  it('leaves a row the server skipped out of the money sums and counts the rows waiting for an amount', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user) // AUTOMARKET 35 (debit), WOLT 80.90 (debit)
    mockCommit.mockResolvedValue({
      ...committed(), imported: 1, skippedDuplicates: 1, skippedReferences: ['hsbc:b#0'], credits: 0, debits: 1, awaitingAmount: 1,
    })

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await screen.findByText('Import complete')

    expect(screen.getByText('1 transaction added, 1 skipped.')).toBeInTheDocument()
    const moneyOut = screen.getByText('Money out').closest('div')!
    expect(moneyOut).toHaveTextContent('€35.00') // WOLT's 80.90 was skipped
    expect(moneyOut).not.toHaveTextContent('115.90')
    expect(screen.getByText('Waiting for EUR amount').closest('div')!).toHaveTextContent('1')
    expect(await openHint(user, 'About the rows waiting for an amount')).toHaveTextContent(
      /1 row is in another currency and is not counted anywhere until its amount in EUR is entered/,
    )
  })

  it('blocks import until an edited mapping is re-scanned, keeping categorisation across the re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    // Categorise TESCO, then edit the mapping — import must block and warn until a re-scan.
    await pickCategory(user, 'TESCO on 2026-06-20', 'bi1')
    expect(categoryChip('TESCO on 2026-06-20')).toHaveTextContent('Groceries')
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.selectOptions(screen.getByLabelText('Description column'), '3')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    expect(screen.getByText(/changed the column mapping/)).toBeInTheDocument()

    // Cancelling the dialog puts the mapping back as scanned: nothing to apply, Import unblocked.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Columns' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect(screen.getByLabelText('Description column')).toHaveValue('1')
    await user.selectOptions(screen.getByLabelText('Description column'), '3')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()

    // Re-scan returns the same rows (unchanged references) → the category is preserved and import unblocks.
    mockPreview.mockResolvedValue(csvPreview())
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Columns' })).not.toBeInTheDocument())
    expect(categoryChip('TESCO on 2026-06-20')).toHaveTextContent('Groceries')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
  })

  it('shows an all-caught-up message when every row was already imported', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...preview(), newCount: 0, skippedDuplicates: 3, items: [] })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
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

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect(screen.getByLabelText('Date format')).toHaveValue('yyyy-MM-dd')
    expect(screen.getByText(/We read your dates as/)).toHaveTextContent('YYYY-MM-DD')
  })

  it('shows the server error message when the preview fails', { timeout: 15000 }, async () => {
    mockPreview.mockRejectedValue({ response: { data: { title: 'No transactions were found.' } } })
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No transactions were found')
  })
})

// W07 — returns, transfer fees and reused bank references on the review grid.
describe('ImportPage transfer returns, fees and reused references', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPreview.mockReset()
    mockCommit.mockReset()
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      return Promise.resolve({ data: [] })
    })
    mockCommit.mockResolvedValue(committed())
  })

  async function reviewIntoAccount(user: ReturnType<typeof userEvent.setup>, payee: string) {
    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText(payee)
  }

  const candidate = {
    counterpartyAccountId: 'acc2', counterpartyAccountName: 'Pot', currency: 'EUR', payee: 'Transfer',
    receivedOn: null, recordedDate: null, sameReference: false, fee: null,
  }

  it('a Return candidate on a credit row sends returnOfTransferId only', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[0] = {
      ...data.items[0],
      likelyTransfer: false,
      transferMatches: [{ ...candidate, transferId: 'tr-back', amount: 234.24, departedOn: '2026-06-10', kind: 'Return' }],
    }
    mockPreview.mockResolvedValue(data)
    mockCommit.mockResolvedValue({ ...committed(), imported: 1, transfers: 0, returned: 1 })
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'E-BANKING PAYMENT')

    expect(screen.getByText('Looks like a transfer coming back')).toBeInTheDocument()
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    const match = matchGroup('E-BANKING PAYMENT on 2026-06-16')
    expect(match).toHaveTextContent(`Returned: transfer to Pot on ${formatDate('2026-06-10')}`)
    await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /Returned: transfer to Pot/)
    // A return names no counterparty.
    expect(screen.queryByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).not.toBeInTheDocument()
    expect(screen.getByText(/Records the transfer to Pot as returned/)).toBeInTheDocument()
    await done(user)
    expect(screen.getByRole('button', { name: /^Edit transfer for E-BANKING PAYMENT on 2026-06-16:/ })).toHaveTextContent('coming back')

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    const returned = items.find((i: { payee: string }) => i.payee === 'E-BANKING PAYMENT')
    expect(returned).toEqual(
      expect.objectContaining({ returnOfTransferId: 'tr-back', transferAccountId: null, matchTransferId: null, budgetItemId: null, memberId: null }),
    )
    expect(returned).not.toHaveProperty('jarAllocations')
    expect(returned).not.toHaveProperty('splits')
    // The result reports the return.
    const tile = (await screen.findByText('Returned')).closest('div')!
    expect(tile).toHaveTextContent('1')
  })

  it('a fee candidate asks for the fee line and echoes the fee on commit', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[1] = {
      ...data.items[1],
      transferMatches: [
        { ...candidate, transferId: 'tr-same', amount: 35, departedOn: '2026-06-17', kind: 'Match', sameReference: true },
        { ...candidate, transferId: 'tr-fee', amount: 33, departedOn: '2026-06-15', kind: 'Match', fee: 2, recordedDate: '2026-06-15' },
      ],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    // The server's order is kept.
    const options = matchOptions('AUTOMARKET on 2026-06-17')
    expect(options[1]).toMatch(/To Pot .* same bank reference/)
    expect(options[2]).toMatch(/with a fee of €2\.00/)

    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /same bank reference/)
    expect(screen.getByText('Same bank reference')).toBeInTheDocument()
    expect(screen.queryByLabelText('Fee category for AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()

    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /with a fee of/)
    expect(screen.getByText(/Recorded in the app on .*; the bank.s date will be used/)).toBeInTheDocument()
    // The candidate names no current fee line, so the fee needs one before the import (rule 91).
    expect(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17')).toHaveValue('')
    expect(screen.getByText('Choose the fee’s category.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17'), 'bi2')
    expect(screen.queryByText('Choose the fee’s category.')).not.toBeInTheDocument()
    await done(user)
    // The row shows the fee under the amount.
    expect(screen.getByText('+ fee €2.00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')).toEqual(
      expect.objectContaining({ transferAccountId: 'acc2', matchTransferId: 'tr-fee', fee: 2, feeBudgetItemId: 'bi2' }),
    )
  })

  it('an unmatched debit transfer can carry a typed fee', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    await user.selectOptions(screen.getByLabelText('Transfer account for AUTOMARKET on 2026-06-17'), 'acc2')
    const fee = screen.getByLabelText('Fee for AUTOMARKET on 2026-06-17')

    // A fee as large as the row is refused.
    await user.type(fee, '35')
    expect(screen.getByText(/The fee must be more than zero and less than/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import \d transaction/ })).toBeDisabled()

    await user.clear(fee)
    await user.type(fee, '2')
    // The fee's (i) says how the row is recorded.
    expect(await openHint(user, 'About the fee')).toHaveTextContent(/A transfer of €33\.00 plus a fee of €2\.00/)
    await closeHint(user, 'About the fee')
    // A typed fee also needs its line before the import.
    expect(screen.getByText('Choose the fee’s category.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17'), 'bi1')
    await done(user)

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')).toEqual(
      expect.objectContaining({ amount: 35, transferAccountId: 'acc2', matchTransferId: null, fee: 2, feeBudgetItemId: 'bi1' }),
    )
  })

  it('a row reusing a known bank reference is flagged, counted and starts unticked', { timeout: 15000 }, async () => {
    const data = preview()
    data.items[1] = { ...data.items[1], reference: 'hsbc:b#0~2', reusedReference: { date: '2026-05-15', amount: 12, isCredit: false } }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    expect(screen.getByText('Same reference')).toBeInTheDocument()
    expect(await openHint(user, 'About the bank reference of WOLT')).toHaveTextContent(
      /An entry with this bank reference was already imported: .*€12\.00\. Tick it only if this is a/,
    )
    await closeHint(user, 'About the bank reference of WOLT')
    expect(await openHint(user, 'About skipped rows')).toHaveTextContent(/1 reusing a known bank reference unticked/)
    await closeHint(user, 'About skipped rows')
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()

    // Ticked back in, the derived reference goes back unchanged.
    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15'))
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items.map((i: { reference: string }) => i.reference)).toContain('hsbc:b#0~2')
  })

  it('a fee candidate pre-fills the line its current fee is on', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[1] = {
      ...data.items[1],
      transferMatches: [
        { ...candidate, transferId: 'tr-fee', amount: 33, departedOn: '2026-06-15', kind: 'Match', fee: 2, feeBudgetItemId: 'bi2' },
      ],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    const match = matchGroup('AUTOMARKET on 2026-06-17')
    // Nothing is chosen for the user, even with a single candidate (rule 50).
    expect(within(match).getByRole('radio', { name: 'No — record it as a new transfer' })).toBeChecked()
    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /with a fee of/)
    expect(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17')).toHaveValue('bi2')
    expect(screen.queryByText('Choose the fee’s category.')).not.toBeInTheDocument()

    // Going back to "record it as a new transfer" drops the candidate's line with its fee.
    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', '')
    await user.type(screen.getByLabelText('Fee for AUTOMARKET on 2026-06-17'), '1')
    expect(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17')).toHaveValue('')
    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /with a fee of/)
    expect(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17')).toHaveValue('bi2')
    await done(user)

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')).toEqual(
      expect.objectContaining({ matchTransferId: 'tr-fee', fee: 2, feeBudgetItemId: 'bi2' }),
    )
  })

  it('a fee line from another month stays chosen', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[1] = {
      ...data.items[1],
      transferMatches: [
        { ...candidate, transferId: 'tr-fee', amount: 33, departedOn: '2026-06-15', kind: 'Match', fee: 2, feeBudgetItemId: 'bi-may' },
      ],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /with a fee of/)
    const line = screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17') as HTMLSelectElement
    expect(line.value).toBe('bi-may')
    expect(line.selectedOptions[0]).toHaveTextContent('The fee’s current line')
    await done(user)
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
  })

  it('a match whose counterparty is private to another login commits without an account', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[1] = {
      ...data.items[1],
      transferMatches: [
        { ...candidate, counterpartyAccountId: null, counterpartyAccountName: 'Private account', transferId: 'tr-priv', amount: 35, departedOn: null, receivedOn: '2026-06-18', kind: 'Match' },
      ],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await reviewIntoAccount(user, 'AUTOMARKET')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    const match = matchGroup('AUTOMARKET on 2026-06-17')
    expect(match).toHaveTextContent('To Private account')
    await chooseMatch(user, 'AUTOMARKET on 2026-06-17', /To Private account/)
    // The counterparty is named, not chosen, and the row is complete without an account.
    expect(screen.queryByLabelText('Transfer account for AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Transfer' })).getByText('Private account')).toBeInTheDocument()
    await done(user)
    expect(screen.getByRole('button', { name: /^Edit transfer for AUTOMARKET on 2026-06-17:/ })).toHaveTextContent('to Private account')
    expect(screen.queryByText(/Finish the highlighted rows first/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0]
    expect(items.find((i: { payee: string }) => i.payee === 'AUTOMARKET')).toEqual(
      expect.objectContaining({ transferAccountId: null, matchTransferId: 'tr-priv', budgetItemId: null }),
    )

  })

  it('the summary reads naturally with reused references alone or beside possible duplicates', { timeout: 15000 }, async () => {
    const data = preview()
    data.items[1] = { ...data.items[1], reference: 'hsbc:b#0~2', reusedReference: { date: '2026-05-15', amount: 12, isCredit: false } }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    const first = renderPage()
    await goToReview(user)
    // The list bar's chip counts the rows skipped; its (i) says what else starts unticked.
    expect(screen.getByRole('heading', { name: '2 new transactions to review' })).toBeInTheDocument()
    expect(screen.getByText('1 already imported')).toBeInTheDocument()
    const summary = await openHint(user, 'About skipped rows')
    expect(summary.textContent).not.toMatch(/;/)
    expect(summary).toHaveTextContent(/A possible duplicate .* starts unticked: tick it to import it anyway\./)
    expect(summary).toHaveTextContent(/1 reusing a known bank reference unticked \(tick to include\)\./)
    await closeHint(user, 'About skipped rows')
    first.unmount()

    const both = preview()
    both.items[0] = { ...both.items[0], possibleDuplicate: true }
    both.items[1] = { ...both.items[1], reference: 'hsbc:b#0~2', reusedReference: { date: '2026-05-15', amount: 12, isCredit: false } }
    mockPreview.mockResolvedValue(both)
    renderPage()
    await goToReview(user)
    expect(await openHint(user, 'About skipped rows')).toHaveTextContent(
      /1 possible duplicate unticked and 1 reusing a known bank reference unticked \(tick to include\)\./,
    )
  })

  it('"Include all rows" leaves rows reusing a known bank reference unticked', { timeout: 15000 }, async () => {
    const data = preview()
    data.items[0] = { ...data.items[0], possibleDuplicate: true }
    data.items[1] = { ...data.items[1], reference: 'hsbc:b#0~2', reusedReference: { date: '2026-05-15', amount: 12, isCredit: false } }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    const all = screen.getByLabelText('Include all rows')
    await user.click(all)
    // A possible duplicate is ticked with the rest; a reused reference is opted in on its own (rule 88).
    expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).toBeChecked()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()
    expect(all).toBeChecked()

    // Ticked by hand it stays ticked; unticking all clears every row.
    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15'))
    await user.click(all)
    expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).not.toBeChecked()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()
  })
})
