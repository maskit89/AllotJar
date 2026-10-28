import { InfoHint } from '../InfoHint'
import { currencyNoun, formatMoney, fromAmount } from '../../lib/money'
import type { MonthWrapUpDto } from '../../types'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** One figure of the card: what it adds to what the month leaves (adds) or takes off it. */
interface Figure {
  label: string
  value: number
  adds: boolean
}

/**
 * How the month before the one being started went, in actual money (GET /budget/{y}/{m}/wrap-up):
 * what earlier months carried in, what came in, what was spent, what went into jars and what is
 * left over for the new month. The figures add up as shown: each carries its own sign, so money
 * taken out of jars reads "Out of jars + €300", and figures that are zero and rare are left out.
 */
export function MonthWrapUp({
  wrapUp,
  currency,
  next,
  isOver,
}: {
  wrapUp: MonthWrapUpDto
  currency: string
  next: string
  /** False while the month is still running (the figures are so far), by the viewer's own date. */
  isOver: boolean
}) {
  const name = MONTH_NAMES[wrapUp.month - 1]
  const before = MONTH_NAMES[(wrapUp.month + 10) % 12]
  const money = (amount: number) => formatMoney(fromAmount(Math.abs(amount)), currency).replace(/^-/, '')
  const over = wrapUp.leftOver < 0
  const figures: Figure[] = [
    ...(wrapUp.carriedIn !== 0 ? [{ label: `From ${before}`, value: wrapUp.carriedIn, adds: true }] : []),
    ...(wrapUp.newAccounts !== 0 ? [{ label: 'New accounts', value: wrapUp.newAccounts, adds: true }] : []),
    { label: 'In', value: wrapUp.received, adds: true },
    { label: 'Spent', value: wrapUp.spent, adds: false },
    { label: wrapUp.intoJars < 0 ? 'Out of jars' : 'Into jars', value: wrapUp.intoJars, adds: false },
    ...(wrapUp.privateTransfers !== 0
      ? [{ label: wrapUp.privateTransfers < 0 ? 'To private' : 'From private', value: wrapUp.privateTransfers, adds: true }]
      : []),
  ]
  // The sign the figure has in the sum: an added figure shows bare unless negative, a figure
  // taken off shows "−", or "+" when it is negative (money back).
  const signOf = (f: Figure) => {
    if (f.value === 0) return ''
    const plus = f.adds === f.value > 0
    return plus ? (f.adds ? '' : '+ ') : '− '
  }
  return (
    <section aria-label={`${name} ${wrapUp.year}`} className="mx-auto mt-8 max-w-xl border-t border-line pt-6">
      <p className="text-[13px] font-medium text-slate-500">
        {name} {wrapUp.year}
        {!isOver && ' so far'}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-center min-[560px]:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs font-medium text-slate-500">{f.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {signOf(f)}
              {money(f.value)}
            </dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="flex items-center justify-center gap-1 text-xs font-medium text-slate-500">
            {over ? 'Overspent' : 'Left over'}
            <InfoHint label={over ? 'About the overspend' : 'About the money left over'} align="end">
              {over
                ? `More went out than there was. ${next} starts this much short.`
                : `Not spent and not in a jar, so it's still in your accounts. ${next} starts with it.`}
            </InfoHint>
          </dt>
          <dd className={`mt-0.5 text-sm font-bold tabular-nums ${over ? 'text-bad' : 'text-ok'}`}>
            {money(wrapUp.leftOver)}
          </dd>
        </div>
      </dl>
      {wrapUp.fxPendingCount > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {wrapUp.fxPendingCount} {wrapUp.fxPendingCount === 1 ? 'entry waits' : 'entries wait'} for a {currencyNoun(currency)} amount and {wrapUp.fxPendingCount === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
    </section>
  )
}
