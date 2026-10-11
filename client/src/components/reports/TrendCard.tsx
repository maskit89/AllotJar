import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { SegmentedControl } from '../ui'
import { InfoHint } from '../InfoHint'
import { TITLE_HINT } from '../budget/card'
import type { AnnualSummaryDto } from '../../types'
import { currencySymbol, formatMoney, fromAmount, toAmount, type Minor } from '../../lib/money'
import { BODY_ROW, CELL, CardHead, FOOT, HEAD, PIN_START, TABLE, TableBox, YearSwitcher } from './parts'
import { LONG_MONTHS, SHORT_MONTHS, barPct, isBlankMonth, netTone, signTone, trendAxis, trendSpan } from './figures'

/*
 * The Trend card (restyle PR 7): what was spent each month of the year against the income received,
 * as a chart or as a table (Chart | Table in the header), with the year switcher beside it. It
 * merges the old "Income vs spending" and "Annual overview" cards: both read the same per-month
 * figures (the server derives every report month the same way), so the year's months carry every
 * figure the rolling chart showed, and the table keeps the annual overview's six columns, its
 * dashes, colours and Total. The year's average per category (the old "Average monthly spending by
 * category" card) sits on the Table side under the months.
 */

/** The income line's label, at the line's right end (and the stand-in that measures where it lands). */
const LABEL = 'absolute right-0 -top-2.5 bg-surface pl-2.5 text-xs font-semibold whitespace-nowrap text-slate-500 tabular-nums'

/** A gridline's label: "€0", "€500", "€1k", "€2.5k". */
function axisLabel(minor: Minor, symbol: string): string {
  const major = toAmount(minor)
  if (major >= 1000) return `${symbol}${Math.round((major / 1000) * 10) / 10}k`
  return `${symbol}${Math.round(major)}`
}

interface ChartMonth {
  month: number
  blank: boolean
  now: boolean
  spent: Minor
  income: Minor
}

export function TrendCard({
  annual,
  year,
  currency,
  now,
  onPrevYear,
  onNextYear,
  className = '',
}: {
  /** The last year that loaded (null until the first answer). */
  annual: AnnualSummaryDto | null
  /** The year the switcher shows: the loaded year, or the asked one until it loads. */
  year: number
  currency: string
  now: { year: number; month: number }
  onPrevYear: () => void
  onNextYear: () => void
  className?: string
}) {
  const headingId = useId()
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const money = (minor: Minor) => formatMoney(minor, currency)

  const span = annual ? trendSpan(annual.months, annual.year, now) : null
  const chartMonths: ChartMonth[] =
    annual && span && span.chartEnd >= 0
      ? annual.months.slice(span.first, span.chartEnd + 1).map((m) => ({
          month: m.month,
          blank: isBlankMonth(m),
          now: annual.year === now.year && m.month === now.month,
          spent: fromAmount(m.spent),
          income: fromAmount(m.incomeReceived),
        }))
      : []
  const tableMonths = annual && span ? annual.months.slice(span.first, span.tableEnd + 1) : []
  const inProgress = chartMonths.find((m) => m.now)

  const hint = (
    <>
      What you spent each month against the income you received (the dashed line).
      {inProgress && <> {LONG_MONTHS[inProgress.month - 1]} is so far.</>} Months before the first one recorded are left out.
      Table shows the exact figures and what you budgeted.
    </>
  )

  return (
    <section aria-labelledby={headingId} className={className}>
      {/* Phone: the title and the year on one line, Chart | Table across the card under them. The
          DOM keeps the desktop row's order (Chart | Table, then the year); on a phone, focus follows
          what is drawn (the year, then the switch) where the browser can (reading-flow). */}
      <CardHead
        id={headingId}
        title="Trend"
        hint={hint}
        className="flex-wrap gap-y-3.5 max-[699.98px]:[reading-flow:flex-visual]"
      >
        <div className="flex items-center gap-2.5 max-[699.98px]:contents">
          <div
            className="max-[699.98px]:order-3 max-[699.98px]:basis-full max-[699.98px]:[&>div]:flex max-[699.98px]:[&>div]:w-full max-[699.98px]:[&_button]:flex-1 max-[699.98px]:[&_button]:justify-center"
          >
            <SegmentedControl
              variant="quiet"
              ariaLabel="Show as"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
              ]}
            />
          </div>
          <YearSwitcher year={year} onPrev={onPrevYear} onNext={onNextYear} />
        </div>
      </CardHead>

      <div hidden={view !== 'chart'}>
        {!annual ? (
          // The year's figures are on their way (they load after the window's): hold the space.
          <div aria-hidden className="h-[250px] max-[699.98px]:h-[218px]" />
        ) : chartMonths.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">Nothing recorded in {annual.year}.</p>
        ) : (
          <TrendChart months={chartMonths} year={annual.year} currency={currency} budgetedMax={budgetedMax(annual, span)} />
        )}
      </div>

      <div hidden={view !== 'table'}>
        {annual && (
          <>
            {/* The mock-up's columns first (Month, Received, Spent, Net), so a phone shows them
                without a scroll; what was budgeted and the Variance (rule 41) follow. The months
                stay pinned while the figures scroll under them. */}
            <TableBox label={`Income and spending in ${annual.year}`} fadeStart={false}>
              <table aria-label={`Income and spending in ${annual.year}`} className={TABLE}>
                <thead>
                  <tr>
                    {['Month', 'Received', 'Spent', 'Net', 'Budgeted', 'Variance'].map((h, i) => (
                      <th key={h} scope="col" className={`${HEAD} ${i === 0 ? PIN_START : ''}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableMonths.map((m) => {
                    const blank = isBlankMonth(m)
                    const received = fromAmount(m.incomeReceived)
                    const variance = fromAmount(m.variance)
                    const spent = fromAmount(m.spent)
                    const net = received - spent
                    const isNow = annual.year === now.year && m.month === now.month
                    // The month in progress, and any month budgeted ahead of it, is muted throughout,
                    // its signed figures too: they are not final (the mock-up's `tr.rp-now td`).
                    const notOver = annual.year * 12 + m.month >= now.year * 12 + now.month
                    return (
                      <tr key={m.month} className={`${BODY_ROW} ${m.hasBudget && !notOver ? 'text-slate-900' : 'text-slate-500'}`}>
                        <th scope="row" className={`${CELL} ${PIN_START} font-semibold`}>
                          <span>{SHORT_MONTHS[m.month - 1]}</span>
                          {/* A space, so it reads "Oct so far", not "Octso far". */}
                          {isNow && (
                            <>
                              {' '}
                              <small className="ml-0.5 text-xs font-medium">so far</small>
                            </>
                          )}
                        </th>
                        <td className={CELL}>{blank ? '—' : money(received)}</td>
                        <td className={CELL}>{blank ? '—' : money(spent)}</td>
                        <td className={`${CELL} ${blank ? '' : `font-[650] ${notOver ? '' : netTone(net)}`}`}>{blank ? '—' : money(net)}</td>
                        <td className={CELL}>{m.hasBudget ? money(fromAmount(m.income)) : '—'}</td>
                        {/* Rule 41: actual minus projected, signed; nothing to compare without a budget. */}
                        <td className={`${CELL} ${blank || notOver ? '' : signTone(variance)}`}>
                          {blank ? '—' : variance > 0 ? `+${money(variance)}` : money(variance)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className={`${FOOT} ${PIN_START}`}>
                      Total
                    </th>
                    <td className={FOOT}>{money(fromAmount(annual.totalIncomeReceived))}</td>
                    <td className={FOOT}>{money(fromAmount(annual.totalSpent))}</td>
                    <td className={FOOT}>{money(fromAmount(annual.totalIncomeReceived) - fromAmount(annual.totalSpent))}</td>
                    <td className={FOOT}>{money(fromAmount(annual.totalIncome))}</td>
                    <td className={`${FOOT} ${signTone(fromAmount(annual.totalVariance))}`}>
                      {fromAmount(annual.totalVariance) > 0
                        ? `+${money(fromAmount(annual.totalVariance))}`
                        : money(fromAmount(annual.totalVariance))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </TableBox>
            {annual.categories.length > 0 && <AveragesTable annual={annual} currency={currency} />}
          </>
        )}
      </div>
    </section>
  )
}

/** The budgeted income of the drawn months: not drawn, but the axis covers it (as the old chart did). */
function budgetedMax(annual: AnnualSummaryDto, span: ReturnType<typeof trendSpan>): Minor {
  if (!span) return 0
  return annual.months.slice(span.first, span.chartEnd + 1).reduce((m, x) => Math.max(m, fromAmount(x.income)), 0)
}

/**
 * The chart: a bar of what was spent each month (the month in progress hatched, "so far"), and the
 * income received as a dashed line: one stretch for each run of months at the same level, joined
 * where it steps. Drawn with plain HTML and CSS; the figure's name says every figure, the Table
 * side shows them exactly.
 */
function TrendChart({ months, year, currency, budgetedMax }: { months: ChartMonth[]; year: number; currency: string; budgetedMax: Minor }) {
  const money = (minor: Minor) => formatMoney(minor, currency)
  const n = months.length
  const { top, step } = trendAxis(Math.max(budgetedMax, ...months.map((m) => Math.max(m.spent, m.income))))
  const gridlines: Minor[] = []
  for (let v = 0; v <= top + 0.5; v += step) gridlines.push(v)
  const symbol = currencySymbol(currency)
  // The income line runs through the months that have one: not a month with nothing recorded, nor
  // the month in progress before anything has come in.
  const drawn = (m: ChartMonth) => !(m.blank || (m.now && m.income <= 0))
  const levels = months.map((m) => (drawn(m) ? barPct(m.income, top) : null))
  const lastLevel = levels.findLastIndex((l) => l !== null)
  // One dashed stretch per run of months at the same level, so the dashes run on unbroken.
  const runs: { from: number; to: number; level: number }[] = []
  levels.forEach((level, i) => {
    if (level === null) return
    const run = runs.at(-1)
    if (run && run.to === i - 1 && run.level === level) run.to = i
    else runs.push({ from: i, to: i, level })
  })
  // A gridline under the income line would hide its dashes: that gridline keeps only its label.
  const incomeLevels = new Set(months.filter(drawn).map((m) => m.income))
  // The line's label hangs from its right end. Where a bar (or its "so far") would run into it
  // there, it moves left of the last bar; where that is taken too, it stands over the chart. The
  // browser measures; with nothing laid out (tests), a guess: the label covers about the last two
  // fifths of the columns on a phone.
  const labelRight = `${((n - 1 - lastLevel) * 100) / n}%`
  const incomeLabel = lastLevel >= 0 ? `Income ${money(months[lastLevel].income)}` : ''
  const covered = Math.max(1, Math.ceil(n * 0.42))
  const guessAbove =
    lastLevel >= 0 &&
    months
      .slice(Math.max(0, lastLevel - covered + 1), lastLevel + 1)
      .some((m) => !m.blank && barPct(m.spent, top) + (m.now ? 10 : 0) >= (levels[lastLevel] ?? 0) - 6)
  const plotRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ above: boolean; shift: number } | null>(null)
  const labelAbove = place ? place.above : guessAbove
  const shift = place && !place.above ? place.shift : 0
  const lastMonth = lastLevel >= 0 ? months[lastLevel].month : null
  const said = months
    .map((m) => {
      const name = SHORT_MONTHS[m.month - 1]
      if (m.blank) return `${name} nothing recorded`
      if (m.now) return `${name} ${money(m.spent)} spent so far, ${m.income > 0 ? `${money(m.income)} income so far` : 'no income yet'}`
      return `${name} ${money(m.spent)} spent, ${money(m.income)} income`
    })
    .join('; ')
  useLayoutEffect(() => {
    const plot = plotRef.current
    const anchor = anchorRef.current
    if (!plot || !anchor) return
    const measure = () => {
      if (plot.getBoundingClientRect().width === 0) return // hidden (the Table side), or not laid out
      // Where the label lands with no shift (the line's right end): a stand-in with its text and
      // look, laid out for a moment, so the answer never depends on where the label is now (nor on
      // a move still under way: the reduced-motion rule gives every change a 0.01ms transition).
      const probe = document.createElement('span')
      probe.className = LABEL
      probe.style.visibility = 'hidden'
      probe.textContent = incomeLabel
      anchor.appendChild(probe)
      const box = probe.getBoundingClientRect()
      probe.remove()
      const { left, right } = box
      const marks = Array.from(plot.querySelectorAll<HTMLElement>('[data-bar], [data-sofar]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      const free = (dx: number) =>
        !marks.some((r) => r.right > left + dx - 4 && r.left < right + dx + 4 && r.top < box.bottom + 2 && r.bottom > box.top - 2)
      const last = plot.querySelector<HTMLElement>(`[data-bar="${lastMonth}"]`)?.getBoundingClientRect()
      const before = last && last.width > 0 ? Math.min(0, last.left - 6 - right) : null
      const next = free(0)
        ? { above: false, shift: 0 }
        : before !== null && left + before >= plot.getBoundingClientRect().left && free(before)
          ? { above: false, shift: before }
          : { above: true, shift: 0 }
      setPlace((p) => (p && p.above === next.above && Math.abs(p.shift - next.shift) < 0.5 ? p : next))
    }
    measure()
    // Once more on the next frame, when the bars' new heights have settled (the same rule).
    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(plot)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // The figures (`said`) and the axis decide where everything lands.
  }, [said, top, lastMonth, incomeLabel])
  const crowded = n > 7 // a phone shows twelve months as initials
  const cols: CSSProperties = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }
  const dash = 'border-dashed border-[color-mix(in_srgb,var(--color-slate-500)_75%,transparent)]'

  return (
    <figure role="img" aria-label={`Spent each month against income received, ${year}: ${said}`} className="m-0 pt-1.5 pl-11 max-[699.98px]:pl-[38px]">
      {/* Where the bars leave the line's label no room, it stands over the chart instead, with a
          dash of the line before it. */}
      {lastLevel >= 0 && labelAbove && (
        <div aria-hidden className="relative mb-2.5 flex h-4 justify-end" style={{ marginRight: labelRight }}>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap text-slate-500 tabular-nums">
            <span className={`w-4 border-t-[1.5px] ${dash}`} />
            {incomeLabel}
          </span>
        </div>
      )}
      <div ref={plotRef} aria-hidden className="relative h-[216px] max-[699.98px]:h-[184px]">
        {gridlines.map((v) => (
          <div
            key={v}
            className={`absolute inset-x-0 ${v > 0 && incomeLevels.has(v) ? '' : `border-t ${v === 0 ? 'border-border' : 'border-line'}`}`}
            style={{ bottom: `${Math.round((v / top) * 10000) / 100}%` }}
          >
            <span className="absolute -top-[9px] -left-11 text-xs text-slate-400 tabular-nums max-[699.98px]:-left-[38px]">
              {axisLabel(v, symbol)}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 grid" style={cols}>
          {months.map((m) => (
            <div key={m.month} className="flex items-end justify-center">
              {!m.blank && (
                <span
                  data-bar={m.month}
                  className={`relative w-[min(30px,72%)] rounded-t-[7px] rounded-b-[2px] ${m.now ? '' : 'bg-primary'} max-[699.98px]:w-[min(26px,72%)]`}
                  style={{
                    height: `${barPct(m.spent, top)}%`,
                    ...(m.now
                      ? {
                          background:
                            'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 42%, var(--color-card)) 0 3px, color-mix(in srgb, var(--color-primary) 16%, var(--color-card)) 3px 7px)',
                          boxShadow: 'inset 0 0 0 1.5px var(--color-primary)',
                        }
                      : null),
                  }}
                >
                  {/* A phone's twelve narrow columns leave "so far" no room: the hatching and the
                      bold month say it there (and the figure's name). */}
                  {m.now && (
                    <span
                      data-sofar
                      className={`absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 text-xs font-semibold whitespace-nowrap text-slate-500 ${
                        crowded ? 'max-[699.98px]:hidden' : ''
                      }`}
                    >
                      so far
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {/* The income line, over the bars. */}
        {runs.map((run) => (
          <div
            key={`l${run.from}`}
            data-income={months
              .slice(run.from, run.to + 1)
              .map((m) => m.month)
              .join(' ')}
            className={`absolute border-t-[1.5px] ${dash}`}
            style={{ bottom: `${run.level}%`, left: `${(run.from * 100) / n}%`, width: `${((run.to - run.from + 1) * 100) / n}%` }}
          />
        ))}
        {levels.map((level, i) => {
          const before = i > 0 ? levels[i - 1] : null
          if (level === null || before === null || before === level) return null
          return (
            <div
              key={`j${i}`}
              className={`absolute w-0 border-l-[1.5px] ${dash}`}
              style={{ left: `${(i * 100) / n}%`, bottom: `${Math.min(level, before)}%`, height: `${Math.abs(level - before)}%` }}
            />
          )
        })}
        {lastLevel >= 0 && (
          <div
            ref={anchorRef}
            // No transition, even the reduced-motion 0.01ms one: the label's place is measured right
            // after the anchor moves (a year switch), and a running transition would report the old place.
            className="absolute h-0 transition-none"
            style={{ bottom: `${levels[lastLevel]}%`, right: labelRight }}
          >
            {!labelAbove && (
              <span className={LABEL} style={shift ? { right: -shift } : undefined}>
                {incomeLabel}
              </span>
            )}
          </div>
        )}
      </div>
      <div aria-hidden className="mt-2.5 grid" style={cols}>
        {months.map((m) => (
          <span
            key={m.month}
            className={`text-center text-[13px] ${m.now ? 'font-[650] text-slate-900' : 'font-medium text-slate-500'}`}
          >
            <span className={crowded ? `max-[699.98px]:hidden` : ''}>{SHORT_MONTHS[m.month - 1]}</span>
            {crowded && <span className="hidden max-[699.98px]:inline">{SHORT_MONTHS[m.month - 1][0]}</span>}
          </span>
        ))}
      </div>
    </figure>
  )
}

/**
 * The year's average month per category, every category the year has (the Spending card's ticks
 * show it for the chosen month's only): the average, the year's total, what was refunded, and the
 * jars / Review marks. The (i) says what the server divided by (D12).
 */
function AveragesTable({ annual, currency }: { annual: AnnualSummaryDto; currency: string }) {
  const headingId = useId()
  const money = (minor: Minor) => formatMoney(minor, currency)
  const months = annual.countedMonths ?? annual.budgetedMonths ?? 0
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 id={headingId} className="text-sm font-[650] text-slate-900">
          Average month by category
        </h3>
        <InfoHint label="About the averages" buttonClassName={TITLE_HINT}>
          Each category’s spend averaged over {months} {months === 1 ? 'month' : 'months'} of {annual.year}, counting a month
          with no budget as a month too.
        </InfoHint>
      </div>
      <TableBox label={`Average month by category, ${annual.year}`}>
        <table aria-labelledby={headingId} className={`${TABLE} min-w-[300px]`}>
          <thead>
            <tr>
              <th scope="col" className={HEAD}>
                Category
              </th>
              <th scope="col" className={HEAD}>
                Average
              </th>
              <th scope="col" className={HEAD}>
                Year
              </th>
            </tr>
          </thead>
          <tbody>
            {annual.categories.map((c) => {
              const refunds = fromAmount(c.refunds ?? 0)
              // A Savings group holds the jars (as in the Spending card); Uncategorised wants a review.
              const mark = c.kind === 'Savings' ? 'jars' : c.kind === 'Uncategorised' ? 'Review' : null
              // Named by its cells (the category, then its figures), as every table on the page.
              return (
                <tr key={`${c.kind}-${c.name}`} className={`${BODY_ROW} last:[&>*]:border-b-0`}>
                  <th scope="row" className={`${CELL} font-semibold whitespace-normal text-slate-900`}>
                    {c.name}
                    {mark && (
                      <>
                        {' '}
                        <span aria-hidden className="font-medium text-slate-500">
                          ·
                        </span>{' '}
                        <span className="font-medium text-slate-500">{mark}</span>
                      </>
                    )}
                  </th>
                  <td className={`${CELL} font-[650]`}>{money(fromAmount(c.averagePerMonth))}</td>
                  <td className={`${CELL} text-slate-500`}>
                    {money(fromAmount(c.total))}
                    {refunds > 0 && <span className="block text-xs whitespace-normal">after {money(refunds)} refunded</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableBox>
    </div>
  )
}
