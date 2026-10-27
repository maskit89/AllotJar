// Import fixtures the ImportPage tests share: the accounts, member and June 2026 budget the page
// loads on mount, the previews POST /import/preview answers and the result of a commit.
import { budgetCategory, budgetItem, budgetMonth } from './budget'
import type {
  AccountDto,
  BudgetMonthDto,
  HouseholdMemberDto,
  ImportPreviewResult,
  ImportStatementResult,
} from '../../types'

/** An account with no money in it; HSBC Current (acc1) unless told otherwise. */
export function account(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'acc1', name: 'HSBC Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0, ...over }
}

/** HSBC Current (acc1) and Joint Savings (acc2). */
export const accounts: AccountDto[] = [
  account(),
  account({ id: 'acc2', name: 'Joint Savings', type: 1, displayOrder: 1 }),
]

/** Alex, the household's one member. */
export const members: HouseholdMemberDto[] = [
  { id: 'm1', name: 'Alex', netMonthlyIncome: 0, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1 },
]

/** June 2026 with one Food group holding the Groceries and Soap lines. */
export const month: BudgetMonthDto = budgetMonth({
  id: 'mo1',
  month: 6,
  categories: [
    budgetCategory({
      id: 'c1',
      name: 'Food',
      items: [budgetItem({ id: 'bi1', name: 'Groceries' }), budgetItem({ id: 'bi2', name: 'Soap', displayOrder: 1 })],
    }),
  ],
})

/** Two EUR debits, one of them suggested for Groceries, after one duplicate was skipped. */
export function preview(): ImportPreviewResult {
  return {
    totalEntries: 3, newCount: 2, skippedDuplicates: 1, credits: 0, debits: 2,
    items: [
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
      { reference: 'hsbc:b#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

/** A credit flagged as a likely transfer (an e-banking top-up) plus a plain debit. */
export function previewWithTransfer(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'hsbc:e#0', date: '2026-06-16', payee: 'E-BANKING PAYMENT', amount: 234.24, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: true },
      { reference: 'hsbc:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
    ],
  }
}

/** A generic-CSV preview: carries the detected column layout so the mapping panel renders. */
export function csvPreview(): ImportPreviewResult {
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

/** The commit's answer: two debits imported, nothing skipped. */
export function committed(over: Partial<ImportStatementResult> = {}): ImportStatementResult {
  return { totalEntries: 2, imported: 2, skippedDuplicates: 0, credits: 0, debits: 2, autoCategorized: 0, transfers: 0, ...over }
}
