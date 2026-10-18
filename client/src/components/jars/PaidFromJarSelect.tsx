import { ChevronDown } from 'lucide-react'
import { Select } from '../ui'
import type { JarLedgerLineDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'

export const PAID_FROM_UNALLOCATED = ''

export interface PaidFromJarSelectProps {
  /** The jars of the account the payment leaves: its active jars, plus an archived one the stored answer names. */
  jars: JarLedgerLineDto[]
  accountName: string
  currency: string
  /** The chosen jar id, or '' for unallocated (the default). */
  value: string
  onChange: (jarId: string) => void
  id: string
  /** Shorter copy for inline rows. */
  compact?: boolean
  /**
   * 'dialog' (opt-in, the Import review's "From jar" sheet, restyle PR 14): the sheet dialogs'
   * select (the `.dlg-sel` field with a chevron) named "From jar" for assistive tech, with no
   * visible label (the dialog's title says it). Left out, the prompt looks as it always has.
   */
  look?: 'default' | 'dialog'
}

/**
 * The outgoing-money prompt (rule 79): "which jar does this come from?" for a payment from a
 * jar-backed account on a budget line that is not a jar. Defaults to unallocated; a jar line
 * never shows this because the line already names the jar.
 */
export function PaidFromJarSelect({ jars, accountName, currency, value, onChange, id, compact = false, look = 'default' }: PaidFromJarSelectProps) {
  if (jars.length === 0) return null
  const options = (
    <>
      <option value={PAID_FROM_UNALLOCATED}>Unallocated money</option>
      {jars.map((jar) => (
        <option key={jar.jarId} value={jar.jarId}>
          {jar.name}
          {jar.isArchived
            ? ' (archived)'
            : ` (${jar.balance === null ? 'balance not available' : formatMoney(fromAmount(jar.balance), currency)})`}
        </option>
      ))}
    </>
  )
  if (look === 'dialog') {
    return (
      <span className="dlg-sel block" data-testid={`${id}-paid-from`}>
        <select id={id} aria-label="From jar" value={value} onChange={(e) => onChange(e.target.value)}>
          {options}
        </select>
        <ChevronDown aria-hidden strokeWidth={1.8} />
      </span>
    )
  }
  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-1'} data-testid={`${id}-paid-from`}>
      <label htmlFor={id} className={`text-xs font-medium text-slate-700 ${compact ? '' : 'block'}`}>
        {compact ? 'From jar' : `Which jar in ${accountName} does this come from?`}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={compact ? 'py-1 text-xs' : 'w-full'}>
        {options}
      </Select>
    </div>
  )
}
