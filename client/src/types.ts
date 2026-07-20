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
  type: number
  bankReference: string | null
  budgetItemId: string | null
  budgetItemName: string | null
  accountId: string | null
  accountName: string | null
  /** For a transfer, the destination account the money moved into. */
  transferAccountId: string | null
  transferAccountName: string | null
  /** Household member this whole transaction is attributed to, if any. */
  memberId: string | null
  memberName: string | null
  isSplit: boolean
  splits: TransactionSplitDto[]
}

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

export interface AccountDto {
  id: string
  name: string
  /** Numeric AccountType. */
  type: number
  currency: string
  openingBalance: number
  /** Opening balance plus the net of the account's transactions. */
  currentBalance: number
  displayOrder: number
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
  transfers: number
}

export interface AccountReconciliationDto {
  accountId: string
  accountName: string
  currentBalance: number
  backedJarsTotal: number
  backedJarCount: number
  /** CurrentBalance − BackedJarsTotal: unallocated float (or shortfall when negative). */
  float: number
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
  openingBalance: number
  openingAsOf: string | null
  fundingAccountId: string | null
  isArchived: boolean
  /** Opening balance plus every contribution minus every spend, across all months. */
  currentBalance: number
  /** What to put in this month, per the fund's accrual method. */
  requiredMonthlyContribution: number
  /** When the fund reaches its target at the required rate; null when funded/open-ended. */
  projectedFullyFundedDate: string | null
  /** Overspent | Unfunded | FullyFunded | Behind | OnTrack. */
  status: string
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
  savingsBalance: number
  savingsAccountId: string | null
}

export interface AllocationResultDto {
  pool: number
  envelopesTotal: number
  jarsTotal: number
  steps: AllocationStepDto[]
  members: MemberAllocationDto[]
  transfersCreated: number
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
