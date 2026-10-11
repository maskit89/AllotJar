import type { AnnualMonthDto } from '../../types'
import { fromAmount, type Minor } from '../../lib/money'

/*
 * The Reports page's figures that are not drawn (restyle PR 7): month names and labels, the colour
 * of a signed figure, the Trend card's month span and axis, and the key an average is found by.
 */

export const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "Jun 2026", the label the Breakdown month options have always had. */
export const monthLabel = (year: number, month: number) => `${SHORT_MONTHS[month - 1]} ${year}`

/** "Apr–Jun 2026", "Jun 2026" or "Nov 2025–Apr 2026": the months a figure covers. */
export function rangeLabel(first: { year: number; month: number }, last: { year: number; month: number }): string {
  if (first.year === last.year && first.month === last.month) return monthLabel(last.year, last.month)
  if (first.year === last.year) return `${SHORT_MONTHS[first.month - 1]}–${monthLabel(last.year, last.month)}`
  return `${monthLabel(first.year, first.month)}–${monthLabel(last.year, last.month)}`
}

/** Money in (or a net) at or above zero in the ok green, below zero in the bad red. */
export function netTone(minor: Minor): string {
  return minor < 0 ? 'text-bad' : 'text-ok'
}

/** Rule 41: a variance is not an error, so zero stays plain; above zero ok green, below bad red. */
export function signTone(minor: Minor): string {
  return minor < 0 ? 'text-bad' : minor > 0 ? 'text-ok' : ''
}

/** A month with no budget and nothing recorded: no figure to draw, a dash across its row. */
export const isBlankMonth = (m: AnnualMonthDto) => !m.hasBudget && m.incomeReceived === 0 && m.spent === 0

/**
 * The months the chart and the table show (indexes into the year's twelve). Months before the
 * year's first one with a budget or a figure are left out; the chart runs to the last month with a
 * figure (or a budget, up to this month), so a month budgeted ahead with nothing in it yet is left
 * out of the chart, and the table runs on to the last budgeted month, so its Budgeted figure stays.
 */
export function trendSpan(months: AnnualMonthDto[], year: number, now: { year: number; month: number }) {
  const nowKey = now.year * 12 + now.month
  const first = months.findIndex((m) => !isBlankMonth(m))
  if (first < 0) return null
  let chartEnd = -1
  let tableEnd = -1
  months.forEach((m, i) => {
    if (isBlankMonth(m)) return
    tableEnd = i
    const hasFigure = m.incomeReceived !== 0 || m.spent !== 0
    if (hasFigure || year * 12 + m.month <= nowKey) chartEnd = i
  })
  return { first, chartEnd, tableEnd }
}

/** The chart's axis: a round step (about four gridlines) and a top just above the tallest figure. */
export function trendAxis(maxMinor: Minor): { top: Minor; step: Minor } {
  const max = Math.max(maxMinor, fromAmount(1))
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag
  const half = step / 2
  return { top: Math.ceil(max / half) * half, step }
}

/** A figure's height on the axis, in %: none at or below zero, a visible 2% sliver for a tiny one. */
export function barPct(value: Minor, top: Minor): number {
  if (value <= 0 || top <= 0) return 0
  return Math.round(Math.max(2, (value / top) * 100) * 100) / 100
}

/** The key an average is found by: a group's name and kind, as the year's report keys them. */
export const averageKey = (kind: string, name: string) => `${kind}\u0000${name}`
