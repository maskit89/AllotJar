// Mirrors the API DTOs (AllotJar.Application.Budgets.Dtos).

export interface BudgetItemDto {
  id: string
  name: string
  displayOrder: number
  plannedAmount: number
  /** Spent (or, for income, received) — always derived from the line's assigned transactions. */
  actualAmount: number
  remaining: number
  /** Savings identity for a savings line; null for ordinary lines. */
  savingsId: string | null
  /** For a savings line, the running available balance (rolled over from prior months); null otherwise. */
  savingsAvailable: number | null
  /** Day of the month (1–31) this bill is due; null when the line isn't a bill. */
  dueDay: number | null
  /** Whether this month's instance of the bill has been paid. */
  isPaid: boolean
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
  /** Transactions this month still awaiting an exchange rate — excluded from every actual, so >0 marks the totals incomplete. */
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
  currency: string
  exchangeRate: number
  baseAmount: number
  /** True when this foreign row's exchange rate is unresolved (counted at face value until reconciled). */
  fxPending?: boolean
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
  /** For a transfer: the source bank's posting date, or null while the departure is unknown (held for review). */
  departedOn?: string | null
  /** For a transfer: the destination bank's posting date, or null while the money is in transit. */
  receivedOn?: string | null
  /** For a transfer: the destination statement's reference for the credit leg. */
  receiptBankReference?: string | null
  /** For a transfer: 'Completed' | 'InTransit' | 'PendingReview', derived from the two bank legs. */
  transferStatus?: TransferStatus | null
  /** Household member this whole transaction is attributed to, if any. */
  memberId: string | null
  memberName: string | null
  isSplit: boolean
  splits: TransactionSplitDto[]
}

/** Matches Domain.Enums.TransferStatus, serialized by name. */
export type TransferStatus = 'Completed' | 'InTransit' | 'PendingReview'

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
}

/** A recorded transfer a statement row could be the other side of; see ImportCandidate.transferMatches. */
export interface TransferMatchCandidate {
  transferId: string
  counterpartyAccountId: string
  counterpartyAccountName: string
  amount: number
  currency: string
  departedOn: string | null
  receivedOn: string | null
  payee: string
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
   * transaction is created. Requires `transferAccountId` to name the same counterparty.
   */
  matchTransferId?: string | null
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
  /** Actually-received income (Σ income actuals). */
  incomeReceived: number
  /** Budgeted spending (Σ non-income planned). */
  planned: number
  /** Actual spending (Σ non-income actuals). */
  spent: number
}

export interface BudgetTrendsDto {
  points: BudgetTrendPointDto[]
  totalIncome: number
  totalIncomeReceived: number
  totalSpent: number
}

export interface AnnualMonthDto {
  month: number
  key: string
  hasBudget: boolean
  income: number
  planned: number
  spent: number
}

export interface AnnualCategoryDto {
  name: string
  /** "Expense" or "Savings". */
  kind: string
  /** Total actual spending for this category across the year. */
  total: number
  /** Total ÷ number of budgeted months. */
  averagePerMonth: number
}

export interface AnnualSummaryDto {
  year: number
  months: AnnualMonthDto[]
  totalIncome: number
  totalPlanned: number
  totalSpent: number
  /** How many of the 12 months have a budget (the averaging denominator). */
  budgetedMonths: number
  /** Per-category spending across the year, biggest average first. */
  categories: AnnualCategoryDto[]
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

// Matches Domain.Enums.AccrualMethod (serialized as a number). The form no longer
// offers a choice — new jars are TargetByDate and edits echo the stored method
// (imported jars may be StraightLine/DailyRate) — but the wire field remains.
export const AccrualMethod = { StraightLine: 0, TargetByDate: 1, ProportionalPool: 2, DailyRate: 3 } as const

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
  targetAmount: number
  /** ISO date (yyyy-MM-dd) or null. */
  targetDate: string | null
  coverStart: string | null
  coverEnd: string | null
  /** Numeric AccrualMethod. */
  accrual: number
  /** A Recurring jar's cycle length in months (its date rolls forward by this); null for Goals. */
  recurMonths: number | null
  /** The account holding this jar's money (rule 2); always set. */
  fundingAccountId: string
  isArchived: boolean
  /**
   * The jar's actual balance in its account as of `balanceAsOf`: the allocations posted
   * against it, never planned contributions (rule 1). Null when the account's balance is
   * unavailable (rule 67), never zero.
   */
  currentBalance: number | null
  /** The date `currentBalance` is calculated as of. */
  balanceAsOf: string
  /** What to put in this month, per the fund's accrual method (0 when the balance is unavailable). */
  requiredMonthlyContribution: number
  /** When the fund reaches its target at the required rate; null when funded/open-ended. */
  projectedFullyFundedDate: string | null
  /** Unavailable | Overspent | Unfunded | FullyFunded | Behind | OnTrack. */
  status: string
}

/** One jar's line in its account's ledger (GET /jars/ledger). */
export interface JarLedgerLineDto {
  jarId: string
  name: string
  balance: number
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
  netMonthlyIncome: number
  personalSavingsAccountId: string | null
  displayOrder: number
  isArchived: boolean
  /** This member's share of household net income (0–1). */
  incomeSharePct: number
}

/** Per-member attributed spending (the "who spent what" lens). */
export interface MemberSpendingDto {
  memberId: string
  name: string
  spent: number
}

// Matches Domain.Enums.AllocationRuleType (serialized as a number).
export const AllocationRuleType = {
  FundEnvelopes: 0,
  FundJars: 1,
  FixedPerMember: 2,
  SplitRemainderToMembers: 3,
} as const

export const ALLOCATION_RULE_LABELS: Record<number, string> = {
  0: 'Living costs',
  1: 'Jars',
  2: 'Pocket money',
  3: 'To savings',
}

// Matches Domain.Enums.SplitMethod (serialized as a number).
export const SplitMethod = { Equal: 0, ByIncomeRatio: 1, BalanceTilt: 2 } as const

export const SPLIT_METHOD_LABELS: Record<number, string> = {
  0: 'Split equally',
  1: 'By income',
  2: 'Balance-aware',
}

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
  sourceAccountId: string | null
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
  incomeFromBudget: boolean
  unattributedPlanned: number
  items: MemberIncomeDto[]
}

export interface MemberIncomeDto {
  memberId: string
  name: string
  planned: number
  received: number
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

/** Returned by an invite: the new membership and, for link invites, the raw token (shown once). */
export interface InviteResultDto {
  membership: MembershipDto
  inviteToken: string | null
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
  preferredCurrency?: string
  numberFormat?: string
  households?: HouseholdSummary[]
  /** True for invite-created logins that haven't accepted the terms yet (blocking consent prompt). */
  needsConsent?: boolean
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
