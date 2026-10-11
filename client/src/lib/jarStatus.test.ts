import { describe, it, expect } from 'vitest'
import { byAttention, cadenceLabel, JAR_CHIP_TONE, jarCardChip, jarDate, jarDueLabel, jarHorizonLabel, jarLastCycleLabel, jarMonthLabel, jarStatusChip } from './jarStatus'
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
    monthOnly: false,
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

  it('asks an Unscheduled jar for what would plan it: a date or a monthly amount with a target, a target as well without one (rule 17)', () => {
    const unscheduled: Partial<JarDto> = { kind: 1, recurMonths: null, plannedThisMonth: 0, remainingThisMonth: 0, targetDate: null, deadline: null, fundingCompletesOn: null, status: 'Unscheduled' }
    expect(jarMonthLabel(jar({ ...unscheduled, targetAmount: 600 }), 'EUR')).toBe('Give it a date or a monthly amount')
    // A date alone can't plan a target-less jar, so that one is asked for a target too.
    expect(jarMonthLabel(jar({ ...unscheduled, targetAmount: 0 }), 'EUR')).toBe('Give it a target and a date, or a monthly amount')
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
    // The chip and this line say it is completed; the horizon adds nothing.
    expect(jarHorizonLabel(done, 'EUR')).toBeNull()
  })

  it('reads "Skipped this month" for a jar whose contribution the user skipped', () => {
    expect(jarMonthLabel(jar({ skippedThisMonth: true, plannedThisMonth: 0, remainingThisMonth: 0, contributedThisMonth: 0 }), 'EUR')).toBe('Skipped this month')
  })
})

describe('jarHorizonLabel', () => {
  it('names the date the plan serves, never the earlier funding month in its place (rule 36): due and how often for a recurring jar, needed by for a goal', () => {
    expect(jarHorizonLabel(jar(), 'EUR')).toMatch(/^Due .*Dec.*2026 · yearly$/)
    expect(jarHorizonLabel(jar({ kind: 1, recurMonths: null }), 'EUR')).toMatch(/^Needed by .*Dec.*2026$/)
    expect(jarHorizonLabel(jar(), 'EUR')).not.toMatch(/Nov/)
  })

  it('names only the month when asked (a phone\'s narrow card), the exact day in jarDueLabel', () => {
    const day = jar({ targetDate: '2026-12-15', deadline: '2026-12-15' })
    expect(jarHorizonLabel(day, 'EUR', { month: true })).toBe('Due Dec 2026 · yearly')
    expect(jarHorizonLabel({ ...day, kind: 1, recurMonths: null }, 'EUR', { month: true })).toBe('Needed by Dec 2026')
    expect(jarHorizonLabel(day, 'EUR')).toMatch(/^Due .*15.* · yearly$/)
    expect(jarDueLabel(day)).toMatch(/^Due (Dec 15, 2026|15 Dec 2026)$/)
    expect(jarDueLabel({ ...day, recurMonths: null })).toMatch(/^Needed by (Dec 15, 2026|15 Dec 2026)$/)
    expect(jarDueLabel({ ...day, deadline: null })).toBeNull()
    // An estimate or a monthly amount has no date to shorten.
    const fixed = jar({ accrual: 2, monthlyContribution: 100, targetDate: null, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: 6, recurMonths: null, kind: 1 })
    expect(jarHorizonLabel(fixed, 'EUR', { month: true })).toBe('About 6 months to go (estimate)')
  })

  it('words the cadence the way the Repeats select does: monthly, every N months, yearly', () => {
    expect(jarHorizonLabel(jar({ recurMonths: 1 }), 'EUR')).toMatch(/^Due .*Dec.*2026 · monthly$/)
    expect(jarHorizonLabel(jar({ recurMonths: 6 }), 'EUR')).toMatch(/^Due .*Dec.*2026 · every 6 months$/)
    expect(jarHorizonLabel(jar({ recurMonths: 12 }), 'EUR')).toMatch(/· yearly$/)
  })

  it('shows a fixed monthly target as an estimate, never a deadline (rule 58)', () => {
    const fixed = jar({ accrual: 2, monthlyContribution: 100, targetDate: null, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: 6, recurMonths: null, kind: 1 })
    expect(jarHorizonLabel(fixed, 'EUR')).toBe('About 6 months to go (estimate)')
    expect(jarHorizonLabel({ ...fixed, estimatedMonthsToTarget: 1 }, 'EUR')).toBe('About 1 month to go (estimate)')
  })

  it('reads "every month" for a fixed amount with no target (rule 16), and nothing when there is nothing to say', () => {
    // An ongoing pot says what it sets aside (rule 16); without an amount there is nothing to add.
    expect(jarHorizonLabel(jar({ status: 'Ongoing', accrual: 2, monthlyContribution: 50, targetAmount: 0, deadline: null, fundingCompletesOn: null }), 'EUR')).toBe('€50.00 every month')
    expect(jarHorizonLabel(jar({ status: 'Ongoing', targetAmount: 0, deadline: null, fundingCompletesOn: null }), 'EUR')).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'Unavailable' }), 'EUR')).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'Unscheduled' }), 'EUR')).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, deadline: null }), 'EUR')).toBeNull()
  })

  it('adds nothing to a missed or late jar: the month line keeps the deadline and the shortfall in view, the card\'s buttons say what to do (rules 20, 57)', () => {
    expect(jarHorizonLabel(jar({ status: 'DeadlineMissed', deadline: '2026-09-01' }), 'EUR')).toBeNull()
    expect(jarHorizonLabel(jar({ status: 'FundedLate', deadline: '2026-09-01' }), 'EUR')).toBeNull()
  })

  it('keeps the date once funding is complete and the date is still ahead: due (and how often) for a recurring jar, needed by for a goal', () => {
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null }), 'EUR')).toMatch(/^Due .*Dec.*2026 · yearly$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, recurMonths: 1 }), 'EUR')).toMatch(/^Due .*Dec.*2026 · monthly$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, recurMonths: 6 }), 'EUR')).toMatch(/^Due .*Dec.*2026 · every 6 months$/)
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null, kind: 1, recurMonths: null }), 'EUR')).toMatch(/^Needed by .*Dec.*2026$/)
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
    expect(jarLastCycleLabel(jar({ lastCycle: cycle }), 'EUR')).toMatch(/^Last cycle paid .*Nov.*2025 \(€550\.00\)$/)
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, paidOn: '2025-12-03', paidOnTime: false } }), 'EUR')).toMatch(/^Last cycle paid .*Dec.*2025 \(€550\.00\), late$/)
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'Funded', paymentTransactionId: null, paidOn: null, paidAmount: null, paidOnTime: false } }), 'EUR')).toBe(
      'Last cycle funded on time',
    )
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'FundedLate', paidOnTime: false } }), 'EUR')).toBe('Last cycle funded late')
    expect(jarLastCycleLabel(jar({ lastCycle: { ...cycle, outcome: 'Missed', balanceAtDeadline: 400, paidOnTime: false } }), 'EUR')).toBe('Last cycle missed')
  })

  it('reads a cycle whose payment was removed before its deadline as waiting, not funded on time (D17)', () => {
    const waiting = { ...cycle, outcome: 'Waiting', balanceAtDeadline: null, paymentTransactionId: null, paidOn: null, paidAmount: null, paidOnTime: false }
    const label = jarLastCycleLabel(jar({ lastCycle: waiting }), 'EUR')
    expect(label).toBe('Last cycle waiting for its deadline')
    expect(label).not.toMatch(/funded/)
  })

  it('is silent before any cycle has closed, and for a Goal', () => {
    expect(jarLastCycleLabel(jar(), 'EUR')).toBeNull()
    expect(jarLastCycleLabel(jar({ kind: 1, recurMonths: null, lastCycle: cycle }), 'EUR')).toBeNull()
  })
})

describe('cadenceLabel', () => {
  it('words a cadence the way the Repeats select does: monthly, every N months, yearly', () => {
    expect(cadenceLabel(1)).toBe('monthly')
    expect(cadenceLabel(3)).toBe('every 3 months')
    expect(cadenceLabel(6)).toBe('every 6 months')
    expect(cadenceLabel(12)).toBe('yearly')
    // A cadence set through the API that the select doesn't offer.
    expect(cadenceLabel(24)).toBe('every 24 months')
  })
})

describe('jarDate (a date given as just a month)', () => {
  it('reads the month for a month-only date, and the full date otherwise', () => {
    expect(jarDate('2027-03-01', true)).toBe('Mar 2027')
    expect(jarDate('2027-03-01', false)).toMatch(/^Mar 1, 2027$|^1 Mar 2027$/)
    // Only the 1st is a month: a later day stays a full date whatever the flag says.
    expect(jarDate('2027-03-15', true)).toMatch(/15/)
  })

  it('words the card lines with the month', () => {
    const month = { monthOnly: true, targetDate: '2027-03-01', deadline: '2027-03-01' }
    expect(jarHorizonLabel(jar(month), 'EUR')).toBe('Due Mar 2027 · yearly')
    expect(jarHorizonLabel(jar({ ...month, kind: 1, recurMonths: null }), 'EUR')).toBe('Needed by Mar 2027')
    expect(jarMonthLabel(jar({ ...month, status: 'DeadlineMissed', shortfall: 150 }), 'EUR')).toBe('Deadline Mar 2027 missed · €150.00 short')
    expect(jarMonthLabel(jar({ ...month, status: 'FundedLate', shortfall: 0 }), 'EUR')).toBe('Funded after the Mar 2027 deadline')
    expect(
      jarLastCycleLabel(
        jar({
          ...month,
          lastCycle: { id: 'c1', deadline: '2026-03-01', targetAmount: 600, outcome: 'Other', balanceAtDeadline: null, paymentTransactionId: null, paymentPayee: null, paidOn: null, paidAmount: null, paidOnTime: false, closedOn: '2026-03-01' },
        }),
        'EUR',
      ),
    ).toBe('Last cycle due Mar 2026')
  })
})

describe('the jar cards (Dashboard jars card, Jars page)', () => {
  it('orders jars attention first, keeping the API order within a status', () => {
    const order = byAttention([
      jar({ id: 'done', status: 'Completed' }),
      jar({ id: 'full', status: 'FullyFunded' }),
      jar({ id: 'ok1', status: 'OnTrack' }),
      jar({ id: 'pot', status: 'Ongoing' }),
      jar({ id: 'plan', status: 'Unscheduled' }),
      jar({ id: 'late', status: 'FundedLate' }),
      jar({ id: 'slow', status: 'Behind' }),
      jar({ id: 'gone', status: 'Unavailable' }),
      jar({ id: 'over', status: 'Overspent' }),
      jar({ id: 'miss', status: 'DeadlineMissed' }),
      jar({ id: 'ok2', status: 'OnTrack' }),
    ])
    expect(order.map(({ jar: j }) => j.id)).toEqual(['miss', 'over', 'gone', 'slow', 'late', 'plan', 'ok1', 'pot', 'ok2', 'full', 'done'])
    // Each keeps its index in the API's list (its colour follows it).
    expect(order[0].index).toBe(9)
    expect(order[order.length - 1].index).toBe(0)
  })

  it('chips a card only when the jar has something to say, never an Unavailable chip beside "Not available"', () => {
    expect(jarCardChip(jar({ status: 'OnTrack' }))).toBeNull()
    expect(jarCardChip(jar({ status: 'Behind' }))).toEqual(jarStatusChip('Behind'))
    expect(jarCardChip(jar({ status: 'Unavailable', currentBalance: null }))).toBeNull()
    // The chip's tone in StatusChip's words: red for trouble, amber for a warning, green for done.
    expect(JAR_CHIP_TONE[jarStatusChip('DeadlineMissed')!.tone]).toBe('bad')
    expect(JAR_CHIP_TONE[jarStatusChip('Behind')!.tone]).toBe('warn')
    expect(JAR_CHIP_TONE[jarStatusChip('FullyFunded')!.tone]).toBe('ok')
  })
})
