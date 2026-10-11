import { useId, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Coins, Plus, ReceiptText, ShoppingBag } from 'lucide-react'
import { JarNavIcon } from '../icons'
import { FILL_CHIP, NEUTRAL, TxTile } from '../transactions/TxParts'
import { currencySymbol, formatMoney, type Minor } from '../../lib/money'
import { hueColor, hueForIndex } from '../../lib/categoryColors'
import { CardHead, QuietSelect } from './parts'
import { averageKey } from './figures'

/*
 * The Spending card (restyle PR 7): the chosen month's spending by group, largest first, each with
 * its share of the month (muted, after the amount), a bar and, where the year has one, a tick for
 * an average month. The
 * month is picked in the card's header (the old "Breakdown month" select, quiet now).
 */

export interface CategorySpend {
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

export function SpendingCard({
  categories,
  currency,
  hint,
  monthKey,
  options,
  onMonthChange,
  averages,
  fxPending,
  className = '',
}: {
  /** The month's groups with something in them, largest first. */
  categories: CategorySpend[]
  currency: string
  hint: ReactNode
  monthKey: string
  /** The months the select offers (the window's, newest first). */
  options: { key: string; label: string }[]
  onMonthChange: (key: string) => void
  /** An average month per group (same year only); null when the year shown is another. */
  averages: Map<string, Minor> | null
  /** Rows in another currency still waiting for their amount in the budget currency. */
  fxPending: number
  className?: string
}) {
  const headingId = useId()
  const money = (minor: Minor) => formatMoney(minor, currency)
  // Shares are of the positive spending only; a group that netted below zero has no share.
  const total = categories.reduce((s, c) => s + Math.max(0, c.netMinor), 0)
  // An average month's tick: none for Uncategorised (its average is in the Trend card's averages
  // table), as in the mock-up.
  const avgOf = (c: CategorySpend) => (c.isUncategorised ? 0 : (averages?.get(averageKey(c.kind, c.name)) ?? 0))
  // A little track past the longest bar or tick, as in the mock-up.
  const scale = Math.max(...categories.map((c) => Math.max(c.netMinor, avgOf(c))), 0) / 0.96

  return (
    <section aria-labelledby={headingId} className={className}>
      <CardHead id={headingId} title="Spending" hint={hint} hintAlign="center">
        <QuietSelect aria-label="Breakdown month" value={monthKey} onChange={(e) => onMonthChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </QuietSelect>
      </CardHead>

      {categories.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">No spending recorded for this month yet.</p>
      ) : (
        <div className="-mb-3 text-sm">
          {categories.map((c) => {
            const color = c.isUncategorised ? NEUTRAL : hueColor(hueForIndex(c.hueIndex))
            const share =
              c.netMinor > 0 && total > 0 ? `${Math.round((c.netMinor / total) * 100)}%` : c.netMinor > 0 ? '0%' : null
            const avg = avgOf(c)
            // A visible sliver for any figure above zero (the mock-up's 1.5% for Uncategorised).
            const width = c.isUncategorised
              ? Math.max(1.5, scale > 0 && c.netMinor > 0 ? (c.netMinor / scale) * 100 : 0)
              : scale > 0 && c.netMinor > 0
                ? Math.max(2, (c.netMinor / scale) * 100)
                : 0
            return (
              <div
                key={c.id}
                role="group"
                aria-label={`Spending for ${c.name}`}
                className="flex min-h-14 items-center gap-3.5 border-t border-line py-3 first:border-t-0"
              >
                <TxTile color={color}>
                  {c.isUncategorised ? (
                    <ReceiptText strokeWidth={1.8} />
                  ) : c.kind === 'Savings' ? (
                    <JarNavIcon strokeWidth={1.8} />
                  ) : (
                    <ShoppingBag strokeWidth={1.8} />
                  )}
                </TxTile>
                {/* The name and the amount (its share of the month after it, muted), the bar under them
                    across the row with an average month's tick, and what was refunded, when anything
                    was. The refund comes before the bar in the text, right after the share, as it
                    always read. */}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {/* The Assign chip drops under the name before the name is cut short. */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
                      <span className="flex min-w-0 items-center gap-1">
                        <span
                          className="min-w-0 font-semibold text-slate-900 [overflow-wrap:anywhere]"
                        >
                          {c.name}
                        </span>
                        {/* A Savings group holds the jars: what they paid for. The spaces keep the
                            text apart where it is read as one ("Holiday · jars"). */}
                        {c.kind === 'Savings' && (
                          <>
                            {' '}
                            <span className="inline-flex shrink-0 gap-1 font-medium text-slate-500">
                              <span aria-hidden>·</span> <span>jars</span>
                            </span>
                          </>
                        )}
                      </span>
                      {c.isUncategorised && (
                        // Rule 37: the way to fix it, on the Transactions page. Its name starts with
                        // what it shows and keeps the link's old name after it.
                        <Link
                          to="/transactions"
                          aria-label={`Assign ${c.count}, review uncategorised transactions`}
                          className={FILL_CHIP}
                        >
                          <Plus aria-hidden strokeWidth={2.2} />
                          Assign {c.count}
                        </Link>
                      )}
                    </div>
                    <span className="shrink-0 pl-1 text-right whitespace-nowrap tabular-nums">
                      <span className="font-[650] text-slate-900">{money(c.netMinor)}</span>
                      {share !== null && <span className="text-[13px] font-medium text-slate-500"> · {share}</span>}
                    </span>
                  </div>
                  {/* Rules 38/39: what was refunded, so a small or negative figure is explicable. */}
                  {c.refundsMinor > 0 && (
                    <p className="order-last -mt-0.5 text-xs text-slate-500 tabular-nums">
                      <span className="sr-only"> · </span>
                      after {money(c.refundsMinor)} refunded
                    </p>
                  )}
                  <div className="relative">
                    <div aria-hidden className="h-1.5 min-w-10 overflow-hidden rounded-full bg-track">
                      <span
                        data-bar-fill
                        className="block h-full rounded-full"
                        style={{
                          width: `${Math.round(width * 100) / 100}%`,
                          background: c.isUncategorised
                            ? `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in srgb, ${color} 40%, var(--color-card)) 3px 6px)`
                            : color,
                        }}
                      />
                    </div>
                    {avg > 0 && scale > 0 && (
                      <span
                        data-tick
                        className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-[2px] shadow-[0_0_0_2px_var(--color-card)]"
                        style={{
                          left: `${Math.round((avg / scale) * 10000) / 100}%`,
                          background: 'color-mix(in srgb, var(--color-foreground) 62%, var(--color-card))',
                        }}
                      >
                        <span className="sr-only">An average month: {money(avg)}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {fxPending > 0 && <NotCounted count={fxPending} currency={currency} />}
    </section>
  )
}

/**
 * The payments a figure leaves out: rows in another currency still waiting for their amount in
 * the budget currency (the app never converts on its own). A row at the card's foot with the
 * dashed chip that leads to where they are entered; the card's (i) says why.
 */
export function NotCounted({ count, currency }: { count: number; currency: string }) {
  const amounts = `${currencySymbol(currency)} amount${count === 1 ? '' : 's'}`
  return (
    <div role="status" className="mt-3 flex min-h-14 items-center gap-3.5 border-t border-line pt-3 text-sm">
      <TxTile color={NEUTRAL}>
        <Coins strokeWidth={1.8} />
      </TxTile>
      {/* The count under the label and the chip at the end, so a phone's narrow card never cuts
          the label short. */}
      <div className="min-w-0 flex-1">
        <p className="font-semibold [overflow-wrap:anywhere] text-slate-900">Not counted yet</p>
        <p className="text-[13px] text-slate-500 tabular-nums">
          {count} {count === 1 ? 'payment' : 'payments'}
        </p>
      </div>
      <Link to="/transactions" aria-label={`Add the ${amounts} on Transactions`} className={FILL_CHIP}>
        <Plus aria-hidden strokeWidth={2.2} />
        {amounts}
      </Link>
    </div>
  )
}
