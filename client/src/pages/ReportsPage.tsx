import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, TrendingUp } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { EmptyState, ErrorBanner } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { ReportsIcon } from '../components/icons'
import { DASH_CARD } from '../components/budget/card'
import { TrendCard } from '../components/reports/TrendCard'
import { SpendingCard, type CategorySpend } from '../components/reports/SpendingCard'
import { JarSpendingCard } from '../components/reports/JarSpendingCard'
import { LONG_MONTHS, averageKey, isBlankMonth, monthLabel, rangeLabel } from '../components/reports/figures'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AnnualSummaryDto, BudgetTrendsDto, JarSpendingReportDto, MonthReportDto } from '../types'
import { formatMoney, fromAmount, type Minor } from '../lib/money'
import { currentMonth, todayIso } from '../lib/dates'
import { useAuth } from '../auth/AuthContext'

/**
 * The KPI row's two plain tiles share two rows of the row's grid (a subgrid): the labels' and the
 * numbers'. Where the row leaves "Avg monthly spend" two lines and "Savings rate" one (a phone; a
 * row of three until about 880px), both numbers still stand level. The hero spans both rows
 * beside them (from 640px; above them on a narrower row). Nothing changes on other pages.
 */
const PLAIN_TILE = 'row-span-2 grid! grid-cols-[minmax(0,1fr)] grid-rows-subgrid [&>p]:self-start'
const HERO_TILE = '@min-[640px]:row-span-2'

/*
 * Reports (restyle PR 7, the approved "polished Warm" mock-up): one KPI row (what the latest month
 * saved, the window's average spend, the latest month's savings rate), then the year over time on
 * the left (Trend: spent against income received, as a chart or a table, with the year's averages
 * per category; Jar spending under it) and the chosen month's spending by group on the right, in
 * view while the page scrolls. A phone reads Trend, Spending, then Jar spending.
 */
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
        // Default the year to that of the latest month up to this one (a budget made ahead for
        // next January has nothing in it yet: December keeps its own year's chart), and the
        // category breakdown to the most recent month.
        const thisMonth = todayIso().slice(0, 7)
        const anchor = data.points.filter((p) => p.key <= thisMonth).at(-1) ?? last
        setAnnualYear((y) => y ?? anchor?.year ?? currentMonth().year)
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

  // Load the year (the Trend card) whenever the chosen year changes. A failure keeps the last year
  // that loaded on screen, and its year in the switcher.
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

  // Load what was spent from each jar in the same year (the one year switcher drives both). An
  // older server has no such report; the card is then left out.
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
  // The breakdown month's currency formats every figure on the page.
  const currency = breakdown?.baseCurrency ?? budgetCurrency
  const money = (minor: Minor) => formatMoney(minor, currency)

  // Spending by group for the chosen month, biggest net first, then Uncategorised. A group that only saw refunds
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
      // Uncategorised last, as in the mock-up: the groups first, then what still needs one.
      .sort((a, b) => Number(a.isUncategorised) - Number(b.isUncategorised) || b.netMinor - a.netMinor)
  }, [breakdown])

  // An average month per group, from the year shown, for the breakdown month's ticks: only while
  // both are the same year (the switcher can move the year away from the month).
  const averages = useMemo(() => {
    if (!annual || !breakdown || annual.year !== breakdown.year || annual.categories.length === 0) return null
    return new Map(annual.categories.map((c) => [averageKey(c.kind, c.name), fromAmount(c.averagePerMonth)]))
  }, [annual, breakdown])

  const hasData = trends !== null && trends.points.length > 0
  const now = currentMonth()
  const thisMonthKey = todayIso().slice(0, 7)

  // The KPI row: the latest month's saving (a budget made ahead for next month has nothing in it
  // yet, so the latest month up to this one), the window's average spend, and the latest month's
  // savings rate (saved ÷ received).
  const points = trends?.points ?? []
  const latest = points.filter((p) => p.key <= thisMonthKey).at(-1)
  const latestIsNow = latest?.key === thisMonthKey
  const savedThisMonthMinor = latest ? fromAmount(latest.incomeReceived) - fromAmount(latest.spent) : 0
  const avgSpendMinor = points.length > 0 ? Math.round(fromAmount(trends!.totalSpent) / points.length) : 0
  const latestReceivedMinor = latest ? fromAmount(latest.incomeReceived) : 0
  const savingsRate = latestReceivedMinor > 0 ? Math.round((savedThisMonthMinor / latestReceivedMinor) * 100) : 0
  // Rows in another currency still waiting for their amount in the budget currency count in no
  // figure here; say how many, or a total silently leaves them out. The window's count is in the
  // average's (i); the chosen month's and the jars' sit at those cards' feet with the way to add them.
  const waitingInWindow = points.reduce((n, p) => n + (p.fxPendingCount ?? 0), 0)
  const latestName = latest ? LONG_MONTHS[latest.month - 1] : null

  // Which months the average covers: every month of the window, the month in progress and any
  // month already budgeted ahead included.
  const avgHint = (() => {
    const first = points[0]
    const last = points.at(-1)
    if (!first || !last) return null
    const notes: string[] = []
    if (points.some((p) => p.key === thisMonthKey)) notes.push(`${LONG_MONTHS[now.month - 1]} so far`)
    const ahead = points.filter((p) => p.key > thisMonthKey).map((p) => LONG_MONTHS[p.month - 1])
    if (ahead.length > 0) notes.push(`${ahead.join(' and ')} budgeted ahead`)
    const n = points.length
    const waiting =
      waitingInWindow > 0
        ? ` ${waitingInWindow} ${waitingInWindow === 1 ? 'payment' : 'payments'} in another currency ${
            waitingInWindow === 1 ? 'isn’t' : 'aren’t'
          } counted yet.`
        : ''
    return `Average spent per month over ${rangeLabel(first, last)} (${n} ${n === 1 ? 'month' : 'months'}${
      notes.length > 0 ? `, ${notes.join(' and ')}` : ''
    }).${waiting}`
  })()

  const breakdownMonth = breakdown ? LONG_MONTHS[breakdown.month - 1] : null
  const breakdownIsNow = breakdown?.key === thisMonthKey
  const spendingHint = (
    <>
      {breakdownMonth ? `${breakdownMonth}${breakdownIsNow ? ' so far' : ''}` : 'The month'} by group, refunds taken off. What a jar
      paid for counts under its group.
      {averages && <> The tick marks an average month of {annual!.year}.</>}
      {breakdown && breakdown.fxPendingCount > 0 && (
        <> Payments in another currency aren’t counted until they have their amount in {currency}.</>
      )}
    </>
  )

  // The jar card's month marks start at the year's first record, as the Trend's months do.
  const firstMonth = annual && jarSpending && annual.year === jarSpending.year ? (annual.months.find((m) => !isBlankMonth(m))?.month ?? 1) : 1
  const showJars = jarSpending !== null && jarSpending.year === annualYear && jarSpending.jars.length > 0

  const prevYear = () => {
    track(EVENTS.reportViewed, { report_type: 'annual' })
    setAnnualYear((y) => (y ?? currentMonth().year) - 1)
  }
  const nextYear = () => {
    track(EVENTS.reportViewed, { report_type: 'annual' })
    setAnnualYear((y) => (y ?? currentMonth().year) + 1)
  }

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
          <KpiRow tiles={2}>
            <KpiTile
              hero
              className={HERO_TILE}
              label="Saved this month"
              hint={
                !latest
                  ? 'Income received minus what you spent, refunds taken off.'
                  : latestIsNow
                    ? 'Income received this month minus what you’ve spent so far, refunds taken off.'
                    : `Income received in ${latestName} minus what you spent, refunds taken off. ${latestName} is the latest month with a budget.`
              }
              value={money(savedThisMonthMinor)}
              valueLabel={`Saved this month: ${money(savedThisMonthMinor)}`}
              sub={latest && `${money(fromAmount(latest.spent))} spent ${latestIsNow ? 'so far' : `in ${latestName}`}`}
            />
            <KpiTile
              label="Avg monthly spend"
              icon={<ArrowUpRight strokeWidth={1.8} />}
              iconColor="var(--color-clay)"
              hint={avgHint}
              value={money(avgSpendMinor)}
              className={PLAIN_TILE}
            />
            <KpiTile
              label="Savings rate"
              icon={<TrendingUp strokeWidth={1.8} />}
              hue="emerald"
              hint={`The share of ${latestIsNow ? 'this month’s' : latestName ? `${latestName}’s` : 'the month’s'} income you ${
                latestIsNow ? 'haven’t spent so far' : 'didn’t spend'
              }.`}
              value={`${savingsRate}%`}
              className={PLAIN_TILE}
            />
          </KpiRow>

          {/* Desktop: Trend over Jar spending at the left, Spending at the right (in view while
              the page scrolls); a phone reads them in the page's order: Trend, Spending, Jar spending.
              `dash-palette` (index.css): the groups' hues follow the approved palette. */}
          <div className="dash-palette @container">
            <div className="grid gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] @min-[940px]:grid-rows-[auto_1fr] @min-[940px]:items-start">
              <TrendCard
                annual={annual}
                year={annual?.year ?? annualYear ?? now.year}
                currency={currency}
                now={now}
                onPrevYear={prevYear}
                onNextYear={nextYear}
                className={`${DASH_CARD} @min-[940px]:col-start-1 @min-[940px]:row-start-1`}
              />
              <SpendingCard
                categories={categorySpend}
                currency={currency}
                hint={spendingHint}
                monthKey={breakdownKey ?? ''}
                options={[...trends.points].reverse().map((p) => ({ key: p.key, label: monthLabel(p.year, p.month) }))}
                onMonthChange={(key) => {
                  track(EVENTS.reportViewed, { report_type: 'breakdown' })
                  setBreakdownKey(key)
                }}
                averages={averages}
                fxPending={breakdown?.fxPendingCount ?? 0}
                className={`${DASH_CARD} @min-[940px]:sticky @min-[940px]:top-[92px] @min-[940px]:col-start-2 @min-[940px]:row-span-2 @min-[940px]:row-start-1`}
              />
              {/* What each jar paid out, month by month, in the Trend's year: a payment draws
                  from the jar its line names (rule 79), a move between jars is not spending. */}
              {showJars && (
                <JarSpendingCard
                  report={jarSpending!}
                  fallbackCurrency={currency}
                  firstMonth={firstMonth}
                  now={now}
                  className={`${DASH_CARD} @min-[940px]:col-start-1 @min-[940px]:row-start-2`}
                />
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  )
}
