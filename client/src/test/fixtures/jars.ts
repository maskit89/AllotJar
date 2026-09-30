// Jar fixtures the Jars, Dashboard, Allocation, Transactions and Import tests share: a jar as
// GET /jars lists it, the account backing it, the planner's answer to POST /jars/schedule, and
// an account's jar ledger. Each is a full DTO with the fields a test doesn't name filled in.
import type { AccountDto, JarAccountLedgerDto, JarDto, JarScheduleDto, JarScheduleMonthDto } from '../../types'

/**
 * Joint Current (acc1), the account that backs the jars. Its name deliberately collides with no jar
 * name, so the funding-account <option> never creates a duplicate text match.
 */
export function account(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0, ...over }
}

/** A jar: a €300 goal on Joint Current (acc1), due 1 December 2026, on track. */
export function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    accrual: 1,
    monthlyContribution: null,
    includeDeadlineMonth: false,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-09-26',
    isArchived: false,
    currentBalance: 120,
    plannedThisMonth: 25,
    contributedThisMonth: 0,
    remainingThisMonth: 25,
    deadline: '2026-12-01',
    fundingCompletesOn: '2026-11-30',
    estimatedMonthsToTarget: null,
    shortfall: null,
    lastCycle: null,
    completedOn: null,
    canDelete: false,
    skippedThisMonth: false,
    status: 'OnTrack',
    ...over,
  }
}

/** One month of a jar's schedule (not skipped, no budget yet, fits its income). */
export function scheduleMonth(year: number, month: number, planned: number, over: Partial<JarScheduleMonthDto> = {}): JarScheduleMonthDto {
  return { year, month, planned, skipped: false, hasBudget: false, shortfall: null, ...over }
}

/** The planner's answer to POST /jars/schedule: 100 a month from September to November 2026. */
export function schedule(over: Partial<JarScheduleDto> = {}): JarScheduleDto {
  return {
    accrual: 1,
    isOngoing: false,
    hasSchedule: true,
    balance: 0,
    remaining: 300,
    months: [scheduleMonth(2026, 9, 100), scheduleMonth(2026, 10, 100), scheduleMonth(2026, 11, 100)],
    total: 300,
    deadline: '2026-12-01',
    fundingCompletesOn: '2026-11-30',
    estimatedMonths: null,
    unplanned: 0,
    ...over,
  }
}

/** Joint Current's jar ledger: 1,000 in the account, 400 in Home insurance, 600 unallocated. */
export function ledger(over: Partial<JarAccountLedgerDto> = {}): JarAccountLedgerDto {
  return {
    accountId: 'acc1',
    accountName: 'Joint Current',
    currency: 'EUR',
    asOf: '2026-09-26',
    accountBalance: 1000,
    unallocated: 600,
    positiveAllocations: 400,
    hasBackingDeficit: false,
    unreconciledAllocations: 0,
    requiresReview: false,
    jars: [{ jarId: 'f1', name: 'Home insurance', balance: 400, isArchived: false }],
    ...over,
  }
}
