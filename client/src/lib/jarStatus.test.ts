import { describe, it, expect } from 'vitest'
import { jarHorizonLabel, jarLastCycleLabel, jarMonthLabel, jarStatusChip } from './jarStatus'
import type { JarDto } from '../types'

function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'j1',
    name: 'Insurance',
    kind: 0,
    targetAmount: 600,
    targetDate: '2026-12-01',
    accrual: 1,
    monthlyContribution: null,
    includeDeadlineMonth: false,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-10-20',
    isArchived: false,
    currentBalance: 250,
    plannedThisMonth: 125,
    contributedThisMonth: 50,
    remainingThisMonth: 75,
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

describe('jarStatusChip', () => {
  it('chips the attention and celebration states', () => {
    expect(jarStatusChip('Behind')).toEqual({ label: 'Behind', tone: 'amber' })
    expect(jarStatusChip('Overspent')).toEqual({ label: 'Overspent', tone: 'rose' })
    expect(jarStatusChip('FullyFunded')).toEqual({ label: 'Funded', tone: 'teal' })
    expect(jarStatusChip('Unscheduled')).toEqual({ label: 'Needs a plan', tone: 'amber' })
  })

  it('calls out a missed recurring deadline (rule 20) and a cycle funded late (rule 57)', () => {
    expect(jarStatusChip('DeadlineMissed')).toEqual({ label: 'Deadline missed', tone: 'rose' })
    expect(jarStatusChip('FundedLate')).toEqual({ label: 'Funded late', tone: 'amber' })
  })

  it('flags an unavailable balance with a neutral chip (rule 67)', () => {
    expect(jarStatusChip('Unavailable')).toEqual({ label: 'Unavailable', tone: 'neutral' })
  })

  it('stays quiet for OnTrack and Ongoing', () => {
    expect(jarStatusChip('OnTrack')).toBeNull()
    expect(jarStatusChip('Ongoing')).toBeNull()
  })
})

describe('jarMonthLabel', () => {
  it('shows the plan, what came in and what is still to go as three figures (rule 14)', () => {
    expect(jarMonthLabel(jar(), 'EUR')).toBe('Plan €125.00 · in €50.00 · to go €75.00')
  })

  it('keeps the plan even when more than planned came in', () => {
    expect(jarMonthLabel(jar({ contributedThisMonth: 200, remainingThisMonth: 0 }), 'EUR')).toBe('Plan €125.00 · in €200.00 · to go €0.00')
  })

  it('names an unavailable balance rather than a bare dash', () => {
    expect(jarMonthLabel(jar({ currentBalance: null, plannedThisMonth: 0, status: 'Unavailable' }), 'EUR')).toBe('Balance not available')
  })

  it('explains a zero-plan jar instead of a bare dash', () => {
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, currentBalance: 600, status: 'FullyFunded' }), 'EUR')).toBe('Fully funded')
    // Rule 47: money above a lowered target stays and is shown.
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, currentBalance: 900, status: 'FullyFunded' }), 'EUR')).toBe('Fully funded · €300.00 above target')
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, targetDate: null, deadline: null, status: 'Unscheduled' }), 'EUR')).toBe('Give it a date or a monthly amount')
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, status: 'OnTrack' }), 'EUR')).toBe('Nothing to set aside this month')
  })

  it('keeps a missed deadline and its shortfall in view until the user acts (rule 20), or says the target came late (rule 57)', () => {
    const missed = jar({ status: 'DeadlineMissed', deadline: '2026-09-01', shortfall: 150, currentBalance: 450, plannedThisMonth: 150, remainingThisMonth: 150 })
    expect(jarMonthLabel(missed, 'EUR')).toMatch(/^Deadline .*Sep.*2026 missed · €150\.00 short$/)
    expect(jarMonthLabel(jar({ status: 'FundedLate', deadline: '2026-09-01', shortfall: 0, currentBalance: 600, plannedThisMonth: 0, remainingThisMonth: 0 }), 'EUR')).toMatch(
      /^Funded after the deadline on .*Sep.*2026$/,
    )
  })
})

describe('W04 — completed and skipped (rules 55, 60)', () => {
  const done = jar({ kind: 1, recurMonths: null, completedOn: '2026-09-27', plannedThisMonth: 0, remainingThisMonth: 0, fundingCompletesOn: null, status: 'Completed' })

  it('chips a completed goal neutrally and says what is left to move', () => {
    expect(jarStatusChip('Completed')).toEqual({ label: 'Completed', tone: 'neutral' })
    expect(jarMonthLabel(done, 'EUR')).toBe('Completed · €250.00 left to move')
    expect(jarMonthLabel(jar({ ...done, currentBalance: 0 }), 'EUR')).toBe('Completed')
    expect(jarHorizonLabel(done)).toMatch(/^Completed on .*Sep.*2026 · no more contributions planned$/)
  })

  it('reads "Skipped this month" for a jar whose contribution the user skipped', () => {
    expect(jarMonthLabel(jar({ skippedThisMonth: true, plannedThisMonth: 0, remainingThisMonth: 0, contributedThisMonth: 0 }), 'EUR')).toBe('Skipped this month')
  })
})

describe('jarHorizonLabel', () => {
  it('names the funding-completion month and the date it serves: the next due date and cadence of a recurring jar, or the date a goal is needed by (rule 36)', () => {
    expect(jarHorizonLabel(jar())).toMatch(/^Funded by Nov 2026 · next due .*Dec.*2026 · repeats every year$/)
    expect(jarHorizonLabel(jar({ kind: 1, recurMonths: null }))).toMatch(/^Funded by Nov 2026 · needed by .*Dec.*2026$/)
  })

  it('words the cadence the way the Repeats select does: every month, every N months, every year', () => {
    expect(jarHorizonLabel(jar({ recurMonths: 1 }))).toMatch(/^Funded by Nov 2026 · next due .*Dec.*2026 · repeats every month$/)
    expect(jarHorizonLabel(jar({ recurMonths: 6 }))).toMatch(/^Funded by Nov 2026 · next due .*Dec.*2026 · repeats every 6 months$/)
    expect(jarHorizonLabel(jar({ recurMonths: 12 }))).toMatch(/· repeats every year$/)
  })

  it('shows a fixed monthly target as an estimate, never a deadline (rule 58)', () => {
    const fixed = jar({ accrual: 2, monthlyContribution: 100, targetDate: null, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: 6, recurMonths: null, kind: 1 })
    expect(jarHorizonLabel(fixed)).toBe('About 6 more months at this rate (an estimate, not a deadline)')
    expect(jarHorizonLabel({ ...fixed, estimatedMonthsToTarget: 1 })).toBe('About 1 more month at this rate (an estimate, not a deadline)')
  })

  it('reads "Ongoing" for a fixed amount with no target (rule 16), and nothing when there is nothing to say', () => {
    expect(jarHorizonLabel(jar({ status: 'Ongoing', targetAmount: 0, deadline: null, fundingCompletesOn: null }))).toBe('Ongoing')
    expect(jarHorizonLabel(jar({ status: 'Unavailable' }))).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'Unscheduled' }))).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, deadline: null }))).toBeNull()
  })

  it('tells a missed or late jar what to do next instead of a funding month (rules 20, 57)', () => {
    expect(jarHorizonLabel(jar({ status: 'DeadlineMissed', deadline: '2026-09-01' }))).toBe('Mark the cycle paid, or dismiss it to save toward the next one')
    expect(jarHorizonLabel(jar({ status: 'FundedLate', deadline: '2026-09-01' }))).toBe('Mark the cycle paid, or dismiss it to save toward the next one')
  })

  it('falls back to the date alone once funding is complete but the date is still ahead: next due (and cadence) for a recurring jar, needed by for a goal', () => {
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null }))).toMatch(/^Next due .*Dec.*2026 · repeats every year$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, recurMonths: 1 }))).toMatch(/^Next due .*Dec.*2026 · repeats every month$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, recurMonths: 6 }))).toMatch(/^Next due .*Dec.*2026 · repeats every 6 months$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, kind: 1, recurMonths: null }))).toMatch(/^Needed by .*Dec.*2026$/)
  })
})

describe('jarLastCycleLabel', () => {
  const cycle = {
    id: 'c1',
    deadline: '2025-12-01',
    targetAmount: 600,
    outcome: 'Paid',
    balanceAtDeadline: 600,
    paymentTransactionId: 'tx1',
    paymentPayee: 'Allianz',
    paidOn: '2025-11-28',
    paidAmount: 550,
    paidOnTime: true,
    closedOn: '2025-11-28',
  }

  it('says how the last cycle ended: paid (with the date and amount), funded on time, funded late or missed', () => {
    expect(jarLastCycleLabel(jar({ lastCycle: cycle }), 'EUR')).toMatch(/^Last cycle · due .*Dec.*2025 · paid .*Nov.*2025 \(€550\.00\)$/)
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, paidOn: '2025-12-03', paidOnTime: false } }), 'EUR')).toMatch(/, after the deadline$/)
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'Funded', paymentTransactionId: null, paidOn: null, paidAmount: null, paidOnTime: false } }), 'EUR')).toMatch(
      /· funded on time, payment not recorded$/,
    )
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'FundedLate', paidOnTime: false } }), 'EUR')).toMatch(/· funded late$/)
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'Missed', balanceAtDeadline: 400, paidOnTime: false } }), 'EUR')).toMatch(/· missed$/)
  })

  it('reads a cycle whose payment was removed before its deadline as waiting, not funded on time (D17)', () => {
    const waiting = { ...cycle, outcome: 'Waiting', balanceAtDeadline: null, paymentTransactionId: null, paidOn: null, paidAmount: null, paidOnTime: false }
    const label = jarLastCycleLabel(jar({ lastCycle: waiting }), 'EUR')
    expect(label).toMatch(/· waiting for the deadline$/)
    expect(label).not.toMatch(/funded/)
  })

  it('is silent before any cycle has closed, and for a Goal', () => {
    expect(jarLastCycleLabel(jar(), 'EUR')).toBeNull()
    expect(jarLastCycleLabel(jar({ kind: 1, recurMonths: null, lastCycle: cycle }), 'EUR')).toBeNull()
  })
})
