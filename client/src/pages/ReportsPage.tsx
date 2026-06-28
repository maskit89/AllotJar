import { useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Card, EmptyState, ErrorBanner } from '../components/ui'
import { Hero } from '../components/Hero'
import { ReportsIcon } from '../components/icons'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AnnualSummaryDto, BudgetMonthDto, BudgetTrendsDto } from '../types'
import { formatMoney, fromAmount, type Minor } from '../lib/money'
import { hueColor, hueForIndex, hueTint } from '../lib/categoryColors'

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const monthLabel = (year: number, month: number) => `${SHORT_MONTHS[month - 1]} ${year}`

interface CategorySpend {
  id: string
  name: string
  kind: string
  spentMinor: Minor
  /** Position among the month's non-income groups, so the hue matches the Budget screen. */
  hueIndex: number
}

export function ReportsPage() {
  const [trends, setTrends] = useState<BudgetTrendsDto | null>(null)
  const [breakdownMonth, setBreakdownMonth] = useState<BudgetMonthDto | null>(null)
  const [breakdownKey, setBreakdownKey] = useState<string | null>(null)
  const [annual, setAnnual] = useState<AnnualSummaryDto | null>(null)
  const [annualYear, setAnnualYear] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<BudgetTrendsDto>('/reports/trends?months=6')
      .then(({ data }) => {
        if (cancelled) return
        setTrends(data)
        const last = data.points.at(-1)
        // Default the annual view to the year of the most recent budget, and the
        // category breakdown to the most recent month.
        setAnnualYear((y) => y ?? last?.year ?? new Date().getFullYear())
        setBreakdownKey((k) => k ?? last?.key ?? null)
      })
      .catch(() => !cancelled && setError('Could not load your reports.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  // Load the chosen month's full budget for the category breakdown.
  useEffect(() => {
    if (!breakdownKey) return
    const [year, month] = breakdownKey.split('-').map(Number)
    let cancelled = false
    api
      .get<BudgetMonthDto>(`/budget/${year}/${month}`)
      .then(({ data }) => !cancelled && setBreakdownMonth(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [breakdownKey])

  // Load the annual overview whenever the chosen year changes.
  useEffect(() => {
    if (annualYear === null) return
    let cancelled = false
    api
      .get<AnnualSummaryDto>(`/reports/annual/${annualYear}`)
      .then(({ data }) => !cancelled && setAnnual(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [annualYear])

  const currency = breakdownMonth?.baseCurrency ?? 'EUR'

  // Scale the income-vs-spending bars to the largest value in the window.
  const trendMaxMinor = useMemo(() => {
    if (!trends) return 0
    return trends.points.reduce(
      (max, p) => Math.max(max, fromAmount(p.income), fromAmount(p.incomeReceived), fromAmount(p.spent)),
      0,
    )
  }, [trends])

  // Spending by category for the chosen month (non-income groups, biggest first).
  const categorySpend = useMemo<CategorySpend[]>(() => {
    if (!breakdownMonth) return []
    return breakdownMonth.categories
      .filter((c) => c.kind !== 'Income')
      .map((c, i) => ({ id: c.id, name: c.name, kind: c.kind, spentMinor: fromAmount(c.totalActual), hueIndex: i }))
      .filter((c) => c.spentMinor > 0)
      .sort((a, b) => b.spentMinor - a.spentMinor)
  }, [breakdownMonth])

  const categoryTotalMinor = categorySpend.reduce((s, c) => s + c.spentMinor, 0)
  const categoryMaxMinor = categorySpend.reduce((m, c) => Math.max(m, c.spentMinor), 0)

  // Scale the per-category yearly-average bars to the biggest average.
  const annualAvgMaxMinor = useMemo(
    () => (annual?.categories ?? []).reduce((m, c) => Math.max(m, fromAmount(c.averagePerMonth)), 0),
    [annual],
  )

  const hasData = trends !== null && trends.points.length > 0
  const totalSpentMinor = trends ? fromAmount(trends.totalSpent) : 0

  // Hero figures — the most recent month's saving, the window's average spend,
  // and this month's savings rate (saved ÷ received).
  const latest = trends?.points.at(-1)
  const savedThisMonthMinor = latest ? fromAmount(latest.incomeReceived) - fromAmount(latest.spent) : 0
  const avgSpendMinor = trends && trends.points.length > 0 ? Math.round(totalSpentMinor / trends.points.length) : 0
  const latestReceivedMinor = latest ? fromAmount(latest.incomeReceived) : 0
  const savingsRate = latestReceivedMinor > 0 ? Math.round((savedThisMonthMinor / latestReceivedMinor) * 100) : 0

  return (
    <AppShell active="reports" title="Reports">
        {loading && <p className="text-slate-500">Loading your reports…</p>}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {!loading && !error && !hasData && (
          <EmptyState
            icon={<ReportsIcon className="h-6 w-6" />}
            title="No budget data yet"
            description="Once you’ve built a budget or two, your trends will appear here."
          />
        )}

        {!loading && hasData && trends && (
          <>
            <Hero
              eyebrow="Saved this month"
              amount={formatMoney(savedThisMonthMinor, currency)}
              amountLabel={`Saved this month: ${formatMoney(savedThisMonthMinor, currency)}`}
              tiles={[
                { label: 'Avg monthly spend', value: formatMoney(avgSpendMinor, currency) },
                { label: 'Savings rate', value: `${savingsRate}%` },
              ]}
            />

            {/* Income vs spending — a column per month (income solid, spent ghost). */}
            <Card as="section" className="px-6 py-[22px]">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Income vs spending</h3>
                <div className="flex gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--color-brand-600)' }} /> Income
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-sm border"
                      style={{ background: 'var(--color-brand-50)', borderColor: 'var(--color-brand-600)' }}
                    />{' '}
                    Spent
                  </span>
                </div>
              </div>
              <div className="flex items-end gap-3">
                {trends.points.map((p, idx) => {
                  const receivedMinor = fromAmount(p.incomeReceived)
                  const spentMinor = fromAmount(p.spent)
                  const isCurrent = idx === trends.points.length - 1
                  return (
                    <div
                      key={p.key}
                      aria-label={`Trend for ${monthLabel(p.year, p.month)}`}
                      className="flex flex-1 flex-col items-center gap-2"
                    >
                      <div className="flex h-[190px] w-full items-end justify-center gap-1.5">
                        <div
                          className="w-[34%] rounded-t"
                          style={{ height: `${pct(receivedMinor, trendMaxMinor)}%`, background: 'var(--color-brand-600)' }}
                          title={`Income ${formatMoney(receivedMinor, currency)}`}
                        />
                        <div
                          className="w-[34%] rounded-t border"
                          style={{
                            height: `${pct(spentMinor, trendMaxMinor)}%`,
                            background: 'var(--color-brand-50)',
                            borderColor: 'var(--color-brand-600)',
                          }}
                          title={`Spent ${formatMoney(spentMinor, currency)}`}
                        />
                      </div>
                      <span
                        className={`text-xs font-medium ${isCurrent ? 'text-brand-700 dark:text-brand-200' : 'text-slate-500'}`}
                      >
                        {SHORT_MONTHS[p.month - 1]}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Whole-year overview, with its own year navigator. */}
            {annual?.months && annual.months.length > 0 && (
              <Card as="section" className="px-6 py-[22px]">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Annual overview</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        track(EVENTS.reportViewed, { report_type: 'annual' })
                        setAnnualYear((y) => (y ?? new Date().getFullYear()) - 1)
                      }}
                      aria-label="Previous year"
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
                    >
                      ◀
                    </button>
                    <span className="min-w-12 text-center text-sm font-semibold tabular-nums text-slate-800">
                      {annual.year}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        track(EVENTS.reportViewed, { report_type: 'annual' })
                        setAnnualYear((y) => (y ?? new Date().getFullYear()) + 1)
                      }}
                      aria-label="Next year"
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
                    >
                      ▶
                    </button>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-1.5 font-medium">Month</th>
                      <th className="py-1.5 text-right font-medium">Income</th>
                      <th className="py-1.5 text-right font-medium">Spent</th>
                      <th className="py-1.5 text-right font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {annual.months.map((m) => {
                      const incomeMinor = fromAmount(m.income)
                      const spentMinor = fromAmount(m.spent)
                      const net = incomeMinor - spentMinor
                      return (
                        <tr key={m.month} className={m.hasBudget ? '' : 'text-slate-500'}>
                          <td className="py-1.5">{SHORT_MONTHS[m.month - 1]}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            {m.hasBudget ? formatMoney(incomeMinor, currency) : '—'}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {m.hasBudget ? formatMoney(spentMinor, currency) : '—'}
                          </td>
                          <td
                            className={`py-1.5 text-right font-medium tabular-nums ${
                              !m.hasBudget ? '' : net < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
                            }`}
                          >
                            {m.hasBudget ? formatMoney(net, currency) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-semibold text-slate-800">
                      <td className="py-2">Total</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(fromAmount(annual.totalIncome), currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(fromAmount(annual.totalSpent), currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(fromAmount(annual.totalIncome) - fromAmount(annual.totalSpent), currency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </Card>
            )}

            {/* Average monthly spend per category across the year (the workbook's AVERAGE column). */}
            {annual?.categories && annual.categories.length > 0 && (
              <Card as="section" className="px-6 py-[22px]">
                <h3 className="mb-1 text-[15px] font-bold tracking-[-0.01em] text-slate-900">
                  Average monthly spending by category
                </h3>
                <p className="mb-4 text-xs text-slate-500">
                  Each category’s spend averaged over the {annual.budgetedMonths}{' '}
                  {annual.budgetedMonths === 1 ? 'budgeted month' : 'budgeted months'} of {annual.year}.
                </p>
                <div className="space-y-3">
                  {annual.categories.map((c) => {
                    const avgMinor = fromAmount(c.averagePerMonth)
                    return (
                      <div key={`${c.kind}-${c.name}`} aria-label={`Average spending for ${c.name}`}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-600">
                            {c.name}
                            {c.kind === 'Savings' && (
                              <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-700">
                                Fund
                              </span>
                            )}
                          </span>
                          <span className="tabular-nums text-slate-500">
                            {formatMoney(avgMinor, currency)}/mo · {formatMoney(fromAmount(c.total), currency)} total
                          </span>
                        </div>
                        <Bar
                          widthPct={pct(avgMinor, annualAvgMaxMinor)}
                          className="bg-sky-500"
                          label={`Average for ${c.name}`}
                        />
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}

            {/* Spending by category for the chosen month. */}
            <Card as="section" className="px-6 py-[22px]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Spending by category</h3>
                <select
                  aria-label="Breakdown month"
                  value={breakdownKey ?? ''}
                  onChange={(e) => {
                    track(EVENTS.reportViewed, { report_type: 'breakdown' })
                    setBreakdownKey(e.target.value)
                  }}
                  className="rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  {[...trends.points].reverse().map((p) => (
                    <option key={p.key} value={p.key}>
                      {monthLabel(p.year, p.month)}
                    </option>
                  ))}
                </select>
              </div>
              {categorySpend.length === 0 ? (
                <p className="text-sm text-slate-500">No spending recorded for this month yet.</p>
              ) : (
                <div className="space-y-3">
                  {categorySpend.map((c) => {
                    const hue = hueForIndex(c.hueIndex)
                    return (
                      <div key={c.id} aria-label={`Spending for ${c.name}`}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-600">
                            {c.name}
                            {c.kind === 'Savings' && (
                              <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-700">
                                Fund
                              </span>
                            )}
                          </span>
                          <span className="tabular-nums text-slate-500">
                            {formatMoney(c.spentMinor, currency)} ·{' '}
                            {categoryTotalMinor === 0
                              ? '0%'
                              : `${Math.round((c.spentMinor / categoryTotalMinor) * 100)}%`}
                          </span>
                        </div>
                        <Bar
                          widthPct={pct(c.spentMinor, categoryMaxMinor)}
                          color={hueColor(hue)}
                          track={hueTint(hue)}
                          label={c.name}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </>
        )}
    </AppShell>
  )
}

function pct(value: Minor, max: Minor): number {
  if (max <= 0 || value <= 0) return 0
  return Math.max(2, Math.round((value / max) * 100)) // a visible sliver for tiny non-zero values
}

/**
 * A horizontal bar. `className` colours the fill via a utility; pass `color` to
 * fill with an inline colour (a category hue) and `track` to tint the track.
 */
function Bar({
  widthPct,
  className = '',
  label,
  color,
  track,
}: {
  widthPct: number
  className?: string
  label: string
  color?: string
  track?: string
}) {
  return (
    <div
      className={`h-3 w-full overflow-hidden rounded-full ${track ? '' : 'bg-slate-100'}`}
      style={track ? { background: track } : undefined}
      role="img"
      aria-label={label}
    >
      <div
        className={`h-full rounded-full ${color ? '' : className}`}
        style={{ width: `${widthPct}%`, ...(color ? { background: color } : null) }}
      />
    </div>
  )
}
