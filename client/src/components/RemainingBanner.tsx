import { currencyNoun, formatMoney, type Minor } from '../lib/money'

interface Props {
  totalIncomeMinor: Minor
  totalPlannedMinor: Minor
  remainingMinor: Minor
  currency: string
}

/**
 * The reactive ZBB banner. It re-renders from integer minor units every time a
 * planned amount changes, so the user watches the pool move toward the zero
 * goal in real time — exactly, with no floating-point drift.
 *   == 0  -> green  "Every euro has a job" (noun follows the user's currency)
 *   > 0   -> amber  "money still to assign"
 *   < 0   -> red    "over-budgeted"
 */
export function RemainingBanner({
  totalIncomeMinor,
  totalPlannedMinor,
  remainingMinor,
  currency,
}: Props) {
  const balanced = remainingMinor === 0
  const over = remainingMinor < 0

  const tone = balanced
    ? { bar: 'bg-emerald-600', ring: 'ring-emerald-200', label: `Every ${currencyNoun(currency)} has a job 🎉` }
    : over
      ? { bar: 'bg-rose-600', ring: 'ring-rose-200', label: 'Over-budgeted — trim a category' }
      : { bar: 'bg-amber-800', ring: 'ring-amber-300', label: 'Still to assign' }

  return (
    <div
      data-tour="remaining-banner"
      className={`rounded-2xl ${tone.bar} text-white shadow-lg ring-4 ${tone.ring} transition-colors`}
    >
      <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-white">
            Remaining to Budget
          </p>
          <p className="mt-1 text-4xl font-bold tabular-nums">{formatMoney(remainingMinor, currency)}</p>
          <p className="mt-1 text-sm text-white">{tone.label}</p>
        </div>

        <div className="flex gap-6 text-right">
          <div>
            <p className="text-xs uppercase tracking-wide text-white">Income</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(totalIncomeMinor, currency)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-white">Assigned</p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(totalPlannedMinor, currency)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
