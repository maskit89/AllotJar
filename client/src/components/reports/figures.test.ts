// The Reports figures behind the Trend card (restyle PR 7): which months of the year the chart and the
// table show, and the chart's round axis.
import { describe, it, expect } from 'vitest'
import type { AnnualMonthDto } from '../../types'
import { fromAmount } from '../../lib/money'
import { barPct, isBlankMonth, trendAxis, trendSpan } from './figures'

const m = (month: number, hasBudget: boolean, received = 0, spent = 0): AnnualMonthDto => ({
  month, key: `2026-${String(month).padStart(2, '0')}`, hasBudget,
  income: hasBudget ? 3000 : 0, incomeReceived: received, variance: received - (hasBudget ? 3000 : 0), planned: 0, spent,
})
const year = (fill: Record<number, AnnualMonthDto>) => Array.from({ length: 12 }, (_, i) => fill[i + 1] ?? m(i + 1, false))

describe('trendSpan', () => {
  it('starts at the first recorded month; the chart stops before a month only budgeted ahead, the table keeps it', () => {
    const months = year({ 2: m(2, true, 3000, 2000), 5: m(5, false, 0, 40), 10: m(10, true, 0, 900), 11: m(11, true) })
    // Today: October 2026. March, April, June to September are blank months inside the span.
    expect(trendSpan(months, 2026, { year: 2026, month: 10 })).toEqual({ first: 1, chartEnd: 9, tableEnd: 10 })
    expect(isBlankMonth(months[2])).toBe(true)
    expect(isBlankMonth(months[4])).toBe(false) // no budget, but a figure
  })

  it('draws a budgeted month with nothing in it yet once it has come (this month, or a past year)', () => {
    const months = year({ 9: m(9, true, 3000, 2500), 10: m(10, true) })
    expect(trendSpan(months, 2026, { year: 2026, month: 10 })).toEqual({ first: 8, chartEnd: 9, tableEnd: 9 })
    expect(trendSpan(months, 2026, { year: 2027, month: 1 })).toEqual({ first: 8, chartEnd: 9, tableEnd: 9 })
    // A year still to come: only budgets, nothing to draw; the table still lists them.
    expect(trendSpan(months.map((x) => ({ ...x, incomeReceived: 0, spent: 0 })), 2027, { year: 2026, month: 10 })).toEqual({
      first: 8,
      chartEnd: -1,
      tableEnd: 9,
    })
  })

  it('has no span for a year with nothing recorded', () => {
    expect(trendSpan(year({}), 2026, { year: 2026, month: 10 })).toBeNull()
  })
})

describe('trendAxis', () => {
  it('rounds the top up to a half step above the tallest figure, about four gridlines', () => {
    expect(trendAxis(fromAmount(3000))).toEqual({ top: fromAmount(3000), step: fromAmount(1000) })
    expect(trendAxis(fromAmount(3400))).toEqual({ top: fromAmount(3500), step: fromAmount(1000) })
    expect(trendAxis(fromAmount(4000))).toEqual({ top: fromAmount(4000), step: fromAmount(1000) })
    expect(trendAxis(fromAmount(950))).toEqual({ top: fromAmount(1000), step: fromAmount(250) })
  })

  it('keeps an axis of at least one unit when nothing was spent or received', () => {
    expect(trendAxis(0)).toEqual({ top: fromAmount(1), step: fromAmount(0.25) })
  })
})

describe('barPct', () => {
  it('gives nothing at or below zero, a 2% sliver for a tiny figure, else the share of the top', () => {
    expect(barPct(0, 100)).toBe(0)
    expect(barPct(-5, 100)).toBe(0)
    expect(barPct(1, 1000)).toBe(2)
    expect(barPct(50, 100)).toBe(50)
    expect(barPct(1, 3)).toBe(33.33)
    expect(barPct(5, 0)).toBe(0)
  })
})
