import { useId, useState } from 'react'
import { SegmentedControl } from '../ui'
import { JarNavIcon } from '../icons'
import { TxTile } from '../transactions/TxParts'
import { EYEBROW } from '../budget/BudgetGroup'
import type { JarSpendingReportDto, JarSpendingRowDto } from '../../types'
import { formatMoney, fromAmount, type Minor } from '../../lib/money'
import { hueColor, hueForIndex } from '../../lib/categoryColors'
import { BODY_ROW, CELL, CardHead, FOOT, HEAD, PIN_END, PIN_START, TABLE, TableBox } from './parts'
import { SHORT_MONTHS } from './figures'
import { NotCounted } from './SpendingCard'

/**
 * Jar spending (restyle PR 7; the 5 October 2026 decision, from the jar notes: "how much I am
 * actually spending from each jar monthly/yearly"). Each jar's payouts month by month across the
 * year shown in the Trend card, the jars that paid most first, with a total per jar. A payment
 * counts wholly against the jar it was paid from: 50 for the vet from the Pets jar reads as 50
 * under Pets, and the 30 moved in from Food to cover it is not spending from Food. A refund back
 * into the jar reduces the month it was received (a month can go below zero), and the total says
 * so (rules 38/39). A live jar with nothing spent shows a dash; an archived jar is listed only
 * while the year has a figure. Chart | Table: the month marks, or every month's exact figure (the
 * old table, with the All jars row).
 */
export function JarSpendingCard({
  report,
  fallbackCurrency,
  firstMonth,
  now,
  className = '',
}: {
  report: JarSpendingReportDto
  /** The page's currency: a jar row without its own, and the rows still waiting for an amount. */
  fallbackCurrency: string
  /** The year's first month with anything recorded (1-12): the months before it have no marks. */
  firstMonth: number
  now: { year: number; month: number }
  className?: string
}) {
  const headingId = useId()
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const currencyOf = (row: JarSpendingRowDto) => row.currency || fallbackCurrency
  const monthsOf = (row: JarSpendingRowDto) => Array.from({ length: 12 }, (_, i) => fromAmount(row.months[i] ?? 0))

  // The jars that paid most first; a tie keeps the server's order (live, then archived, by name).
  // A jar keeps the hue of its place in the server's list, so its colour doesn't move with the year.
  const rows = report.jars
    .map((row, index) => ({ row, index, months: monthsOf(row), total: fromAmount(row.total) }))
    .sort((a, b) => b.total - a.total || a.index - b.index)
  const top = Math.max(0, ...rows.flatMap((r) => r.months))
  // Months still to come this year, and months before the year's first record, have no mark.
  const lastMonth = report.year < now.year ? 12 : report.year > now.year ? 0 : now.month
  const shows = (i: number) => i + 1 >= firstMonth && i + 1 <= lastMonth

  // The table's year total across jars only reads when every jar counts in one currency.
  const currencies = new Set(report.jars.map(currencyOf))
  const totalCurrency = currencies.size === 1 ? [...currencies][0] : null
  const grandMonths = Array.from({ length: 12 }, (_, i) => rows.reduce((s, r) => s + r.months[i], 0))
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)
  const cell = (minor: Minor, currency: string) => (minor === 0 ? '—' : formatMoney(minor, currency))

  const hint = (
    <>
      What each jar paid out in {report.year}, by the month it was paid. Money moved between jars is not spending.
      {report.waitingCount > 0 && (
        <> Payments in another currency aren’t counted until they have their amount in {fallbackCurrency}.</>
      )}
    </>
  )

  return (
    <section aria-labelledby={headingId} className={className}>
      <CardHead id={headingId} title="Jar spending" hint={hint}>
        <SegmentedControl
          variant="quiet"
          ariaLabel="Show jars as"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </CardHead>

      <div hidden={view !== 'chart'}>
        {/* One grid for the month letters and every row (subgrid), so the marks line up under them. */}
        <div className="-mb-3 grid grid-cols-[30px_minmax(0,1fr)_minmax(0,2fr)_auto] gap-x-3.5 text-sm max-[699.98px]:grid-cols-[30px_minmax(0,1fr)_auto] max-[699.98px]:gap-x-3">
          <div aria-hidden className="col-span-full grid grid-cols-subgrid border-b border-line pb-2">
            <div className="col-start-3 grid grid-cols-12 gap-1 max-[699.98px]:col-span-2 max-[699.98px]:col-start-2">
              {SHORT_MONTHS.map((m, i) => (
                <span
                  key={m}
                  className={`${EYEBROW} text-center tracking-normal ${
                    report.year === now.year && i + 1 === now.month ? 'text-slate-900!' : shows(i) ? '' : 'text-slate-400!'
                  }`}
                >
                  {m[0]}
                </span>
              ))}
            </div>
          </div>
          {rows.map(({ row, index, months, total }) => {
            const currency = currencyOf(row)
            const color = hueColor(hueForIndex(index))
            const refunds = fromAmount(row.totalRefunds)
            const nothing = total === 0 && months.every((v) => v === 0)
            const said = months
              .map((v, i) => (v === 0 ? null : `${formatMoney(v, currency)} in ${SHORT_MONTHS[i]}`))
              .filter(Boolean)
              .join(', ')
            return (
              <div
                key={row.jarId}
                className={`col-span-full grid min-h-14 grid-cols-subgrid items-center gap-y-2 border-t border-line py-3 [&:nth-child(2)]:border-t-0 ${
                  row.isArchived ? 'text-slate-500' : 'text-slate-900'
                }`}
              >
                <span className={nothing ? '' : `max-[699.98px]:row-span-2 max-[699.98px]:self-start`}>
                  <TxTile color={color}>
                    <JarNavIcon strokeWidth={1.8} />
                  </TxTile>
                </span>
                <span className="min-w-0 truncate font-semibold">
                  {row.name}
                  {row.isArchived && <> <span className="text-xs font-medium text-slate-500">(archived)</span></>}
                </span>
                <div
                  role="img"
                  aria-label={`${row.name} paid out ${said || `nothing in ${report.year}`}`}
                  className={`grid h-8 grid-cols-12 items-end gap-1 max-[699.98px]:col-span-2 max-[699.98px]:col-start-2 max-[699.98px]:row-start-2 max-[699.98px]:h-[26px] ${
                    nothing ? `invisible max-[699.98px]:hidden` : ''
                  }`}
                >
                  {months.map((v, i) =>
                    v > 0 ? (
                      <i
                        key={i}
                        data-paid={i + 1}
                        className="w-full max-w-4 justify-self-center rounded-t-[3px] rounded-b-[1px]"
                        style={{ height: `${Math.round(Math.max(10, (v / (top || 1)) * 100))}%`, background: color }}
                      />
                    ) : (
                      // Nothing paid (or more refunded than paid): a flat mark; none outside the year's span.
                      <i
                        key={i}
                        className={`h-0.5 w-full max-w-4 justify-self-center rounded-sm bg-track ${v === 0 && !shows(i) ? 'invisible' : ''}`}
                      />
                    ),
                  )}
                </div>
                <span className="text-right font-[650] whitespace-nowrap tabular-nums max-[699.98px]:col-start-3 max-[699.98px]:row-start-1">
                  {total === 0 ? (
                    <span className="font-medium text-slate-400">
                      <span aria-hidden>—</span>
                      <span className="sr-only">Nothing</span>
                    </span>
                  ) : (
                    formatMoney(total, currency)
                  )}
                  {refunds > 0 && <span className="sr-only"> after {formatMoney(refunds, currency)} refunded</span>}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div hidden={view !== 'table'}>
        {/* The jar names and the year's totals stay pinned while the months scroll between them. */}
        <TableBox label={`Spending from jars in ${report.year}`} fadeStart={false} fadeEnd={false}>
          <table aria-label={`Spending from jars in ${report.year}`} className={TABLE}>
            <thead>
              <tr>
                <th scope="col" className={`${HEAD} ${PIN_START}`}>
                  Jar
                </th>
                {SHORT_MONTHS.map((m) => (
                  <th key={m} scope="col" className={HEAD}>
                    {m}
                  </th>
                ))}
                <th scope="col" className={`${HEAD} ${PIN_END}`}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, months, total }) => {
                const currency = currencyOf(row)
                const refunds = fromAmount(row.totalRefunds)
                return (
                  <tr key={row.jarId} className={`${BODY_ROW} ${row.isArchived ? 'text-slate-500' : 'text-slate-900'}`}>
                    <th scope="row" className={`${CELL} ${PIN_START} font-semibold`}>
                      {row.name}
                      {row.isArchived && <> <span className="text-xs font-medium text-slate-500">(archived)</span></>}
                    </th>
                    {months.map((v, i) => (
                      <td key={i} className={`${CELL} ${v === 0 ? 'text-slate-400' : ''}`}>
                        {cell(v, currency)}
                      </td>
                    ))}
                    <td className={`${CELL} ${PIN_END} font-[650]`}>
                      {cell(total, currency)}
                      {refunds > 0 && <span className="block text-xs font-medium whitespace-normal text-slate-500">after {formatMoney(refunds, currency)} refunded</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {totalCurrency !== null && rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row" className={`${FOOT} ${PIN_START}`}>
                    All jars
                  </th>
                  {grandMonths.map((minor, i) => (
                    <td key={i} className={FOOT}>
                      {cell(minor, totalCurrency)}
                    </td>
                  ))}
                  <td className={`${FOOT} ${PIN_END}`}>{cell(grandTotal, totalCurrency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </TableBox>
      </div>

      {report.waitingCount > 0 && <NotCounted count={report.waitingCount} currency={fallbackCurrency} />}
    </section>
  )
}
