import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Card, EmptyState, ErrorBanner } from '../components/ui'
import { Hero } from '../components/Hero'
import { ReportsIcon } from '../components/icons'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AnnualMonthDto, AnnualSummaryDto, BudgetTrendsDto, JarSpendingReportDto, JarSpendingRowDto, MonthReportDto } from '../types'
import { formatMoney, fromAmount, type Minor } from '../lib/money'
import { hueColor, hueForIndex, hueTint } from '../lib/categoryColors'
import { currentMonth, todayIso } from '../lib/dates'
import { useAuth } from '../auth/AuthContext'

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const monthLabel = (year: number, month: number) => `${SHORT_MONTHS[month - 1]} ${year}`

/** Rule 41: the Variance is signed — a plus for more than planned, the formatter's minus for less. */
function signedMoney(minor: Minor, currency: string): string {
  return minor > 0 ? `+${formatMoney(minor, currency)}` : formatMoney(minor, currency)
}

/** Emerald above zero, rose below, plain at zero — a variance is not an error (rule 41). */
function signClass(minor: Minor): string {
  return minor < 0 ? 'text-rose-600 dark:text-rose-400' : minor > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''
}

/** Net: rose when more went out than came in, emerald otherwise (a zero month lost nothing). */
function netClass(minor: Minor): string {
  return minor < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
}

interface CategorySpend {
  id: string
  name: string
  kind: string
  /** Net of the refunds received against the group this month (rules 38/39). */
  netMinor: Minor
  refundsMinor: Minor
  /** Position among the month's non-income groups, so the hue matches the Budget screen. */
  hueIndex: number
  /** Rule 37: spending no line carries yet, flagged for review. */
  isUncategorised: boolean
  count: number
}

export function ReportsPage() {
  const [trends, setTrends] = useState<BudgetTrendsDto | null>(null)
  const [breakdown, setBreakdown] = useState<MonthReportDto | null>(null)
  const [breakdownKey, setBreakdownKey] = useState<string | null>(null)
  const [annual, setAnnual] = useState<AnnualSummaryDto | null>(null)
  const [annualYear, setAnnualYear] = useState<number | null>(null)
  const [jarSpending, setJarSpending] = useState<JarSpendingReportDto | null>(null)
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
        setAnnualYear((y) => y ?? last?.year ?? currentMonth().year)
        setBreakdownKey((k) => k ?? last?.key ?? null)
      })
      .catch(() => !cancelled && setError('Could not load your reports.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  // Load the chosen month's report for the category breakdown: the budget's groups net of
  // refunds, plus whatever no line carries yet (rules 37–39).
  useEffect(() => {
    if (!breakdownKey) return
    const [year, month] = breakdownKey.split('-').map(Number)
    let cancelled = false
    api
      .get<MonthReportDto>(`/reports/month/${year}/${month}`)
      .then(({ data }) => !cancelled && setBreakdown(data))
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

  // Load what was spent from each jar in the same year as the annual overview (the one year
  // navigator drives both). An older server has no such report; the card is then left out.
  useEffect(() => {
    if (annualYear === null) return
    let cancelled = false
    api
      .get<JarSpendingReportDto>(`/reports/jars/${annualYear}`)
      .then(({ data }) => !cancelled && setJarSpending(data && Array.isArray(data.jars) ? data : null))
      .catch(() => !cancelled && setJarSpending(null))
    return () => {
      cancelled = true
    }
  }, [annualYear])

  const { budgetCurrency } = useAuth()
  const currency = breakdown?.baseCurrency ?? budgetCurrency

  // Scale the income-vs-spending bars to the largest value in the window.
  const trendMaxMinor = useMemo(() => {
    if (!trends) return 0
    return trends.points.reduce(
      (max, p) => Math.max(max, fromAmount(p.income), fromAmount(p.incomeReceived), fromAmount(p.spent)),
      0,
    )
  }, [trends])

  // Spending by group for the chosen month, biggest net first. A group that only saw refunds
  // this month (net ≤ 0) stays on the list, labelled, so a negative figure is explicable
  // (rule 39); a group with nothing at all is left out.
  const categorySpend = useMemo<CategorySpend[]>(() => {
    if (!breakdown) return []
    return breakdown.categories
      .map((c) => ({
        id: c.id ?? 'uncategorised',
        name: c.name,
        kind: c.kind,
        netMinor: fromAmount(c.net),
        refundsMinor: fromAmount(c.refunds),
        hueIndex: c.index,
        isUncategorised: c.isUncategorised,
        count: c.count,
      }))
      .filter((c) => c.netMinor !== 0 || c.refundsMinor !== 0)
      .sort((a, b) => b.netMinor - a.netMinor)
  }, [breakdown])

  // Shares are of the positive spending only; a group that netted below zero has no share.
  const categoryTotalMinor = categorySpend.reduce((s, c) => s + Math.max(0, c.netMinor), 0)
  const categoryMaxMinor = categorySpend.reduce((m, c) => Math.max(m, c.netMinor), 0)

  // Scale the per-category yearly-average bars to the biggest average.
  const annualAvgMaxMinor = useMemo(
    () => (annual?.categories ?? []).reduce((m, c) => Math.max(m, fromAmount(c.averagePerMonth)), 0),
    [annual],
  )

  const hasData = trends !== null && trends.points.length > 0
  const totalSpentMinor = trends ? fromAmount(trends.totalSpent) : 0

  // Hero figures — the most recent month's saving, the window's average spend,
  // and this month's savings rate (saved ÷ received).
  // The latest month up to this one: a budget already created for next month has nothing in it yet.
  const thisMonthKey = todayIso().slice(0, 7)
  const latest = trends?.points.filter((p) => p.key <= thisMonthKey).at(-1)
  const savedThisMonthMinor = latest ? fromAmount(latest.incomeReceived) - fromAmount(latest.spent) : 0
  const avgSpendMinor = trends && trends.points.length > 0 ? Math.round(totalSpentMinor / trends.points.length) : 0
  // Rows in another currency still waiting for their amount in the budget currency count in no
  // figure here; say how many, or a total silently leaves them out.
  const waitingInWindow = trends?.points.reduce((n, p) => n + (p.fxPendingCount ?? 0), 0) ?? 0
  const latestReceivedMinor = latest ? fromAmount(latest.incomeReceived) : 0
  const savingsRate = latestReceivedMinor > 0 ? Math.round((savedThisMonthMinor / latestReceivedMinor) * 100) : 0

  /** A month with no budget and nothing recorded reads as a dash across the row. */
  const annualRowIsBlank = (m: AnnualMonthDto) => !m.hasBudget && m.incomeReceived === 0 && m.spent === 0
  // The calendar months the server averaged over (D12); an older server sent only the budgeted ones.
  const averagedMonths = annual?.countedMonths ?? annual?.budgetedMonths ?? 0

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
            {waitingInWindow > 0 && (
              <WaitingRowsNote count={waitingInWindow} currency={currency} what="in these months" />
            )}

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

            {/* Whole-year overview, with its own year navigator. Budgeted income sits next to what
                was received and their signed Variance (rule 41); Net is received − spent. */}
            {annual?.months && annual.months.length > 0 && (
              <Card as="section" className="px-6 py-[22px]">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Annual overview</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        track(EVENTS.reportViewed, { report_type: 'annual' })
                        setAnnualYear((y) => (y ?? currentMonth().year) - 1)
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
                        setAnnualYear((y) => (y ?? currentMonth().year) + 1)
                      }}
                      aria-label="Next year"
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
                    >
                      ▶
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-1.5 font-medium">Month</th>
                      <th className="py-1.5 text-right font-medium">Budgeted</th>
                      <th className="py-1.5 text-right font-medium">Received</th>
                      <th className="py-1.5 text-right font-medium">Variance</th>
                      <th className="py-1.5 text-right font-medium">Spent</th>
                      <th className="py-1.5 text-right font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {annual.months.map((m) => {
                      const blank = annualRowIsBlank(m)
                      const budgetedMinor = fromAmount(m.income)
                      const receivedMinor = fromAmount(m.incomeReceived)
                      const varianceMinor = fromAmount(m.variance)
                      const spentMinor = fromAmount(m.spent)
                      const net = receivedMinor - spentMinor
                      return (
                        <tr key={m.month} className={m.hasBudget ? '' : 'text-slate-500'}>
                          <td className="py-1.5">{SHORT_MONTHS[m.month - 1]}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            {m.hasBudget ? formatMoney(budgetedMinor, currency) : '—'}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {blank ? '—' : formatMoney(receivedMinor, currency)}
                          </td>
                          {/* Rule 41: actual minus projected, which is nothing without a budget; the total adds every row. */}
                          <td className={`py-1.5 text-right tabular-nums ${blank ? '' : signClass(varianceMinor)}`}>
                            {blank ? '—' : signedMoney(varianceMinor, currency)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {blank ? '—' : formatMoney(spentMinor, currency)}
                          </td>
                          <td className={`py-1.5 text-right font-medium tabular-nums ${blank ? '' : netClass(net)}`}>
                            {blank ? '—' : formatMoney(net, currency)}
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
                        {formatMoney(fromAmount(annual.totalIncomeReceived), currency)}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${signClass(fromAmount(annual.totalVariance))}`}>
                        {signedMoney(fromAmount(annual.totalVariance), currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(fromAmount(annual.totalSpent), currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(fromAmount(annual.totalIncomeReceived) - fromAmount(annual.totalSpent), currency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                </div>
              </Card>
            )}

            {/* What each jar paid out, month by month, in the annual overview's year: a payment
                draws from the jar its line names (rule 79), a move between jars is not spending. */}
            {jarSpending && jarSpending.year === annualYear && jarSpending.jars.length > 0 && (
              <JarSpendingCard report={jarSpending} fallbackCurrency={currency} />
            )}

            {/* Average monthly spend per category across the year (the workbook's AVERAGE column). */}
            {annual?.categories && annual.categories.length > 0 && (
              <Card as="section" className="px-6 py-[22px]">
                <h3 className="mb-1 text-[15px] font-bold tracking-[-0.01em] text-slate-900">
                  Average monthly spending by category
                </h3>
                <p className="mb-4 text-xs text-slate-500">
                  Each category’s spend averaged over {averagedMonths} {averagedMonths === 1 ? 'month' : 'months'} of{' '}
                  {annual.year}, counting a month with no budget as a month too.
                </p>
                <div className="space-y-3">
                  {annual.categories.map((c) => {
                    const avgMinor = fromAmount(c.averagePerMonth)
                    const refundsMinor = fromAmount(c.refunds ?? 0)
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
                            {c.kind === 'Uncategorised' && (
                              <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
                                Review
                              </span>
                            )}
                          </span>
                          <span className="tabular-nums text-slate-500">
                            {formatMoney(avgMinor, currency)}/mo · {formatMoney(fromAmount(c.total), currency)} total
                            {refundsMinor > 0 && ` · after ${formatMoney(refundsMinor, currency)} refunded`}
                          </span>
                        </div>
                        <Bar
                          widthPct={pct(avgMinor, annualAvgMaxMinor)}
                          className={c.kind === 'Uncategorised' ? 'bg-amber-400' : 'bg-sky-500'}
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
              {breakdown && breakdown.fxPendingCount > 0 && (
                <WaitingRowsNote count={breakdown.fxPendingCount} currency={currency} what="this month" />
              )}
              {categorySpend.length === 0 ? (
                <p className="text-sm text-slate-500">No spending recorded for this month yet.</p>
              ) : (
                <div className="space-y-3">
                  {categorySpend.map((c) => {
                    const hue = c.isUncategorised ? null : hueForIndex(c.hueIndex)
                    const share =
                      c.netMinor > 0 && categoryTotalMinor > 0
                        ? `${Math.round((c.netMinor / categoryTotalMinor) * 100)}%`
                        : c.netMinor > 0
                          ? '0%'
                          : null
                    return (
                      <div key={c.id} aria-label={`Spending for ${c.name}`}>
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-slate-600">
                            {c.name}
                            {c.kind === 'Savings' && (
                              <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-700">
                                Fund
                              </span>
                            )}
                            {c.isUncategorised && (
                              // Rule 37: flagged for review, with the way to fix it.
                              <Link
                                to="/transactions"
                                aria-label="Review uncategorised transactions"
                                className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300"
                              >
                                Review {c.count} {c.count === 1 ? 'transaction' : 'transactions'}
                              </Link>
                            )}
                          </span>
                          <span className="text-right tabular-nums text-slate-500">
                            {formatMoney(c.netMinor, currency)}
                            {share !== null && ` · ${share}`}
                            {/* Rules 38/39: say what was refunded, so a small or negative figure is explicable. */}
                            {c.refundsMinor > 0 && ` · after ${formatMoney(c.refundsMinor, currency)} refunded`}
                          </span>
                        </div>
                        <Bar
                          widthPct={pct(c.netMinor, categoryMaxMinor)}
                          color={hue === null ? 'var(--color-amber-400, #fbbf24)' : hueColor(hue)}
                          track={hue === null ? 'var(--color-amber-100, #fef3c7)' : hueTint(hue)}
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

/**
 * Spending from jars, one row per jar and a column per month (5 October 2026, from the jar
 * notes: "how much I am actually spending from each jar monthly/yearly"). A payment counts
 * wholly against the jar it was paid from: 50 for the vet from the Pets jar reads as 50 under
 * Pets, and the 30 moved in from Food to cover it is not spending from Food. A refund back into
 * the jar reduces the month it was received, and the total says so (rules 38/39). A live jar
 * with nothing spent shows dashes; an archived jar is listed only while the year has a figure.
 */
function JarSpendingCard({ report, fallbackCurrency }: { report: JarSpendingReportDto; fallbackCurrency: string }) {
  const currencyOf = (row: JarSpendingRowDto) => row.currency || fallbackCurrency
  const currencies = new Set(report.jars.map(currencyOf))
  // A year total across jars only reads when every jar counts in one currency.
  const totalCurrency = currencies.size === 1 ? [...currencies][0] : null
  const grandMonths = Array.from({ length: 12 }, (_, i) => report.jars.reduce((s, j) => s + fromAmount(j.months[i] ?? 0), 0))
  const grandTotal = report.jars.reduce((s, j) => s + fromAmount(j.total), 0)
  const cell = (minor: Minor, currency: string) => (minor === 0 ? '—' : formatMoney(minor, currency))
  return (
    <Card as="section" className="px-6 py-[22px]">
      <h3 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Spending from jars</h3>
      <p className="mb-4 mt-1 text-xs text-slate-500">
        What each jar paid out in {report.year}, by the month it was paid. Money moved between jars is not spending.
      </p>
      {report.waitingCount > 0 && <WaitingRowsNote count={report.waitingCount} currency={fallbackCurrency} what="paid from a jar" />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm" aria-label={`Spending from jars in ${report.year}`}>
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="py-1.5 font-medium">Jar</th>
              {SHORT_MONTHS.map((m) => (
                <th key={m} scope="col" className="py-1.5 text-right font-medium">
                  {m}
                </th>
              ))}
              <th scope="col" className="py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {report.jars.map((row) => {
              const rowCurrency = currencyOf(row)
              const totalMinor = fromAmount(row.total)
              const refundsMinor = fromAmount(row.totalRefunds)
              return (
                <tr key={row.jarId} className={row.isArchived ? 'text-slate-500' : ''}>
                  <th scope="row" className="py-1.5 text-left font-normal">
                    {row.name}
                    {row.isArchived && <span className="ml-1 text-xs text-slate-400">(archived)</span>}
                  </th>
                  {Array.from({ length: 12 }, (_, i) => (
                    <td key={i} className="py-1.5 text-right tabular-nums">
                      {cell(fromAmount(row.months[i] ?? 0), rowCurrency)}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-medium tabular-nums" title={refundsMinor > 0 ? `after ${formatMoney(refundsMinor, rowCurrency)} refunded` : undefined}>
                    {cell(totalMinor, rowCurrency)}
                    {refundsMinor > 0 && <span className="sr-only"> after {formatMoney(refundsMinor, rowCurrency)} refunded</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {totalCurrency !== null && report.jars.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-semibold text-slate-800">
                <th scope="row" className="py-2 text-left">All jars</th>
                {grandMonths.map((minor, i) => (
                  <td key={i} className="py-2 text-right tabular-nums">
                    {cell(minor, totalCurrency)}
                  </td>
                ))}
                <td className="py-2 text-right tabular-nums">{cell(grandTotal, totalCurrency)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  )
}

/**
 * The rows a report leaves out: transactions in another currency whose amount in the budget
 * currency hasn't been entered yet (the app never converts on its own). Every figure above it
 * is complete except for these, so the count says how many, and where to enter them.
 */
function WaitingRowsNote({ count, currency, what }: { count: number; currency: string; what: string }) {
  return (
    <p role="status" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
      {count} {count === 1 ? 'transaction' : 'transactions'} {what} {count === 1 ? 'is' : 'are'} in another currency,
      waiting for {count === 1 ? 'its' : 'their'} amount in {currency}, and not counted in these figures.{' '}
      <Link to="/transactions" className="font-semibold underline">
        Enter {count === 1 ? 'it' : 'them'} on Transactions
      </Link>
      .
    </p>
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
