import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AccountDto,
  BudgetMonthDto,
  HouseholdMemberDto,
  ImportPreviewResult,
  ImportStatementResult,
  JarAccountLedgerDto,
} from '../types'

// Rules 74/78/79 on the import review: the jar prompts for money into/out of a jar-backed
// account, and rows held because the account would go below zero. Mirrors ImportPage.test.tsx's
// harness (the shared api mock plus hoisted previewImport/commitImport spies).
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
import { account, committed as sharedCommitted } from '../test/fixtures/import'

// HSBC Current holds 550; Joint Savings is empty.
const accounts: AccountDto[] = [account({ currentBalance: 550 }), account({ id: 'acc2', name: 'Joint Savings', type: 1, displayOrder: 1 })]
const members: HouseholdMemberDto[] = []

// HSBC Current backs two jars; Joint Savings backs none (so it is absent from the ledgers).
const ledgers: JarAccountLedgerDto[] = [
  {
    accountId: 'acc1', accountName: 'HSBC Current', currency: 'EUR', asOf: '2026-06-30',
    accountBalance: 550, unallocated: 300, positiveAllocations: 250, hasBackingDeficit: false,
    unreconciledAllocations: 0, requiresReview: false,
    jars: [
      { jarId: 'j1', name: 'Holiday', balance: 200, isArchived: false },
      { jarId: 'j2', name: 'Car', balance: 50, isArchived: false },
      { jarId: 'j9', name: 'Old boiler', balance: 0, isArchived: true },
    ],
  },
]

// Groceries/Soap are ordinary lines; "Holiday" is a jar line (savingsId names its jar).
const month = {
  id: 'mo1', key: '2026-06', year: 2026, month: 6, baseCurrency: 'EUR',
  totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false,
  categories: [
    { id: 'c0', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0,
      items: [
        { id: 'bi0', name: 'Salary', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
      ] },
    { id: 'c1', name: 'Food', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0,
      items: [
        { id: 'bi1', name: 'Groceries', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
        { id: 'bi2', name: 'Soap', displayOrder: 1, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
      ] },
    { id: 'c2', name: 'Jars', kind: 'Savings', displayOrder: 2, totalPlanned: 0, totalActual: 0,
      items: [
        { id: 'bi3', name: 'Holiday', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: 'j1', savingsAvailable: 200, dueDay: null, isPaid: false },
      ] },
  ],
} as unknown as BudgetMonthDto

// One credit and three debits into HSBC Current.
function preview(): ImportPreviewResult {
  return {
    totalEntries: 4, newCount: 4, skippedDuplicates: 0, credits: 1, debits: 3,
    items: [
      { reference: 'hsbc:s#0', date: '2026-06-01', payee: 'SALARY', amount: 2500, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      { reference: 'hsbc:h#0', date: '2026-06-10', payee: 'HOLIDAY FUND', amount: 100, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'hsbc:w#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

// The commit's answer to this file's preview: one credit and three debits.
const committed = (over: Partial<ImportStatementResult> = {}) =>
  sharedCommitted({ totalEntries: 4, imported: 4, credits: 1, debits: 3, ...over })

const renderPage = () => renderWithProviders(<ImportPage />)

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })

async function goToReview(user: ReturnType<typeof userEvent.setup>, accountId = 'acc1') {
  if (accountId) await user.selectOptions(await screen.findByLabelText(/Add to account/), accountId)
  await user.upload(await screen.findByLabelText('Statement file'), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

/** The review row holding this include checkbox (the jar select sits in its category cell). */
function rowOf(includeLabel: string): HTMLElement {
  return screen.getByLabelText(includeLabel).closest('tr') as HTMLElement
}

type SentItem = { reference: string; payee: string; jarAllocations?: unknown; paidFromJarId?: string | null }

describe('ImportPage — jars (rules 78/79) and held rows (rule 74)', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPreview.mockReset()
    mockCommit.mockReset()
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      if (url === '/jars/ledger') return Promise.resolve({ data: ledgers })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(preview())
    mockCommit.mockResolvedValue(committed())
  })

  it('asks which jars a credit goes into and which jar a non-jar-line debit comes from, and sends both', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // The credit gets the "put into jars" fields (active jars only), all empty = unallocated.
    const fields = within(screen.getByRole('group', { name: 'Put into jars in HSBC Current' }))
    expect(fields.getByLabelText('Amount for Holiday')).toHaveValue('')
    expect(fields.getByLabelText('Amount for Car')).toHaveValue('')
    expect(fields.queryByLabelText('Amount for Old boiler')).not.toBeInTheDocument()
    await user.type(fields.getByLabelText('Amount for Holiday'), '500')
    expect(fields.getByText(/Stays unallocated/)).toBeInTheDocument()

    // AUTOMARKET sits on Groceries (not a jar line): "From jar" defaults to unallocated.
    const fromJar = within(rowOf('Include AUTOMARKET on 2026-06-17')).getByLabelText('From jar') as HTMLSelectElement
    expect(fromJar.value).toBe('')
    expect([...fromJar.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'j1', 'j2'])
    await user.selectOptions(fromJar, 'j2')
    // Debits with no line ask nothing.
    expect(within(rowOf('Include WOLT on 2026-06-15')).queryByLabelText('From jar')).not.toBeInTheDocument()
    expect(within(rowOf('Include HOLIDAY FUND on 2026-06-10')).queryByLabelText('From jar')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [accountArg, items] = mockCommit.mock.calls[0] as [string | null, SentItem[]]
    expect(accountArg).toBe('acc1')
    const salary = items.find((i) => i.payee === 'SALARY')!
    expect(salary.jarAllocations).toEqual([{ jarId: 'j1', amount: 500 }])
    expect(salary).not.toHaveProperty('paidFromJarId')
    const automarket = items.find((i) => i.payee === 'AUTOMARKET')!
    expect(automarket.paidFromJarId).toBe('j2')
    expect(automarket).not.toHaveProperty('jarAllocations')
    // A debit that asked nothing still says "unallocated" explicitly (never a stale jar).
    expect(items.find((i) => i.payee === 'WOLT')!.paidFromJarId).toBeNull()
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
  })

  // W07: money coming back from a returned transfer goes back to the jars it left from, so a
  // return row asks no jar question and sends no jar answer.
  it('asks no jar question for a credit that returns a transfer', { timeout: 15000 }, async () => {
    const data = preview()
    data.items[0] = {
      ...data.items[0],
      transferMatches: [
        {
          transferId: 'tr-back', counterpartyAccountId: 'acc2', counterpartyAccountName: 'Joint Savings', amount: 2500,
          currency: 'EUR', departedOn: '2026-05-28', receivedOn: null, payee: 'Transfer', kind: 'Return', fee: null,
          recordedDate: null, sameReference: false,
        },
      ],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    expect(screen.getByRole('group', { name: 'Put into jars in HSBC Current' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark SALARY on 2026-06-01 as a transfer' }))
    await user.selectOptions(screen.getByLabelText('Match recorded transfer for SALARY on 2026-06-01'), 'tr-back')
    expect(screen.queryByRole('group', { name: 'Put into jars in HSBC Current' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0] as [string | null, SentItem[]]
    const back = items.find((i) => i.payee === 'SALARY')!
    expect(back).toEqual(expect.objectContaining({ returnOfTransferId: 'tr-back', transferAccountId: null }))
    expect(back).not.toHaveProperty('jarAllocations')
    expect(back).not.toHaveProperty('paidFromJarId')
  })

  it('shows no jar select on a jar line, one for a split with a non-jar slice, and one for a transfer out', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // HOLIDAY FUND put on the Holiday jar line: the line already names the jar.
    const holiday = rowOf('Include HOLIDAY FUND on 2026-06-10')
    await user.selectOptions(within(holiday).getByLabelText('Category for HOLIDAY FUND on 2026-06-10'), 'bi3')
    expect(within(holiday).queryByLabelText('From jar')).not.toBeInTheDocument()
    // …and back on Soap it asks again.
    await user.selectOptions(within(holiday).getByLabelText('Category for HOLIDAY FUND on 2026-06-10'), 'bi2')
    expect(within(holiday).getByLabelText('From jar')).toBeInTheDocument()

    // A split: jar line + jar line asks nothing; any non-jar slice asks once.
    await user.click(screen.getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' }))
    await user.selectOptions(screen.getByLabelText('Split line 1 category for AUTOMARKET'), 'bi3')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20')
    await user.selectOptions(screen.getByLabelText('Split line 2 category for AUTOMARKET'), 'bi3')
    await user.type(screen.getByLabelText('Split line 2 amount for AUTOMARKET'), '15')
    expect(within(rowOf('Include AUTOMARKET on 2026-06-17')).queryByLabelText('From jar')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Split line 2 category for AUTOMARKET'), 'bi1')
    expect(within(rowOf('Include AUTOMARKET on 2026-06-17')).getAllByLabelText('From jar')).toHaveLength(1)

    // A debit marked as a transfer to another account asks which jar the money leaves.
    await user.click(screen.getByRole('button', { name: 'Mark WOLT on 2026-06-15 as a transfer' }))
    const wolt = rowOf('Include WOLT on 2026-06-15')
    await user.selectOptions(within(wolt).getByLabelText('Transfer account for WOLT on 2026-06-15'), 'acc2')
    await user.selectOptions(within(wolt).getByLabelText('From jar'), 'j1')

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0] as [string | null, SentItem[]]
    expect(items.find((i) => i.payee === 'WOLT')).toEqual(expect.objectContaining({ transferAccountId: 'acc2', paidFromJarId: 'j1' }))
    expect(items.find((i) => i.payee === 'AUTOMARKET')!.paidFromJarId).toBeNull()
  })

  it('keeps the jar fields on a credit marked as a transfer (applied once the departure is known)', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Mark SALARY on 2026-06-01 as a transfer' }))
    await user.selectOptions(screen.getByLabelText('Transfer account for SALARY on 2026-06-01'), 'acc2')
    const fields = within(screen.getByRole('group', { name: 'Put into jars in HSBC Current' }))
    await user.type(fields.getByLabelText('Amount for Car'), '1000')
    expect(screen.getByText(/These jar amounts apply once the transfer’s departure is confirmed/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0] as [string | null, SentItem[]]
    expect(items.find((i) => i.payee === 'SALARY')).toEqual(
      expect.objectContaining({ transferAccountId: 'acc2', jarAllocations: [{ jarId: 'j2', amount: 1000 }] }),
    )
  })

  it('blocks the import while a credit\'s jar amounts exceed what arrived', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    const fields = within(screen.getByRole('group', { name: 'Put into jars in HSBC Current' }))
    await user.type(fields.getByLabelText('Amount for Holiday'), '3000')
    expect(fields.getByText(/The jar amounts exceed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 4 transactions' })).toBeDisabled()
    expect(screen.getByText(/jar amounts can’t exceed what arrived/)).toBeInTheDocument()
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('shows no jar prompts when the import account backs no jars, or no account is chosen', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc2')
    expect(screen.queryByRole('group', { name: /Put into jars/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('From jar')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    const [, items] = mockCommit.mock.calls[0] as [string | null, SentItem[]]
    for (const item of items) {
      expect(item).not.toHaveProperty('jarAllocations')
      expect(item).not.toHaveProperty('paidFromJarId')
    }
  })

  it('keeps held rows in review with the server\'s reason, re-commits only them, then reports them on the done screen', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const reason = 'HSBC Current would be -50.00 EUR on 2026-06-15. An account never goes below zero here: record the money that reached it first, or correct this amount.'
    mockCommit.mockResolvedValueOnce(committed({ imported: 3, skippedDuplicates: 1, held: [{ reference: 'hsbc:w#0', message: reason }], heldCount: 1 }))
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))

    // Not done: the review stays open for just the held row, with the reason and what went in.
    expect(screen.queryByText('Import complete')).not.toBeInTheDocument()
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('1 row was held because the account would go below zero on its date.')
    expect(banner).toHaveTextContent('Record the missing money first and commit again, or untick a row to discard it.')
    expect(banner).toHaveTextContent('3 transactions imported, 1 skipped')
    expect(screen.getByText('WOLT')).toBeInTheDocument()
    expect(screen.getByText('Held')).toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.queryByText('AUTOMARKET')).not.toBeInTheDocument()
    expect(screen.queryByText('SALARY')).not.toBeInTheDocument()
    expect(screen.queryByText(/new transactions to review/)).not.toBeInTheDocument()

    // The re-commit sends only the held row (its review choices intact).
    mockCommit.mockResolvedValueOnce(committed({ totalEntries: 1, imported: 1, debits: 1 }))
    await user.click(screen.getByRole('button', { name: 'Commit held rows' }))
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(2))
    const [, items] = mockCommit.mock.calls[1] as [string | null, SentItem[]]
    expect(items.map((i) => i.reference)).toEqual(['hsbc:w#0'])

    // Done: the counts add up across both commits and the held rows are reported.
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
    expect(screen.getByText('Imported').closest('div')).toHaveTextContent('4')
    expect(screen.getByText('Skipped').closest('div')).toHaveTextContent('1')
    expect(screen.getByText('Held').closest('div')).toHaveTextContent('1')
    // Money out sums every accepted row (35 + 100 + 80.90), across both commits.
    expect(screen.getByText('Money out').closest('div')).toHaveTextContent('€215.90')
    expect(screen.getByText('Money in').closest('div')).toHaveTextContent('€2,500.00')
  })

  it('lets a held row be discarded by unticking it, then finishes without a further commit', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockCommit.mockResolvedValueOnce(committed({ imported: 3, held: [{ reference: 'hsbc:w#0', message: 'Would be -50.00 EUR.' }], heldCount: 1 }))
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))
    await screen.findByText('Would be -50.00 EUR.')

    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15')) // untick = discard
    await user.click(screen.getByRole('button', { name: 'Finish without the held rows' }))

    expect(await screen.findByText('Import complete')).toBeInTheDocument()
    expect(mockCommit).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Imported').closest('div')).toHaveTextContent('3')
    expect(screen.getByText('Held').closest('div')).toHaveTextContent('1')
  })

  it('shows the server\'s validation messages verbatim when the commit is refused', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockCommit.mockRejectedValue({
      response: { status: 400, data: { errors: { Items: ['Holiday is not a jar of HSBC Current.'] } } },
    })
    renderPage()
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: 'Import 4 transactions' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Holiday is not a jar of HSBC Current.')
    expect(screen.queryByText('Import complete')).not.toBeInTheDocument()
  })
})
