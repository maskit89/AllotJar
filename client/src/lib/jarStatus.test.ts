import { describe, it, expect } from 'vitest'
import { jarHorizonLabel, jarMonthLabel, jarStatusChip } from './jarStatus'
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
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, targetDate: null, deadline: null, status: 'Unscheduled' }), 'EUR')).toBe(
      'Add a deadline or a monthly amount to plan contributions',
    )
    expect(jarMonthLabel(jar({ plannedThisMonth: 0, status: 'OnTrack' }), 'EUR')).toBe('Nothing to set aside this month')
  })
})

describe('jarHorizonLabel', () => {
  it('names the funding-completion month and the deadline it serves, and that a recurring jar repeats (rule 36)', () => {
    expect(jarHorizonLabel(jar())).toMatch(/^Funded by Nov 2026 · due .*Dec.*2026, then it repeats$/)
    expect(jarHorizonLabel(jar({ kind: 1, recurMonths: null }))).toMatch(/^Funded by Nov 2026 · due .*Dec.*2026$/)
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

  it('falls back to the deadline alone once funding is complete but the date is still ahead', () => {
    expect(jarHorizonLabel(jar({ status: 'FullyFunded', fundingCompletesOn: null }))).toMatch(/^Due .*Dec.*2026$/)
  })
})
