// Mirrors the API DTOs (AllotJar.Application.Budgets.Dtos).

export interface BudgetItemDto {
  id: string
  name: string
  displayOrder: number
  plannedAmount: number
  /** Spent (or, for income, received) — always derived from the line's assigned transactions. */
  actualAmount: number
  remaining: number
  /**
   * Refunds received against this expense/savings line (rules 38/39), already subtracted from
   * actualAmount; 0 on income lines. Optional so existing fixtures stay valid; absent reads as 0.
   */
  refundedAmount?: number
  /** Savings identity for a savings line; null for ordinary lines. */
  savingsId: string | null
  /** For a savings line, the running available balance (rolled over from prior months); null otherwise. */
  savingsAvailable: number | null
  /** Day of the month (1–31) this bill is due; null when the line isn't a bill. */
  dueDay: number | null
  /** Whether this month's instance of the bill has been paid. */
  isPaid: boolean
  /**
   * Rule 60 (W04): a jar line whose contribution the user skipped this month (it stands at 0;
   * the jar's other months carry the plan). Optional so existing fixtures stay valid.
   */
  isSkipped?: boolean
  /**
   * The household member this income line is attributed to (who earns it); null =
   * whole-household. Always null on expense/savings lines. Optional so existing
   * fixtures stay valid; absent reads as null.
   */
  memberId?: string | null
}

export interface BudgetCategoryDto {
  id: string
  name: string
  kind: 'Income' | 'Expense' | 'Savings'
  displayOrder: number
  totalPlanned: number
  totalActual: number
  /**
   * True for allocation-OUTPUT categories (pocket money, personal savings): counted in the
   * budget's planned total but excluded from the allocation engine's shared-cost envelopes.
   * Optional so existing fixtures stay valid; absent reads as false.
   */
  excludeFromAllocation?: boolean
  items: BudgetItemDto[]
}

export interface BudgetMonthDto {
  id: string
  key: string
  year: number
  month: number
  baseCurrency: string
  totalIncome: number
  totalPlanned: number
  remainingToBudget: number
  isBalanced: boolean
  /** Transactions this month in another currency still waiting for their amount in the budget currency — excluded from every actual, so >0 marks the totals incomplete. */
  fxPendingCount?: number
  categories: BudgetCategoryDto[]
}

export interface BudgetMonthSummaryDto {
  year: number
  month: number
  key: string
}

// Matches Domain.Enums.TransactionType (System.Text.Json serializes as a number).
export const TransactionType = { Expense: 0, Income: 1, Transfer: 2 } as const

export interface TransactionSplitDto {
  id: string
  budgetItemId: string | null
  budgetItemName: string | null
  /** Household member this slice is attributed to (shared-purchase splitting). */
  memberId: string | null
  memberName: string | null
  amount: number
}

export interface TransactionDto {
  id: string
  date: string
  payee: string
  amount: number
  /** The row's currency. For a confirmed row this is the budget currency and `amount` is in it. */
  currency: string
  /**
   * True when the row is in another currency and still waits for the user to enter (or confirm)
   * its amount in the budget currency. It counts nowhere (budget, reports, people) until then.
   */
  fxPending?: boolean
  /** The foreign figure the user paid, when it was paid in another currency (null otherwise). */
  originalAmount?: number | null
  /** The currency of `originalAmount` (null when the row was paid in the budget currency). */
  originalCurrency?: string | null
  /**
   * What the row counts in the budget currency when `amount` is an account's other currency (an
   * account kept from before one-currency budgets): the account keeps `amount`, the budget counts
   * this. Null on every other row.
   */
  budgetAmount?: number | null
  type: number
  bankReference: string | null
  budgetItemId: string | null
  budgetItemName: string | null
  /**
   * Calendar year/month of the budget month the assigned line belongs to. Present only when the
   * assigned line's month was loaded; differs from the transaction's own date when it was budgeted
   * to another month's line. Optional so existing fixtures stay valid; absent reads as null.
   */
  budgetItemYear?: number | null
  budgetItemMonth?: number | null
  accountId: string | null
  accountName: string | null
  /** For a transfer, the destination account the money moved into. */
  transferAccountId: string | null
  transferAccountName: string | null
  /**
   * W13 (P56/P57): an account this money moved in is private to someone else — it reads
   * "Private account" and only its holder can change the entry. Optional; absent reads as false.
   */
  inPrivateAccount?: boolean
  /** For a transfer: the source bank's posting date, or null while the departure is unknown (held for review). */
  departedOn?: string | null
  /** For a transfer: the destination bank's posting date, or null while the money is in transit. */
  receivedOn?: string | null
  /** For a transfer: the destination statement's reference for the credit leg. */
  receiptBankReference?: string | null
  /** For a transfer: 'Completed' | 'InTransit' | 'PendingReview' | 'Returned', derived from the bank legs. */
  transferStatus?: TransferStatus | null
  /** For a transfer the bank sent back to its source account: the date it came back (yyyy-MM-dd). */
  returnedOn?: string | null
  /** For a returned transfer: the source statement's reference for the money coming back. */
  returnBankReference?: string | null
  /** For a transfer: the fee that left the source on top of `amount` (null when none). */
  fee?: number | null
  /** For a transfer with a fee: the fee row's budget line (null = uncategorised). */
  feeBudgetItemId?: string | null
  feeBudgetItemName?: string | null
  /**
   * On a fee row: the transfer it belongs to. A fee row is edited through its transfer; it cannot be
   * edited, split or deleted on its own, only (re)assigned to a line.
   */
  feeForTransferId?: string | null
  /** For a transfer: the leg carries a bank statement's reference, so its date and amount are the bank's. */
  departureConfirmedByStatement?: boolean
  receiptConfirmedByStatement?: boolean
  returnConfirmedByStatement?: boolean
  /**
   * For a refund (rules 38/39): the purchase this money came back from. A refund is money received
   * (type Income) but never income; it reduces net spending on the expense/savings line it sits on.
   * Optional so existing fixtures stay valid; absent reads as "not a refund".
   */
  refundOfTransactionId?: string | null
  refundOfPayee?: string | null
  refundOfDate?: string | null
  /** The purchase's amount in the budget base currency. */
  refundOfAmount?: number | null
  /** For a purchase: how many refunds point at it, and their base-currency total (0 when none). */
  refundCount?: number
  /** The other side of this movement was an erased private account: a transfer's shared side kept
   *  as a plain entry. The hero totals skip it like a transfer, and it isn't waiting for a line. */
  counterpartyErased?: boolean
  refundedAmount?: number
  /** Household member this whole transaction is attributed to, if any. */
  memberId: string | null
  memberName: string | null
  isSplit: boolean
  splits: TransactionSplitDto[]
  /**
   * The stored jar split of each account leg (rules 78/79): signed amounts per jar, a null jar
   * meaning unallocated. Empty when the leg follows the default (incoming money unallocated; a
   * payment drawn from its budget line's jar or unallocated). Optional so fixtures stay valid.
   */
  jarAllocations?: TransactionJarAllocationDto[]
}

/**
 * GET /transactions/conversion-suggestion: a SUGGESTED budget-currency amount for a foreign figure
 * (ECB reference rate, rounded to 2 decimals by the server). Nothing is saved by asking; the user
 * must confirm the amount. `rate`/`suggestedAmount` are null when no rate is available.
 */
export interface ConversionSuggestionDto {
  currency: string
  amount: number
  budgetCurrency: string
  date: string
  rate: number | null
  suggestedAmount: number | null
  source: string
}

export interface TransactionJarAllocationDto {
  accountId: string
  jarId: string | null
  jarName: string | null
  /** Signed: positive for money reaching the jar, negative for money leaving it. */
  amount: number
}

/**
 * The answer to the incoming-money prompt (rule 78): part of the money reaching a jar-backed
 * account, put into one of its jars. Whatever is not named stays unallocated.
 */
export interface JarAllocationRequest {
  jarId: string
  amount: number
}

/** Request body for POST /transactions/transfer. */
export interface CreateTransferRequest {
  departedOn: string
  receivedOn: string | null
  amount: number
  fromAccountId: string
  toAccountId: string
  payee: string | null
  /** The jar the money leaves (rule 80 "Move money"); unallocated when null. */
  fromJarId?: string | null
  /** How the receipt is divided among the destination's jars (rule 78). */
  jarAllocations?: JarAllocationRequest[] | null
  /** Extra money leaving the source on the departure date, recorded as its own fee row. */
  fee?: number | null
  /** The fee row's budget line; uncategorised when null. */
  feeBudgetItemId?: string | null
  /** Set after the user confirms budgeting the fee to a line in a different month than its date. */
  acknowledgeCrossMonth?: boolean
}

/**
 * Request body for PUT /transactions/{id}/transfer: edits a transfer in place. Every field is sent
 * (it replaces the transfer); a null jar answer returns that leg to its default.
 */
export interface UpdateTransferRequest {
  fromAccountId: string
  toAccountId: string
  amount: number
  departedOn: string | null
  receivedOn: string | null
  /** The date the bank sent the money back to the source; only for a departed, never-received transfer. */
  returnedOn: string | null
  payee: string | null
  fee: number | null
  feeBudgetItemId: string | null
  acknowledgeCrossMonth: boolean
  fromJarId: string | null
  jarAllocations: JarAllocationRequest[] | null
}

/** Request body for PUT /transactions/{id}/transfer-legs. */
export interface ConfirmTransferLegsRequest {
  departedOn?: string | null
  receivedOn?: string | null
  bankReference?: string | null
  receiptBankReference?: string | null
  /** With `departedOn`: the jar the money left. */
  fromJarId?: string | null
  /** With `receivedOn`: how the receipt is divided among the destination's jars (rule 78). */
  jarAllocations?: JarAllocationRequest[] | null
}

/** Matches Domain.Enums.TransferStatus, serialized by name. */
export type TransferStatus = 'Completed' | 'InTransit' | 'PendingReview' | 'Returned'

// Matches Domain.Enums.AccountType (serialized as a number).
export const AccountType = {
  Current: 0,
  Savings: 1,
  Cash: 2,
  CreditCard: 3,
  Other: 4,
} as const

export const ACCOUNT_TYPE_LABELS: Record<number, string> = {
  0: 'Current',
  1: 'Savings',
  2: 'Cash',
  3: 'Credit card',
  4: 'Other',
}

/**
 * The account types a user may pick (rule 75: credit cards are not accounts). The
 * CreditCard enum value stays above so rows recorded before the change still label.
 */
export const ACCOUNT_TYPE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: AccountType.Current, label: 'Current' },
  { value: AccountType.Savings, label: 'Savings' },
  { value: AccountType.Cash, label: 'Cash' },
  { value: AccountType.Other, label: 'Other' },
]

export interface AccountDto {
  id: string
  name: string
  /** Numeric AccountType. */
  type: number
  currency: string
  openingBalance: number
  /** The date the opening balance applies from (start of day). Null only on rows recorded before it was required. */
  openingDate?: string | null
  /**
   * Actual money as of `balanceAsOf`: the opening balance plus every posted leg dated from the
   * opening date to that day. Null when unavailable (no opening date, or as-of before it) — never zero.
   */
  currentBalance: number | null
  /** The date `currentBalance` is calculated as of. */
  balanceAsOf?: string
  /** True when `currentBalance` is null because no opening date is recorded. */
  openingDateMissing?: boolean
  /** Confirmed departures from this account whose receipt is not yet confirmed (excluded from the balance). */
  inTransitOut?: number
  /** Confirmed departures towards this account not yet received (not part of the balance). */
  inTransitIn?: number
  /** Receipts identified as own-account transfers awaiting their departure details; none is posted. */
  pendingReceiptCount?: number
  pendingReceiptTotal?: number
  /** True when the posted balance is flagged for review: it does not yet reflect a pending receipt. */
  requiresReview?: boolean
  displayOrder: number
  /** Optional bank identifiers (rule 76); null/absent when not recorded. */
  iban?: string | null
  bic?: string | null
  sortCode?: string | null
  accountNumber?: string | null
  /**
   * W13 (rule 30): who holds the account — one person is a personal account, several a joint
   * one, none the household's own. Optional so existing fixtures stay valid; absent reads as none.
   */
  holders?: AccountHolderDto[]
  /** True when only the caller's login sees this account (rules 31–33). */
  isPrivate?: boolean
  /** True when the caller chooses who sees it: their own person is its only holder (P54). */
  canChangeSharing?: boolean
  /** Why it can't be made private now (a jar uses it, P55); null otherwise. */
  sharingBlockedReason?: string | null
}

export interface AccountHolderDto {
  memberId: string
  name: string
}

/** GET /accounts/sharing-review — the login's personal accounts and whether rule 32's review is due. */
export interface SharingReviewDto {
  pending: boolean
  accounts: AccountDto[]
}

/**
 * GET /accounts/unreachable — an account private to a login no longer in the household (P59):
 * nobody can see, change or share it. The owner sees its name, holder and entry count, never
 * its entries, and may erase it for good (POST /accounts/{id}/erase with the name typed).
 */
export interface UnreachableAccountDto {
  id: string
  name: string
  currency: string
  holderName?: string | null
  privateSinceUtc: string
  /** Entries the erase removes: the account's own rows and every transfer touching it, with their fees. */
  entryCount: number
}

/** A not-yet-imported transaction returned by the import preview, for review before commit. */
export interface ImportCandidate {
  /** Stable idempotency key from the parser; echoed back on commit. */
  reference: string
  date: string
  payee: string
  amount: number
  currency: string
  isCredit: boolean
  suggestedBudgetItemId: string | null
  suggestedBudgetItemName: string | null
  /** Heuristic hint that this row is a transfer between the user's own accounts, not income/spending. */
  likelyTransfer: boolean
  /**
   * Content-level hint that an existing transaction already matches this row (same amount and
   * payee, booked within a few days) even though its idempotency reference didn't — e.g. the
   * same statement previously imported through a different format. Unticked by default.
   */
  possibleDuplicate?: boolean
  /**
   * Recorded transfers this row could confirm the other side of (same statement account on the
   * open leg, same amount and currency). Suggestions only — the user must pick one; nothing is
   * matched from the amount alone. Present only when the statement account was chosen.
   */
  transferMatches?: TransferMatchCandidate[]
  /**
   * The row's bank reference was already imported for an entry with these (different) details.
   * The row's `reference` is already a derived unique one: echo it back unchanged. Unticked by default.
   */
  reusedReference?: ImportReusedReference | null
}

/** The already-imported entry that shares a row's bank reference; see ImportCandidate.reusedReference. */
export interface ImportReusedReference {
  date: string
  amount: number
  isCredit: boolean
}

/** 'Match' confirms the transfer's open leg; 'Return' is a credit row bringing the money back to its source. */
export type TransferMatchKind = 'Match' | 'Return'

/** A recorded transfer a statement row could be the other side of; see ImportCandidate.transferMatches. */
export interface TransferMatchCandidate {
  transferId: string
  /**
   * The other side's account; null when it is private to another login (its name then reads
   * "Private account"), and a match is committed with `matchTransferId` alone.
   */
  counterpartyAccountId: string | null
  counterpartyAccountName: string
  amount: number
  currency: string
  departedOn: string | null
  receivedOn: string | null
  payee: string
  /** Optional so older fixtures stay valid; absent reads as 'Match'. */
  kind?: TransferMatchKind
  /** The fee confirming this match records (what left minus what arrived); null when none. */
  fee?: number | null
  /** The budget line the transfer's current fee is on (pre-fills the fee line); null when none. */
  feeBudgetItemId?: string | null
  /**
   * The first day of that line's budget month. The commit judges the fee's date (the bank's
   * departure date, once matched) against it, so the review asks the cross-month question first.
   */
  feeBudgetItemMonth?: string | null
  /** The leg was recorded in the app on this date (no bank reference yet); the statement's date replaces it. */
  recordedDate?: string | null
  /** The other bank printed the same reference. */
  sameReference?: boolean
}

/** How the amount column writes decimals. Matches the server CsvDecimalStyle enum. */
export type CsvDecimalStyle = 0 | 1 | 2 // Auto | Dot | Comma

/** User-confirmed column mapping for a generic bank-CSV import (column values are 0-based indices). */
export interface CsvMapping {
  delimiter: string
  hasHeader: boolean
  dateColumn: number
  amountColumn: number
  descriptionColumn: number
  currencyColumn: number | null
  /** e.g. "dd/MM/yyyy"; null = auto-detect a common format. */
  dateFormat: string | null
  decimalStyle: CsvDecimalStyle
  /** Stamped on rows with no currency column (the user's home currency). */
  defaultCurrency: string | null
}

/** The layout the server detected from an uploaded CSV, for the mapping UI. */
export interface CsvLayout {
  columns: string[]
  sampleRows: string[][]
  suggested: CsvMapping
}

/** The de-duplicated candidate rows plus the counts the review UI shows. */
export interface ImportPreviewResult {
  totalEntries: number
  newCount: number
  skippedDuplicates: number
  credits: number
  debits: number
  items: ImportCandidate[]
  /** Present only for a generic-CSV preview — the detected/used column mapping. */
  layout?: CsvLayout | null
  /**
   * The parser that actually read the file ("HsbcCsv", "Camt053", "GenericCsv"). A "generic"
   * upload that sniffs as a known bank export is routed to its dedicated adapter so the same
   * file always yields the same payees and idempotency references.
   */
  detectedFormat?: string
}

/** One slice of a split import row sent to the commit endpoint. */
export interface CommitImportSplit {
  budgetItemId: string
  amount: number
  memberId: string | null
}

/** One reviewed row sent to the commit endpoint. */
export interface CommitImportItem {
  reference: string
  date: string
  payee: string
  amount: number
  currency: string
  isCredit: boolean
  budgetItemId: string | null
  memberId: string | null
  /** When set (two or more slices summing to `amount`), the row is imported as a split. */
  splits?: CommitImportSplit[] | null
  /** When set, the row is imported as a transfer between the import account and this counterparty. */
  transferAccountId?: string | null
  /** Set after the user confirms budgeting this row to a line in a different month than its date. */
  acknowledgeCrossMonth?: boolean
  /**
   * The recorded transfer this row confirms the other side of, chosen by the user from the
   * preview's candidates. The row's date/reference attach to that transfer's open leg and no new
   * transaction is created. `transferAccountId` names the same counterparty, or is null when the
   * candidate's counterparty is private to another login (the server derives it from the transfer).
   */
  matchTransferId?: string | null
  /**
   * For a credit into a jar-backed statement account (an income, or a transfer receipt this row
   * records or confirms): how much goes to each of its jars, the rest unallocated (rule 78).
   */
  jarAllocations?: JarAllocationRequest[] | null
  /** For a debit on a line that is not a jar (or a transfer out): the jar it comes from (rule 79). */
  paidFromJarId?: string | null
  /**
   * The transfer fee: with `matchTransferId`, the chosen candidate's `fee` echoed back; with
   * `transferAccountId` on an unmatched debit, the part of the row that is a fee (the transfer is the rest).
   */
  fee?: number | null
  /** The fee row's budget line; required whenever `fee` is sent. */
  feeBudgetItemId?: string | null
  /**
   * For a credit row whose chosen candidate has kind 'Return': the transfer this row brings back.
   * Sent instead of `transferAccountId`/`matchTransferId`; no line, member, split or jar answer.
   */
  returnOfTransferId?: string | null
}

/** A statement row the commit held back because posting it would take the account below zero (rule 74). */
export interface ImportHeldRow {
  reference: string
  message: string
  /** The row's position in the commit request; unique even when two rows share a reference. */
  index?: number
}

/** Summary returned by a statement import (CAMT.053 or HSBC CSV). */
export interface ImportStatementResult {
  totalEntries: number
  imported: number
  skippedDuplicates: number
  credits: number
  debits: number
  iban: string | null
  autoCategorized: number
  /** Transfer rows recorded or confirmed. */
  transfers: number
  /** Rows that confirmed the other side of an existing transfer (no new transaction). */
  matchedTransfers?: number
  /** Credit rows held for review because only the receipt is known. */
  pendingReviewTransfers?: number
  /** Rows that confirmed a transfer coming back to its source account. */
  returned?: number
  /** Rows not imported because they would take the account below zero on some date (rule 74); re-commit after fixing. */
  held?: ImportHeldRow[]
  heldCount?: number
  /** New rows in another currency that wait for their amount in the budget currency (rules 42/44); they count nowhere yet. */
  awaitingAmount?: number
  /** The rows counted in skippedDuplicates, by the reference this client sent. */
  skippedReferences?: string[]
  /** The same rows by their position in the commit request. */
  skippedIndexes?: number[]
}

export interface AccountReconciliationDto {
  accountId: string
  accountName: string
  /** Actual balance as of today; null when unavailable. */
  currentBalance: number | null
  backedJarsTotal: number
  backedJarCount: number
  /** The account's unallocated money: balance minus every jar's signed balance (rule 3); null when the balance is unavailable. */
  float: number | null
  /** True when positive jar balances exceed the account's money (rule 70): an explicit reallocation must cover the deficit. */
  hasBackingDeficit?: boolean
  /** True when a pending transfer receipt means the posted balance is not yet reconcilable with the bank. */
  requiresReview?: boolean
}

export interface BudgetTrendPointDto {
  year: number
  month: number
  key: string
  /** Budgeted income (Σ income planned). */
  income: number
  /** Income actually received: income lines' actuals plus uncategorised income; never transfers or refunds (rule 41). */
  incomeReceived: number
  /** Budgeted spending (Σ non-income planned). */
  planned: number
  /** Net spending: categorised and uncategorised, less refunds (rules 37–39). */
  spent: number
  // The breakdown below is optional so existing fixtures stay valid; absent reads as 0.
  /** The part of incomeReceived no income line carries yet. */
  incomeUncategorised?: number
  /** Received − budgeted income, signed (rule 41). */
  variance?: number
  /** Spending on the month's lines, net of the refunds assigned to them. */
  spentCategorised?: number
  /** Spending no line carries yet, less unplaced refunds (rule 37). */
  spentUncategorised?: number
  /** Every refund received in the month (rules 38/39). */
  refunds?: number
  /** Expense rows and refunds still needing a line (flagged for review). */
  uncategorisedCount?: number
  /** Rows in another currency waiting for their amount in the budget currency, left out of the figures. */
  fxPendingCount?: number
}

export interface BudgetTrendsDto {
  points: BudgetTrendPointDto[]
  totalIncome: number
  totalIncomeReceived: number
  totalSpent: number
  // Optional so existing fixtures stay valid.
  totalVariance?: number
  totalSpentUncategorised?: number
  totalRefunds?: number
}

export interface AnnualMonthDto {
  month: number
  key: string
  hasBudget: boolean
  /** Budgeted income. */
  income: number
  /** Income actually received (rule 41); carried even for a month with no budget. */
  incomeReceived: number
  /** Received − budgeted, signed. */
  variance: number
  planned: number
  /** Net spending (rules 37–39); carried even for a month with no budget. */
  spent: number
  /** Spending no line carries yet. Optional so existing fixtures stay valid. */
  spentUncategorised?: number
  /** Refunds received in the month. Optional so existing fixtures stay valid. */
  refunds?: number
  uncategorisedCount?: number
}

export interface AnnualCategoryDto {
  name: string
  /** "Expense", "Savings" or "Uncategorised". */
  kind: string
  /** Total net spending for this category across the year (refunds already subtracted). */
  total: number
  /** Refunds received against this category across the year. Optional so existing fixtures stay valid. */
  refunds?: number
  /** Total ÷ number of budgeted months. */
  averagePerMonth: number
}

export interface AnnualSummaryDto {
  year: number
  months: AnnualMonthDto[]
  /** Σ budgeted income. */
  totalIncome: number
  /** Σ income actually received (rule 41). */
  totalIncomeReceived: number
  /** Σ (received − budgeted), signed. */
  totalVariance: number
  totalPlanned: number
  /** Σ net spending. */
  totalSpent: number
  /** Σ refunds across the year. Optional so existing fixtures stay valid. */
  totalRefunds?: number
  /** How many of the 12 months have a budget (the averaging denominator). */
  budgetedMonths: number
  /** Per-category spending across the year, biggest average first. */
  categories: AnnualCategoryDto[]
}

/**
 * One calendar month as the reports read it (rules 37–39, 41): line-derived figures plus what no
 * line carries yet, by the transaction's own date. Mirrors AllotJar.Application.Reports.Dtos.
 */
export interface MonthReportDto {
  year: number
  month: number
  key: string
  hasBudget: boolean
  /** The budget's base currency; null when the month has no budget. */
  baseCurrency: string | null
  incomeBudgeted: number
  incomeReceived: number
  incomeUncategorised: number
  /** Received − budgeted, signed. */
  variance: number
  planned: number
  spentCategorised: number
  spentUncategorised: number
  refunds: number
  /** Net spending: spentCategorised + spentUncategorised. */
  spent: number
  /** Expense rows and refunds still needing a line. */
  uncategorisedCount: number
  uncategorisedIncomeCount: number
  fxPendingCount: number
  categories: MonthReportCategoryDto[]
}

export interface MonthReportCategoryDto {
  /** The budget category's id; null for the Uncategorised row. */
  id: string | null
  name: string
  /** "Expense", "Savings" or "Uncategorised". */
  kind: string
  /** Position among the month's non-income groups (matches the Budget screen's hue); -1 for Uncategorised. */
  index: number
  /** What went out, before refunds. */
  spent: number
  /** Refunds received in the month against this group. */
  refunds: number
  /** spent − refunds; negative when more came back than went out this month. */
  net: number
  isUncategorised: boolean
  /** For the Uncategorised row: how many rows need a line. */
  count: number
}

export interface BudgetTemplateGroupDto {
  name: string
  kind: 'Income' | 'Expense' | 'Savings'
  lines: string[]
}

export interface BudgetTemplateDto {
  key: string
  name: string
  description: string
  groups: BudgetTemplateGroupDto[]
}

// Matches Domain.Enums.JarKind (serialized as a number).
export const JarKind = { Recurring: 0, Goal: 1 } as const

export const JAR_KIND_LABELS: Record<number, string> = {
  0: 'Recurring',
  1: 'Goal',
}

// Matches Domain.Enums.AccrualMethod (serialized as a number): how a jar plans its monthly
// contribution (rules 16–17) — toward a deadline, or a fixed amount each month.
export const AccrualMethod = { TargetByDate: 1, FixedMonthly: 2 } as const

/** A Recurring jar's cycle length choices for the "Repeats every" select. */
export const RECUR_MONTHS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 12, label: 'Yearly' },
  { value: 6, label: 'Every 6 months' },
  { value: 3, label: 'Every 3 months' },
  { value: 1, label: 'Monthly' },
]

export interface JarDto {
  id: string
  name: string
  /** Numeric JarKind. */
  kind: number
  /** The amount to accumulate; 0 for an ongoing jar (a fixed monthly amount with no target). */
  targetAmount: number
  /** The stored deadline (ISO yyyy-MM-dd) or null; never the rolled date. See `deadline`. */
  targetDate: string | null
  /** Numeric AccrualMethod. */
  accrual: number
  /** The fixed amount planned each month under a fixed monthly plan; null for a deadline plan. */
  monthlyContribution: number | null
  /** Rule 36: whether the deadline month itself plans a contribution. */
  includeDeadlineMonth: boolean
  /** A Recurring jar's cycle length in months (its date rolls forward by this); null for Goals. */
  recurMonths: number | null
  /** The account holding this jar's money (rule 2); always set. */
  fundingAccountId: string
  isArchived: boolean
  /** Rule 55 (W04): when this Goal was marked completed (ISO date); null while it is live. */
  completedOn: string | null
  /** Rule 84 (W04): the jar never held money, so it may be deleted outright (else only archived). */
  canDelete: boolean
  /**
   * The jar's actual balance in its account as of `balanceAsOf`: the allocations posted
   * against it, never planned contributions (rule 1). Null when the account's balance is
   * unavailable (rule 67), never zero.
   */
  currentBalance: number | null
  /** The date `currentBalance` is calculated as of. */
  balanceAsOf: string
  /** This month's planned contribution (rule 14); it does not fall as contributions land. */
  plannedThisMonth: number
  /** How much the balance has grown since the month began (rule 14). */
  contributedThisMonth: number
  /** Plan − contributed, floored at zero (rule 14). */
  remainingThisMonth: number
  /** Rule 60 (W04): this month's contribution was skipped; the line stands at 0 and later months carry the plan. */
  skippedThisMonth: boolean
  /** The deadline saved toward — a Recurring jar's open cycle (W03); null for fixed monthly plans. */
  deadline: string | null
  /**
   * Rule 20: while a Recurring jar's open cycle has passed its deadline short of the target
   * (status DeadlineMissed, or FundedLate once reached, rule 57), target − balance floored at
   * zero. Null otherwise.
   */
  shortfall: number | null
  /** The jar's most recently closed cycle (W03); null when none has closed yet. */
  lastCycle: JarCycleDto | null
  /** The last day of the final planned month (rule 36); null when funded or not a deadline plan. */
  fundingCompletesOn: string | null
  /** Fixed monthly plans with a target: monthly contributions still needed (rule 58, an estimate). */
  estimatedMonthsToTarget: number | null
  /** Unavailable | DeadlineMissed | FundedLate | Overspent | Ongoing | Unscheduled | FullyFunded | Behind | OnTrack. */
  status: string
}

/** A closed cycle of a Recurring jar (W03). Mirrors AllotJar.Application.Jars.Dtos.JarCycleDto. */
export interface JarCycleDto {
  id: string
  /** The deadline the cycle worked toward (ISO yyyy-MM-dd). */
  deadline: string
  targetAmount: number
  /** Paid | Funded | Missed | FundedLate. */
  outcome: string
  /** The balance at the end of the day before the deadline; null when it was unavailable. */
  balanceAtDeadline: number | null
  /** The payment chosen as fulfilling the cycle (rule 83); null once that transaction is deleted (the date and amount stay). */
  paymentTransactionId: string | null
  paymentPayee: string | null
  paidOn: string | null
  paidAmount: number | null
  /** A paid cycle whose payment landed before the deadline (rule 22). */
  paidOnTime: boolean
  closedOn: string
}

/** A payment offered for marking a cycle paid (GET /jars/{id}/payments). Mirrors JarPaymentDto. */
export interface JarPaymentDto {
  id: string
  date: string
  payee: string
  amount: number
  currency: string
  fxPending: boolean
  accountId: string | null
  accountName: string | null
  budgetItemName: string | null
  /** True when the payment drew from the jar in its own account (rule 79). */
  fromJar: boolean
}

/** One month of a previewed schedule (POST /jars/schedule). */
export interface JarScheduleMonthDto {
  year: number
  month: number
  planned: number
  /** Rule 60 (W04): the user skipped this month; it plans 0 and the other months carry the plan. */
  skipped: boolean
  /** Whether a budget already exists for this month. */
  hasBudget: boolean
  /** Rule 59: how far the month's plans would exceed its income with this contribution (0 fits); null with no budget. */
  shortfall: number | null
}

/**
 * A jar definition's contribution schedule from this month — exactly what saving it plants on
 * the Savings lines (POST /jars/schedule). Mirrors AllotJar.Application.Jars.Dtos.JarScheduleDto.
 */
export interface JarScheduleDto {
  accrual: number
  /** A fixed monthly amount with no target: the one month listed stands for every month. */
  isOngoing: boolean
  /** Whether the definition yields a plan at all (rule 17). */
  hasSchedule: boolean
  /** The balance the plan starts from. */
  balance: number
  /** Target − balance, floored at zero. */
  remaining: number
  months: JarScheduleMonthDto[]
  total: number
  deadline: string | null
  fundingCompletesOn: string | null
  estimatedMonths: number | null
  /**
   * Rule 60/61 (W04): for a deadline plan, the part of `remaining` no month before the deadline
   * carries because every eligible month was skipped; 0 otherwise.
   */
  unplanned: number
}

/** The body of POST /jars/schedule: the definition being previewed (jarId when editing). */
export interface JarScheduleRequest {
  jarId: string | null
  kind: number
  targetAmount: number
  targetDate: string | null
  accrual: number
  monthlyContribution: number | null
  includeDeadlineMonth: boolean
  recurMonths: number | null
  initialAllocation: number
}

/** One jar's line in its account's ledger (GET /jars/ledger). */
export interface JarLedgerLineDto {
  jarId: string
  name: string
  /** Null when the account's balance is unavailable (rule 67); see readLedgers. */
  balance: number | null
  isArchived: boolean
}

/**
 * One jar-backed account's ledger (rules 2–6, 70): its actual balance, each jar's allocated
 * balance and the unallocated remainder, which always reconcile. Null money means unavailable.
 */
export interface JarAccountLedgerDto {
  accountId: string
  accountName: string
  currency: string
  asOf: string
  accountBalance: number | null
  unallocated: number | null
  /** The sum of positive jar balances; must not exceed `accountBalance` (rule 70). */
  positiveAllocations: number
  /** True when positive jars exceed the account's money: an explicit reallocation is required before further moves. */
  hasBackingDeficit: boolean
  /** Stored transaction allocations that no longer match their transaction and were set aside for review. */
  unreconciledAllocations: number
  requiresReview: boolean
  jars: JarLedgerLineDto[]
}

export interface HouseholdMemberDto {
  id: string
  name: string
  /** The saved default income: a helper for filling in a new budget, never a figure any calculation uses (rule 28). */
  netMonthlyIncome: number
  /** This member's income in the selected month's budget: attributed lines plus an equal share of the unattributed ones. */
  budgetIncome?: number
  /** The month `budgetIncome` and `incomeSharePct` were read from. */
  incomeYear?: number
  incomeMonth?: number
  /** False when that month has no budget yet (income and share are then zero). */
  hasBudget?: boolean
  /** Null when the account is private to another login (then {@link savingsPrivate} is true). */
  personalSavingsAccountId: string | null
  /** P53: the person has a savings account, but it is private to another login, so its id is withheld. */
  savingsPrivate?: boolean
  displayOrder: number
  isArchived: boolean
  /** This member's share of the household's income in the selected month's budget (0–1). */
  incomeSharePct: number
}

/**
 * What archiving a person does to their pocket money (rule 54), read before the People page
 * archives them: while `thisMonth.remaining` is above zero the archive needs the keep-or-cancel
 * decision; `futureMonths` are cancelled either way.
 */
export interface MemberArchivePreviewDto {
  id: string
  name: string
  isArchived: boolean
  /** The current month's pocket money for the person; null when there is none. */
  thisMonth: PocketMoneyMonthDto | null
  futureMonths: PocketMoneyMonthDto[]
}

/** One month's pocket money for a person: planned, paid so far and what remains planned. */
export interface PocketMoneyMonthDto {
  year: number
  month: number
  planned: number
  paid: number
  remaining: number
}

// Matches Application PocketMoneyDecision (serialized as a number): what happens to the pocket
// money still planned this month when the person is archived (rule 54).
export const PocketMoneyDecision = { Keep: 0, Cancel: 1 } as const

/** Per-member attributed spending (the "who spent what" lens). */
export interface MemberSpendingDto {
  memberId: string
  name: string
  /** Attributed spending in the budget's base currency; rows with a pending exchange rate are left out. */
  spent: number
  /** Attributed rows still waiting for their amount in the budget currency, and therefore not counted. */
  fxPendingCount?: number
}

// Matches Domain.Enums.AllocationRuleType (serialized as a number).
export const AllocationRuleType = {
  FundEnvelopes: 0,
  FundJars: 1,
  FixedPerMember: 2,
  SplitRemainderToMembers: 3,
} as const

// Matches Domain.Enums.SplitMethod (serialized as a number).
export const SplitMethod = { Equal: 0, ByIncomeRatio: 1, BalanceTilt: 2 } as const

export interface AllocationRuleDto {
  id: string
  order: number
  type: number
  split: number
  fixedAmountPerMember: number
}

export interface AllocationProfileDto {
  id: string
  name: string
  /** Null when the source is private to another login (then {@link sourcePrivate} is true). */
  sourceAccountId: string | null
  /** P53: a source is set, but its holder has made it private; only they can allocate from it. */
  sourcePrivate?: boolean
  /** How hard a balance-aware savings split leans toward equalising balances (0–100). */
  balanceLeanPercent: number
  rules: AllocationRuleDto[]
}

export interface MemberShareDto {
  memberId: string
  name: string
  amount: number
}

export interface AllocationStepDto {
  type: number
  total: number
  perMember: MemberShareDto[]
}

export interface MemberAllocationDto {
  memberId: string
  name: string
  netIncome: number
  residual: number
  /** Savings-account balance before this month's allocation (for the balance-aware view). */
  /** Actual savings-account balance today, before this month's allocation; null when unavailable (no opening date). */
  savingsBalance: number | null
  savingsAccountId: string | null
  /** W13 (P53): the person's savings account is private to their own login; only they can record the transfer. */
  savingsPrivate?: boolean
}

export interface AllocationResultDto {
  pool: number
  envelopesTotal: number
  jarsTotal: number
  steps: AllocationStepDto[]
  members: MemberAllocationDto[]
  transfersCreated: number
  /** Previously recorded transfers a commit left unchanged (0 for a preview). */
  transfersRetained?: number
  /**
   * True when the pool came from the month's budgeted income lines (attributed to
   * people). Optional so existing fixtures stay valid; absent reads as false.
   */
  incomeFromBudget?: boolean
  /** Budgeted income not attributed to any person, shared equally when incomeFromBudget. */
  unattributedIncome?: number
}

/** Per-member income for a month, derived from the budget (GET /members/income/{y}/{m}). */
export interface MemberIncomeResultDto {
  /** Always true since rule 28: every figure comes from the month's budget. */
  incomeFromBudget: boolean
  /** False when the month has no budget yet. */
  hasBudget?: boolean
  /** Income rows in the month still waiting for their amount in the budget currency, so not in `received`. */
  fxPendingCount?: number
  unattributedPlanned: number
  items: MemberIncomeDto[]
}

export interface MemberIncomeDto {
  memberId: string
  name: string
  /** The month's income lines attributed to this person. */
  planned: number
  /** Income transactions attributed to this person in the month, base currency, pending-rate rows left out. */
  received: number
  /** Planned plus an equal share of the unattributed lines: the figure the allocation uses. */
  income?: number
  /** This person's share of the household's month income (0–1). */
  sharePct?: number
}

/** Toggles for the features beyond core zero-based budgeting (from GET /api/features). */
export interface FeatureFlags {
  accounts: boolean
  multiCurrency: boolean
  camtImport: boolean
  reports: boolean
  jars: boolean
  householdAllocation: boolean
  /** GA4 usage analytics. Off unless explicitly enabled server-side AND a measurement ID is built in. */
  analytics: boolean
  householdAccess: boolean
}

// Matches Domain.Enums.HouseholdRole (serialized as a number).
export const HouseholdRole = { Owner: 0, Admin: 1, Limited: 2, ReadOnly: 3 } as const

export const HOUSEHOLD_ROLE_LABELS: Record<number, string> = {
  0: 'Owner',
  1: 'Admin',
  2: 'Limited',
  3: 'Read-only',
}

/** One-line description of what each role can do, for the access UI. */
export const HOUSEHOLD_ROLE_HINTS: Record<number, string> = {
  0: 'Full control, including managing who has access.',
  1: 'Everything except managing members and access.',
  2: 'Day-to-day entry: transactions, mark bills paid, run allocation.',
  3: 'View everything; cannot make changes.',
}

// Matches Domain.Enums.MembershipStatus (serialized as a number).
export const MembershipStatus = { Active: 0, Invited: 1 } as const

// Matches Application.HouseholdAccess.InviteMethod (serialized as a number).
export const InviteMethod = { Direct: 0, Link: 1 } as const

export interface MembershipDto {
  id: string
  email: string
  displayName: string | null
  /** Numeric HouseholdRole. */
  role: number
  /** Numeric MembershipStatus. */
  status: number
  memberId: string | null
  isOwner: boolean
  /** True when this row is the current login. */
  isSelf: boolean
  createdUtc: string
}

/** Returned by an invite: the new membership, and whether its email (the only copy of any link) went out. */
export interface InviteResultDto {
  membership: MembershipDto
  emailSent: boolean
}

/** One household the login can act in, for the switcher. The active one has `isActive`. */
export interface HouseholdSummary {
  ownerId: string
  label: string
  role: number
  isActive: boolean
  isOwn: boolean
}

/** GET /auth/me — the current login's identity, active household, access level and household list. */
export interface MeResponse {
  userId: string
  email: string
  displayName: string | null
  role: number
  ownerId: string
  memberId: string | null
  firstName?: string | null
  lastName?: string | null
  /** The login's own currency preference (seeds a brand-new household's budget currency). */
  preferredCurrency?: string
  /** The ACTIVE household's budget currency: every account and every counted amount uses it. */
  budgetCurrency?: string
  /** True once the login's OWN household has accounts, months or transactions (currency is fixed). */
  currencyLocked?: boolean
  /** The login's OWN household's budget currency: what the preference is locked to once fixed. */
  ownBudgetCurrency?: string
  numberFormat?: string
  households?: HouseholdSummary[]
  /** True for invite-created logins that haven't accepted the terms yet (blocking consent prompt). */
  needsConsent?: boolean
  /** True while the login still has the temporary password an owner set for it (blocking prompt). */
  mustChangePassword?: boolean
  /** Rule 32: review who sees the personal accounts this login holds. */
  sharingReviewPending?: boolean
  /** False for Google-created accounts with no password — the account page adapts change-password. */
  hasPassword?: boolean
  /** True when a Google identity is linked — the account page shows Disconnect. */
  hasGoogle?: boolean
  /** False until the login's email address is verified — drives the "confirm your email" banner. */
  emailConfirmed?: boolean
}

/** The login's current name + money-display preferences (GET via /auth/me, PUT /auth/preferences). */
export interface PreferencesResponse {
  firstName: string | null
  lastName: string | null
  displayName: string | null
  preferredCurrency: string
  numberFormat: string
  /** The active household's budget currency after the save, when the server reports it. */
  budgetCurrency?: string
  /** Whether the login's own household's currency is now fixed, when the server reports it. */
  currencyLocked?: boolean
}

export interface AuthResponse {
  token: string
  expiresAtUtc: string
  userId: string
  email: string
  /** Numeric HouseholdRole. */
  role: number
  displayName: string | null
  /** Google sign-in only: true when this call CREATED the account (drives sign_up vs login analytics). */
  isNewAccount?: boolean | null
}
