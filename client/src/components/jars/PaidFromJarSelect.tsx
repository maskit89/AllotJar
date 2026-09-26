import { Select } from '../ui'
import type { JarLedgerLineDto } from '../../types'
import { formatMoney } from '../../lib/money'

export const PAID_FROM_UNALLOCATED = ''

export interface PaidFromJarSelectProps {
  /** The active jars of the account the payment leaves. */
  jars: JarLedgerLineDto[]
  accountName: string
  currency: string
  /** The chosen jar id, or '' for unallocated (the default). */
  value: string
  onChange: (jarId: string) => void
  id: string
  /** Shorter copy for inline rows. */
  compact?: boolean
}

/**
 * The outgoing-money prompt (rule 79): "which jar does this come from?" for a payment from a
 * jar-backed account on a budget line that is not a jar. Defaults to unallocated; a jar line
 * never shows this because the line already names the jar.
 */
export function PaidFromJarSelect({ jars, accountName, currency, value, onChange, id, compact = false }: PaidFromJarSelectProps) {
  if (jars.length === 0) return null
  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-1'} data-testid={`${id}-paid-from`}>
      <label htmlFor={id} className={`text-xs font-medium text-slate-700 ${compact ? '' : 'block'}`}>
        {compact ? 'From jar' : `Which jar in ${accountName} does this come from?`}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={compact ? 'py-1 text-xs' : 'w-full'}>
        <option value={PAID_FROM_UNALLOCATED}>Unallocated money</option>
        {jars.map((jar) => (
          <option key={jar.jarId} value={jar.jarId}>
            {jar.name} ({formatMoney(jar.balance, currency)})
          </option>
        ))}
      </Select>
    </div>
  )
}
