import type { Page, Route } from '@playwright/test'

/**
 * Shared API stubs + auth setup for the end-to-end specs, so every page renders
 * without a backend. Used by both the accessibility scan (a11y.spec) and the
 * mobile-layout guard (mobile-layout.spec).
 */

// Every feature flag on, so role/flag-gated UI renders for the scans.
export const FLAGS = { accounts: true, multiCurrency: true, camtImport: true, reports: true, jars: true, householdAllocation: true, householdAccess: true }

// The current login (Owner) for /auth/me, so role-gated UI resolves to full access.
// needsConsent stays false so the blocking consent prompt never occludes the scanned pages.
// A single own household so the account page reads as an owner (no "start your own budget" card).
function meResponse() {
  return {
    userId: 'u1',
    email: 'e2e@allotjar.app',
    displayName: 'Chris',
    role: 0,
    ownerId: 'u1',
    memberId: null,
    needsConsent: false,
    households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
  }
}

// A representative access list so the /access table renders both status badges (Active +
// Invited), the per-row role <select> and the Remove button.
function memberships() {
  return [
    { id: 'mem1', email: 'e2e@allotjar.app', displayName: 'Chris', role: 0, status: 0, memberId: null, isOwner: true, isSelf: true, createdUtc: '2026-01-01T00:00:00Z' },
    { id: 'mem2', email: 'liza@example.eu', displayName: 'Liza', role: 1, status: 0, memberId: null, isOwner: false, isSelf: false, createdUtc: '2026-02-01T00:00:00Z' },
    { id: 'mem3', email: 'guest@example.eu', displayName: null, role: 3, status: 1, memberId: null, isOwner: false, isSelf: false, createdUtc: '2026-03-01T00:00:00Z' },
  ]
}

function householdMembers() {
  return [
    { id: 'm1', name: 'Chris', netMonthlyIncome: 6000, personalSavingsAccountId: 'acc1', displayOrder: 0, isArchived: false, incomeSharePct: 0.6 },
    { id: 'm2', name: 'Liza', netMonthlyIncome: 4000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.4 },
  ]
}

function memberSpending() {
  return [{ memberId: 'm1', spent: 1234 }, { memberId: 'm2', spent: 980 }]
}

// A couple of sinking funds so the /funds page renders cards, badges and progress
// bars (incl. an overspent one).
function jars() {
  return [
    { id: 'f1', name: 'Home insurance', kind: 0, targetAmount: 300, targetDate: '2026-12-01', coverStart: null, coverEnd: null, accrual: 0, recurMonths: 12, openingBalance: 0, openingAsOf: null, fundingAccountId: null, isArchived: false, currentBalance: 120, requiredMonthlyContribution: 25, projectedFullyFundedDate: '2026-11-01', status: 'OnTrack' },
    { id: 'f2', name: 'Holiday', kind: 1, targetAmount: 1000, targetDate: null, coverStart: null, coverEnd: null, accrual: 1, recurMonths: null, openingBalance: 0, openingAsOf: null, fundingAccountId: null, isArchived: false, currentBalance: -40, requiredMonthlyContribution: 0, projectedFullyFundedDate: null, status: 'Overspent' },
  ]
}

// A small but representative budget: income, an expense line that is also a bill,
// and a sinking fund — so the dashboard renders the full grid (groups, rows,
// inline inputs, the bill pill and the bills banner).
function budgetMonth(year: number, month: number) {
  return {
    id: 'm1',
    key: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: 1300,
    remainingToBudget: 1700,
    isBalanced: false,
    categories: [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 3000, totalActual: 3000,
        items: [{ id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 3000, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false }],
      },
      {
        id: 'c1', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 1100, totalActual: 200,
        items: [{ id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 200, remaining: 900, savingsId: null, savingsAvailable: null, dueDay: 1, isPaid: false }],
      },
      {
        id: 'f1', name: 'Sinking Funds', kind: 'Savings', displayOrder: 1, totalPlanned: 200, totalActual: 0,
        items: [{ id: 'i-car', name: 'Car', displayOrder: 0, plannedAmount: 200, actualAmount: 0, remaining: 200, savingsId: 'fund-car', savingsAvailable: 600, dueDay: null, isPaid: false }],
      },
    ],
  }
}

function allocationProfile() {
  return {
    id: 'p1', name: 'Household allocation', sourceAccountId: 'acc0', balanceLeanPercent: 25,
    rules: [
      { id: 'r0', order: 0, type: 0, split: 0, fixedAmountPerMember: 0 },
      { id: 'r1', order: 1, type: 1, split: 0, fixedAmountPerMember: 0 },
      { id: 'r2', order: 2, type: 2, split: 0, fixedAmountPerMember: 250 },
      { id: 'r3', order: 3, type: 3, split: 2, fixedAmountPerMember: 0 },
    ],
  }
}

function allocationPreview() {
  return {
    pool: 8411.61, envelopesTotal: 3641, jarsTotal: 2164, transfersCreated: 0,
    steps: [
      { type: 0, total: 3641, perMember: [{ memberId: 'm1', name: 'Chris', amount: 1820.5 }, { memberId: 'm2', name: 'Liza', amount: 1820.5 }] },
      { type: 3, total: 2106.61, perMember: [{ memberId: 'm1', name: 'Chris', amount: 1259.14 }, { memberId: 'm2', name: 'Liza', amount: 847.47 }] },
    ],
    members: [
      { memberId: 'm1', name: 'Chris', netIncome: 4411.64, residual: 1259.14, savingsBalance: 35631.96, savingsAccountId: 'acc1' },
      { memberId: 'm2', name: 'Liza', netIncome: 3999.97, residual: 847.47, savingsBalance: 46033.38, savingsAccountId: 'acc2' },
    ],
  }
}

function accountsList() {
  return [
    { id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 1000, currentBalance: 1200, displayOrder: 0 },
    { id: 'acc1', name: 'Savings Joint', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 5000, displayOrder: 1 },
  ]
}

function accountReconciliation() {
  return [
    { accountId: 'acc1', accountName: 'Savings Joint', currentBalance: 5000, backedJarsTotal: 3000, backedJarCount: 2, float: 2000 },
  ]
}

// Two not-yet-imported rows so the import review table renders (checkboxes, per-row
// category/member selects, bulk controls). A `layout` is included so the generic-CSV mapping
// panel — column selects, the sample-rows table, delimiter/date-format controls and the
// detected-format readout — is covered by the a11y + mobile-overflow scans too.
function importPreview() {
  return {
    totalEntries: 3, newCount: 2, skippedDuplicates: 1, credits: 0, debits: 2,
    detectedFormat: 'GenericCsv',
    items: [
      { reference: 'csv:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Rent', likelyTransfer: false },
      { reference: 'csv:b#0', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: true },
    ],
    layout: {
      columns: ['Date', 'Description', 'Amount'],
      // Distinct from the review-row payees so getByText('AUTOMARKET'/'WOLT') stays unambiguous.
      sampleRows: [
        ['2026-06-17', 'PETROL STATION', '-35.00'],
        ['2026-06-15', 'FOOD DELIVERY', '-80.90'],
      ],
      suggested: {
        delimiter: ',', hasHeader: true, dateColumn: 0, amountColumn: 2, descriptionColumn: 1,
        currencyColumn: null, dateFormat: 'yyyy-MM-dd', decimalStyle: 0, defaultCurrency: 'EUR',
      },
    },
  }
}

// A representative transaction list so the Transactions table renders every state:
// an assigned expense, an unassigned one (the inline assign <select>), a split, a transfer,
// and an income — exercising the badges, dropdowns and row action buttons.
function transactions() {
  const base = { currency: 'EUR', exchangeRate: 1, bankReference: null, transferAccountId: null, transferAccountName: null, memberId: null, memberName: null }
  return [
    { ...base, id: 't1', date: '2026-06-20', payee: 'Welbees Supermarket', amount: 64.5, baseAmount: 64.5, type: 0, budgetItemId: 'i-rent', budgetItemName: 'Rent', accountId: 'acc0', accountName: 'Joint Current', isSplit: false, splits: [] },
    { ...base, id: 't2', date: '2026-06-19', payee: 'Unknown Shop', amount: 12, baseAmount: 12, type: 0, budgetItemId: null, budgetItemName: null, accountId: 'acc0', accountName: 'Joint Current', isSplit: false, splits: [] },
    { ...base, id: 't3', date: '2026-06-18', payee: 'Grocer + Pharmacy', amount: 50, baseAmount: 50, type: 0, budgetItemId: null, budgetItemName: null, accountId: 'acc0', accountName: 'Joint Current', isSplit: true,
      splits: [
        { id: 's1', budgetItemId: 'i-rent', budgetItemName: 'Rent', memberId: null, memberName: null, amount: 30 },
        { id: 's2', budgetItemId: 'i-car', budgetItemName: 'Car', memberId: null, memberName: null, amount: 20 },
      ] },
    { ...base, id: 't4', date: '2026-06-17', payee: 'Move to savings', amount: 200, baseAmount: 200, type: 2, budgetItemId: null, budgetItemName: null, accountId: 'acc0', accountName: 'Joint Current', transferAccountId: 'acc1', transferAccountName: 'Savings Joint', isSplit: false, splits: [] },
    { ...base, id: 't5', date: '2026-06-16', payee: 'Acme Payroll', amount: 3000, baseAmount: 3000, type: 1, budgetItemId: 'i-pay', budgetItemName: 'Take-home Pay', accountId: 'acc0', accountName: 'Joint Current', isSplit: false, splits: [] },
  ]
}

// A few months of trends so the Reports page renders its summary cards, the
// income-vs-spending bars (incl. an overspent month) and the breakdown select.
function budgetTrends() {
  return {
    points: [
      { key: '2026-04', year: 2026, month: 4, income: 3000, incomeReceived: 2950, spent: 2400 },
      { key: '2026-05', year: 2026, month: 5, income: 3000, incomeReceived: 3000, spent: 3200 },
      { key: '2026-06', year: 2026, month: 6, income: 3000, incomeReceived: 3000, spent: 1300 },
    ],
    totalIncome: 9000,
    totalIncomeReceived: 8950,
    totalSpent: 6900,
  }
}

// A full year with a mix of budgeted and not-yet-budgeted months, so the annual
// table (incl. the muted "no budget" rows), totals, and the per-category average
// bars all render.
function annualSummary(year: number) {
  const spentByMonth: Record<number, number> = { 4: 2400, 5: 3200, 6: 1300 }
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1
    const hasBudget = month in spentByMonth
    return { month, hasBudget, income: hasBudget ? 3000 : 0, spent: spentByMonth[month] ?? 0 }
  })
  return {
    year,
    months,
    totalIncome: 9000,
    totalSpent: 6900,
    budgetedMonths: 3,
    categories: [
      { name: 'Housing', kind: 'Expense', averagePerMonth: 1100, total: 3300 },
      { name: 'Groceries', kind: 'Expense', averagePerMonth: 400, total: 1200 },
      { name: 'Car', kind: 'Savings', averagePerMonth: 200, total: 600 },
    ],
  }
}

/** Stub every /api call so the SPA renders content without a backend. */
export async function mockApi(route: Route) {
  const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
  const json = (body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  if (path === '/features') return json(FLAGS)
  // Signed-out by default: the cookie-bootstrap refresh fails unless a test opts in via mockSignedIn.
  if (path === '/auth/refresh') {
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'No session.' }) })
  }
  if (path === '/auth/me') return json(meResponse())
  if (path === '/access/members') return json(memberships())
  if (path === '/transactions') return json(transactions())
  if (path === '/import/preview') return json(importPreview())
  if (path === '/budget/current') return json(budgetMonth(2026, 6))
  if (/^\/budget\/\d+\/\d+$/.test(path)) {
    const [, , y, m] = path.split('/')
    return json(budgetMonth(Number(y), Number(m)))
  }
  if (path === '/accounts') return json(accountsList())
  if (path === '/accounts/reconciliation') return json(accountReconciliation())
  if (path === '/jars') return json(jars())
  if (path === '/members') return json(householdMembers())
  if (path === '/members/spending') return json(memberSpending())
  if (path === '/allocation/profile') return json(allocationProfile())
  if (/^\/allocation\/preview\/\d+\/\d+$/.test(path)) return json(allocationPreview())
  if (path === '/budget/months') return json([])
  if (path === '/budget/templates') return json([])
  if (path === '/reports/trends') return json(budgetTrends())
  if (/^\/reports\/annual\/\d+$/.test(path)) {
    const year = Number(path.split('/').pop())
    return json(annualSummary(year))
  }
  return json([]) // anything else → empty
}

export const ONBOARDING_EMAIL = 'e2e@allotjar.app'
// A fully-completed onboarding record so the welcome/tour/checklist stay out of
// the per-route scans (they're scanned on their own).
const ONBOARDING_DONE = JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true })

/** The session body returned by /auth/refresh (and login) for the e2e user. */
export function authResponse(email = 'e2e@allotjar.app') {
  return { token: 'e2e-token', expiresAtUtc: '2030-01-01T00:00:00Z', userId: 'u1', email, role: 0, displayName: 'Chris' }
}

/**
 * Opt a page into a signed-in session: POST /auth/refresh restores it, which is how the SPA now
 * bootstraps auth on a cold load (the access token lives in memory, not localStorage). Registered
 * after the catch-all so it wins for the refresh route.
 */
export async function mockSignedIn(page: Page, email = 'e2e@allotjar.app') {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(authResponse(email)) }),
  )
}

/** Sign in as the Owner (refresh session + email + completed onboarding) and stub the API. */
export async function authedSetup(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(
    ({ t, done }) => {
      localStorage.setItem('zbb.theme', t)
      localStorage.setItem('zbb.email', 'e2e@allotjar.app')
      localStorage.setItem('zbb.onboarding:e2e@allotjar.app', done)
    },
    { t: theme, done: ONBOARDING_DONE },
  )
  await page.route('**/api/**', mockApi)
  await mockSignedIn(page)
}

/** The authenticated routes that render an AppShell page, for full-app scans. */
export const AUTHED_ROUTES = ['/', '/transactions', '/accounts', '/jars', '/people', '/allocation', '/reports', '/import', '/help', '/account']
