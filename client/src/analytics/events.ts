// The single source of truth for the analytics events the app emits. Keeping the names
// here (rather than as scattered string literals) makes the catalogue reviewable and
// the call sites consistent. GA4 also auto-collects session_start, first_visit,
// scroll, user_engagement etc. on top of these.

export const EVENTS = {
  // Auth
  login: 'login',
  signUp: 'sign_up',
  logout: 'logout',
  loginFailed: 'login_failed',
  passwordChanged: 'password_changed',
  passwordResetRequested: 'password_reset_requested',
  passwordResetCompleted: 'password_reset_completed',
  inviteAccepted: 'invite_accepted',

  // Household access
  memberInvited: 'member_invited',
  memberRoleChanged: 'member_role_changed',
  memberRevoked: 'member_revoked',

  // Navigation / shell
  navClick: 'nav_click',
  themeChanged: 'theme_changed',

  // Budget / dashboard
  budgetMonthCreated: 'budget_month_created',
  budgetItemEdited: 'budget_item_edited',
  monthNavigated: 'month_navigated',

  // Transactions
  transactionAdded: 'transaction_added',
  transactionEdited: 'transaction_edited',
  transactionDeleted: 'transaction_deleted',
  transferCreated: 'transfer_created',
  transactionsFiltered: 'transactions_filtered',

  // Import
  importStarted: 'import_started',
  importPreviewed: 'import_previewed',
  importCommitted: 'import_committed',

  // Funds
  fundCreated: 'fund_created',
  fundEdited: 'fund_edited',
  fundArchived: 'fund_archived',

  // Members / allocation
  memberAdded: 'member_added',
  memberEdited: 'member_edited',
  allocationPreviewed: 'allocation_previewed',
  allocationCommitted: 'allocation_committed',

  // Accounts
  accountCreated: 'account_created',
  accountEdited: 'account_edited',

  // Reports / help
  reportViewed: 'report_viewed',
  helpGuideOpened: 'help_guide_opened',

  // Onboarding
  onboardingStarted: 'onboarding_started',
  onboardingStepCompleted: 'onboarding_step_completed',
  onboardingCompleted: 'onboarding_completed',
  onboardingDismissed: 'onboarding_dismissed',
  tourReplayed: 'tour_replayed',

  // Consent / errors
  consentUpdated: 'consent_updated',
  apiError: 'api_error',
} as const

export type AnalyticsEventName = (typeof EVENTS)[keyof typeof EVENTS]
