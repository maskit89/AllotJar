import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, ImportPreviewResult, JarAccountLedgerDto } from '../types'

/*
 * Request parity (restyle PR 14): the review's new surfaces (the row ⋯ menus, the Transfer, Split, Member and From
 * jar dialogs, the Columns dialog, the jar toggle) send byte-for-byte what the page sent before the restyle for the
 * same choices. The expected strings below were recorded from the page as it was at 2883caa, driven through the same
 * eight scenarios (the brief's list: a Bank CSV with a re-scan, an HSBC file, a CAMT.053 file into a jar-backed
 * account, a split row, a transfer matched to a recorded one, a new transfer with a typed fee, a return, an unticked
 * duplicate) by /tmp/claude-0/imp-tools/parity/ImportPage.base.capture.test.tsx. Each is `JSON.stringify` of the
 * arguments handed to previewImport ([format, opts]) and commitImport ([accountId, items]), which api.ts serialises
 * as they are, so the key order is the wire order.
 */
const { mockPreview, mockCommit } = vi.hoisted(() => ({ mockPreview: vi.fn(), mockCommit: vi.fn() }))
vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, { previewImport: mockPreview, commitImport: mockCommit }),
)

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ImportPage } from './ImportPage'
import { account, accounts, committed, csvPreview, members, month, preview, previewWithTransfer } from '../test/fixtures/import'
import { chooseMatch, done, openJars, pickCategory, rowAction } from '../test/importReview'

const csv = (name = 'tx.csv') => new File(['x'], name, { type: 'text/csv' })
const renderPage = () => renderWithProviders(<ImportPage />)
type User = ReturnType<typeof userEvent.setup>

/** What today's page sent for each scenario (see above). */
const EXPECTED = {
  'A-bank-csv': {
    preview: [
      '["GenericCsv",{"defaultCurrency":"EUR","accountId":null}]',
      '["GenericCsv",{"mapping":{"delimiter":",","hasHeader":true,"dateColumn":0,"amountColumn":2,"descriptionColumn":3,"currencyColumn":3,"dateFormat":null,"decimalStyle":0,"defaultCurrency":"GBP"},"defaultCurrency":"EUR","accountId":null}]',
    ],
    commit:
      '[null,[{"reference":"csv:a#0","date":"2026-06-20","payee":"TESCO","amount":42.5,"currency":"GBP","isCredit":false,"budgetItemId":"bi1","memberId":"m1"},{"reference":"csv:b#0","date":"2026-06-21","payee":"SALARY","amount":2500,"currency":"GBP","isCredit":true,"budgetItemId":null,"memberId":null}]]',
  },
  'B-hsbc': {
    preview: ['["HsbcCsv",{"accountId":"acc1"}]'],
    commit:
      '["acc1",[{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":"bi1","memberId":null},{"reference":"hsbc:b#0","date":"2026-06-15","payee":"WOLT","amount":80.9,"currency":"EUR","isCredit":false,"budgetItemId":null,"memberId":"m1"}]]',
  },
  'C-camt-jars': {
    preview: ['["Camt053",{"accountId":"acc1"}]'],
    commit:
      '["acc1",[{"reference":"camt:s#0","date":"2026-06-01","payee":"SALARY","amount":2500,"currency":"EUR","isCredit":true,"jarAllocations":[{"jarId":"j1","amount":500}],"budgetItemId":null,"memberId":null},{"reference":"camt:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"paidFromJarId":"j2","budgetItemId":"bi1","memberId":null},{"reference":"camt:h#0","date":"2026-06-10","payee":"HOLIDAY FUND","amount":100,"currency":"EUR","isCredit":false,"paidFromJarId":null,"budgetItemId":"bi3","memberId":null},{"reference":"camt:w#0","date":"2026-06-15","payee":"WOLT","amount":80.9,"currency":"EUR","isCredit":false,"paidFromJarId":null,"budgetItemId":null,"memberId":null}]]',
  },
  'D-split': {
    preview: ['["GenericCsv",{"defaultCurrency":"EUR","accountId":null}]'],
    commit:
      '[null,[{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":null,"memberId":null,"splits":[{"budgetItemId":"bi1","amount":20,"memberId":"m1"},{"budgetItemId":"bi2","amount":15,"memberId":null}]},{"reference":"hsbc:b#0","date":"2026-06-15","payee":"WOLT","amount":80.9,"currency":"EUR","isCredit":false,"budgetItemId":null,"memberId":null}]]',
  },
  'E-matched-transfer': {
    preview: ['["GenericCsv",{"defaultCurrency":"EUR","accountId":"acc1"}]'],
    commit:
      '["acc1",[{"reference":"hsbc:e#0","date":"2026-06-16","payee":"E-BANKING PAYMENT","amount":234.24,"currency":"EUR","isCredit":true,"budgetItemId":null,"memberId":null,"transferAccountId":"acc2","matchTransferId":"tr-1","fee":2,"feeBudgetItemId":"bi2"},{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":"bi1","memberId":null}]]',
  },
  'F-new-transfer-fee': {
    preview: ['["GenericCsv",{"defaultCurrency":"EUR","accountId":"acc1"}]'],
    commit:
      '["acc1",[{"reference":"hsbc:e#0","date":"2026-06-16","payee":"E-BANKING PAYMENT","amount":234.24,"currency":"EUR","isCredit":true,"budgetItemId":null,"memberId":null},{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":null,"memberId":null,"transferAccountId":"acc2","matchTransferId":null,"fee":2,"feeBudgetItemId":"bi1"}]]',
  },
  'G-return': {
    preview: ['["GenericCsv",{"defaultCurrency":"EUR","accountId":"acc1"}]'],
    commit:
      '["acc1",[{"reference":"hsbc:e#0","date":"2026-06-16","payee":"E-BANKING PAYMENT","amount":234.24,"currency":"EUR","isCredit":true,"budgetItemId":null,"memberId":null,"transferAccountId":null,"matchTransferId":null,"returnOfTransferId":"tr-back"},{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":"bi1","memberId":null}]]',
  },
  'H-unticked-duplicate': {
    preview: ['["GenericCsv",{"defaultCurrency":"EUR","accountId":null}]'],
    commit:
      '[null,[{"reference":"hsbc:a#0","date":"2026-06-17","payee":"AUTOMARKET","amount":35,"currency":"EUR","isCredit":false,"budgetItemId":"bi1","memberId":null}]]',
  },
}

/** Asserts every request of the scenario, byte for byte. */
function expectSent(key: keyof typeof EXPECTED) {
  expect(mockPreview.mock.calls.map((c) => JSON.stringify([c[1], c[2]]))).toEqual(EXPECTED[key].preview)
  expect(mockCommit).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(mockCommit.mock.calls[0])).toBe(EXPECTED[key].commit)
}

async function review(user: User, opts: { format?: string; accountId?: string; file?: File } = {}) {
  if (opts.format) await user.selectOptions(await screen.findByLabelText('File format'), opts.format)
  if (opts.accountId) await user.selectOptions(await screen.findByLabelText(/Add to account/), opts.accountId)
  await user.upload(await screen.findByLabelText(/^Statement file/), opts.file ?? csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
}

async function commit(user: User) {
  await user.click(screen.getByRole('button', { name: /^Import \d+ transactions?$/ }))
  await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
}

// The jar-backed account of ImportPage.jars.test.tsx: HSBC Current (550) backs Holiday j1 and Car j2.
const jarAccounts: AccountDto[] = [account({ currentBalance: 550 }), account({ id: 'acc2', name: 'Joint Savings', type: 1, displayOrder: 1 })]
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
const jarMonth = {
  id: 'mo1', key: '2026-06', year: 2026, month: 6, baseCurrency: 'EUR',
  totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false,
  categories: [
    { id: 'c0', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0,
      items: [{ id: 'bi0', name: 'Salary', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false }] },
    { id: 'c1', name: 'Food', kind: 'Expense', displayOrder: 1, totalPlanned: 0, totalActual: 0,
      items: [
        { id: 'bi1', name: 'Groceries', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
        { id: 'bi2', name: 'Soap', displayOrder: 1, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
      ] },
    { id: 'c2', name: 'Jars', kind: 'Savings', displayOrder: 2, totalPlanned: 0, totalActual: 0,
      items: [{ id: 'bi3', name: 'Holiday', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: 'j1', savingsAvailable: 200, dueDay: null, isPaid: false }] },
  ],
} as unknown as BudgetMonthDto
function camtPreview(): ImportPreviewResult {
  return {
    totalEntries: 4, newCount: 4, skippedDuplicates: 0, credits: 1, debits: 3,
    items: [
      { reference: 'camt:s#0', date: '2026-06-01', payee: 'SALARY', amount: 2500, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'camt:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      { reference: 'camt:h#0', date: '2026-06-10', payee: 'HOLIDAY FUND', amount: 100, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'camt:w#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

const candidate = {
  counterpartyAccountId: 'acc2', counterpartyAccountName: 'Pot', currency: 'EUR', payee: 'Transfer',
  receivedOn: null, recordedDate: null, sameReference: false, fee: null,
}

describe('ImportPage sends what it sent before the restyle', () => {
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

  it('a Bank CSV: the first scan, a re-scan from the Columns dialog, a line from the chip, a member from the dialog', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()
    await review(user)
    await screen.findByLabelText('Include TESCO on 2026-06-20')
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.selectOptions(screen.getByLabelText('Description column'), '3')
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled())
    await pickCategory(user, 'TESCO on 2026-06-20', 'bi1')
    await rowAction(user, 'TESCO on 2026-06-20', 'Member for TESCO on 2026-06-20')
    await user.selectOptions(screen.getByLabelText('Member for TESCO on 2026-06-20'), 'm1')
    await done(user)
    await commit(user)
    expectSent('A-bank-csv')
  })

  it('an HSBC file into an account: a member on one row', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await review(user, { format: 'hsbc', accountId: 'acc1' })
    await screen.findByText('AUTOMARKET')
    await rowAction(user, 'WOLT on 2026-06-15', 'Member for WOLT on 2026-06-15')
    await user.selectOptions(screen.getByLabelText('Member for WOLT on 2026-06-15'), 'm1')
    await done(user)
    await commit(user)
    expectSent('B-hsbc')
  })

  it('a CAMT.053 file into a jar-backed account: jar amounts on the credit, a jar on a debit, a jar line, a bare debit', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: jarAccounts })
      if (url === '/budget/current') return Promise.resolve({ data: jarMonth })
      if (url === '/members') return Promise.resolve({ data: [] })
      if (url === '/jars/ledger') return Promise.resolve({ data: ledgers })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(camtPreview())
    const user = userEvent.setup()
    renderPage()
    await review(user, { format: 'camt', accountId: 'acc1', file: new File(['x'], 'stmt.xml', { type: 'text/xml' }) })
    await screen.findByText('AUTOMARKET')
    const fields = within(await openJars(user, 'Include SALARY on 2026-06-01'))
    await user.type(fields.getByLabelText('Amount for Holiday'), '500')
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'From jar for AUTOMARKET on 2026-06-17')
    await user.selectOptions(screen.getByRole('combobox', { name: 'From jar' }), 'j2')
    await done(user)
    await pickCategory(user, 'HOLIDAY FUND on 2026-06-10', 'bi3')
    await commit(user)
    expectSent('C-camt-jars')
  })

  it('a split row: two lines, a member on the first', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await review(user)
    await screen.findByText('AUTOMARKET')
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Split AUTOMARKET on 2026-06-17')
    await user.selectOptions(screen.getByLabelText('Split line 1 category for AUTOMARKET'), 'bi1')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '20')
    await user.selectOptions(screen.getByLabelText('Split line 1 member for AUTOMARKET'), 'm1')
    await user.selectOptions(screen.getByLabelText('Split line 2 category for AUTOMARKET'), 'bi2')
    await user.type(screen.getByLabelText('Split line 2 amount for AUTOMARKET'), '15')
    await done(user)
    await commit(user)
    expectSent('D-split')
  })

  it('a transfer matched to a recorded one (with its fee)', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[0] = {
      ...data.items[0],
      transferMatches: [{ ...candidate, transferId: 'tr-1', amount: 234.24, departedOn: '2026-06-15', kind: 'Match', fee: 2, feeBudgetItemId: 'bi2' }],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await review(user, { accountId: 'acc1' })
    await screen.findByText('E-BANKING PAYMENT')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /From Pot/)
    await done(user)
    await commit(user)
    expectSent('E-matched-transfer')
  })

  it('a new transfer with a typed fee', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await review(user, { accountId: 'acc1' })
    await screen.findByText('AUTOMARKET')
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark as transfer: AUTOMARKET on 2026-06-17')
    await user.selectOptions(screen.getByLabelText('Transfer account for AUTOMARKET on 2026-06-17'), 'acc2')
    await user.type(screen.getByLabelText('Fee for AUTOMARKET on 2026-06-17'), '2')
    await user.selectOptions(screen.getByLabelText('Fee category for AUTOMARKET on 2026-06-17'), 'bi1')
    await done(user)
    await commit(user)
    expectSent('F-new-transfer-fee')
  })

  it('a return', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    data.items[0] = {
      ...data.items[0],
      likelyTransfer: false,
      transferMatches: [{ ...candidate, transferId: 'tr-back', amount: 234.24, departedOn: '2026-06-10', kind: 'Return' }],
    }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await review(user, { accountId: 'acc1' })
    await screen.findByText('E-BANKING PAYMENT')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /Returned: transfer to Pot/)
    await done(user)
    await commit(user)
    expectSent('G-return')
  })

  it('an unticked possible duplicate', { timeout: 15000 }, async () => {
    const data = preview()
    data.items[1] = { ...data.items[1], possibleDuplicate: true }
    mockPreview.mockResolvedValue(data)
    const user = userEvent.setup()
    renderPage()
    await review(user)
    await screen.findByText('AUTOMARKET')
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()
    await commit(user)
    expectSent('H-unticked-duplicate')
  })
})
