import { InfoHint } from '../InfoHint'
import { currencyNoun, formatMoney, fromAmount } from '../../lib/money'
import type { MonthWrapUpDto } from '../../types'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * How the month before the one being started went, in actual money (GET /budget/{y}/{m}/wrap-up):
 * what came in, what was spent, what went into jars and what is left over for the new month. The
 * figures add up, so an earlier carry shows as its own figure when there is one.
 */
export function MonthWrapUp({ wrapUp, currency, next }: { wrapUp: MonthWrapUpDto; currency: string; next: string }) {
  const name = MONTH_NAMES[wrapUp.month - 1]
  const before = MONTH_NAMES[(wrapUp.month + 10) % 12]
  const money = (amount: number) => formatMoney(fromAmount(amount), currency)
  const over = wrapUp.leftOver < 0
  const figures: { label: string; value: number; sign?: '−' }[] = [
    ...(wrapUp.carriedIn !== 0 ? [{ label: `From ${before}`, value: wrapUp.carriedIn }] : []),
    { label: 'In', value: wrapUp.received },
    { label: 'Spent', value: wrapUp.spent, sign: '−' as const },
    { label: 'Into jars', value: wrapUp.intoJars, sign: '−' as const },
  ]
  return (
    <section aria-label={`${name} ${wrapUp.year}`} className="mx-auto mt-8 max-w-xl border-t border-line pt-6">
      <p className="text-[13px] font-medium text-slate-500">
        {name} {wrapUp.year}
        {!wrapUp.isOver && ' so far'}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-center min-[560px]:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs font-medium text-slate-500">{f.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {f.sign && f.value !== 0 ? `${f.sign} ` : ''}
              {money(Math.abs(f.value)).replace(/^-/, '')}
            </dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="flex items-center justify-center gap-1 text-xs font-medium text-slate-500">
            {over ? 'Overspent' : 'Left over'}
            <InfoHint label={over ? 'About the overspend' : 'About the money left over'} align="end">
              {over
                ? `More went out than came in. ${next} starts this much short.`
                : `Not spent and not in a jar, so it's still in your accounts. ${next} starts with it.`}
            </InfoHint>
          </dt>
          <dd className={`mt-0.5 text-sm font-bold tabular-nums ${over ? 'text-bad' : 'text-ok'}`}>
            {money(Math.abs(wrapUp.leftOver))}
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
