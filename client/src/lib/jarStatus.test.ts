import { describe, it, expect } from 'vitest'
import { jarStatusChip, jarPaceLabel } from './jarStatus'
import type { JarDto } from '../types'

function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'j1',
    name: 'Insurance',
    kind: 0,
    targetAmount: 600,
    targetDate: '2026-12-01',
    coverStart: null,
    coverEnd: null,
    accrual: 1,
    recurMonths: 12,
    openingBalance: 0,
    openingAsOf: null,
    fundingAccountId: null,
    isArchived: false,
    currentBalance: 200,
    requiredMonthlyContribution: 80,
    projectedFullyFundedDate: '2026-11-01',
    status: 'OnTrack',
    ...over,
  }
}

describe('jarStatusChip', () => {
  it('chips only the attention and celebration states', () => {
    expect(jarStatusChip('Behind')).toEqual({ label: 'Behind', tone: 'amber' })
    expect(jarStatusChip('Overspent')).toEqual({ label: 'Overspent', tone: 'rose' })
    expect(jarStatusChip('FullyFunded')).toEqual({ label: 'Funded', tone: 'teal' })
  })

  it('stays quiet for OnTrack and Unfunded', () => {
    expect(jarStatusChip('OnTrack')).toBeNull()
    expect(jarStatusChip('Unfunded')).toBeNull()
  })
})

describe('jarPaceLabel', () => {
  it('shows the monthly set-aside with a projected finish', () => {
    expect(jarPaceLabel(jar(), 'EUR')).toMatch(/\/mo · full by .*2026/)
  })

  it('shows the monthly set-aside alone when there is no projection', () => {
    const label = jarPaceLabel(jar({ projectedFullyFundedDate: null }), 'EUR')
    expect(label).toMatch(/\/mo$/)
    expect(label).not.toContain('full by')
  })

  it('explains a zero-monthly jar instead of a bare dash', () => {
    expect(jarPaceLabel(jar({ requiredMonthlyContribution: 0, status: 'FullyFunded' }), 'EUR')).toBe('Fully funded')
    expect(jarPaceLabel(jar({ requiredMonthlyContribution: 0, status: 'Unfunded', targetAmount: 0 }), 'EUR')).toBe(
      'No target yet',
    )
  })

  it('falls back to a dash for a zero-monthly jar with no clearer reason', () => {
    // e.g. an imported ProportionalPool jar: pooled, so no per-jar monthly figure.
    expect(jarPaceLabel(jar({ requiredMonthlyContribution: 0, status: 'OnTrack' }), 'EUR')).toBe('—')
  })
})
