import { useMemo } from 'react'
import { Input } from '../ui'
import type { JarLedgerLineDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { selectOnFocusProps } from '../../lib/selectOnFocus'
import { jarAllocationsTotal } from '../../lib/jarAllocationFields'

export interface JarAllocationFieldsProps {
  /** The active jars of the account the money reaches. */
  jars: JarLedgerLineDto[]
  accountName: string
  currency: string
  /** The amount arriving, in major units (the fields can't exceed it). Null while unknown. */
  amount: number | null
  /** The typed amount per jar id, as entered (strings, so partial input survives re-renders). */
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  /** Field ids are prefixed so several prompts can coexist (one per import row). */
  idPrefix: string
  compact?: boolean
}

/**
 * The incoming-money prompt (rule 78): "how much of this goes to each jar?" for an account that
 * backs jars. Every field defaults to empty (unallocated); the remainder line shows what stays
 * unallocated. The prompt may be dismissed by leaving the fields empty.
 */
export function JarAllocationFields({
  jars, accountName, currency, amount, value, onChange, idPrefix, compact = false,
}: JarAllocationFieldsProps) {
  const total = useMemo(() => jarAllocationsTotal(value), [value])
  const remainder = amount === null || total === null ? null : Math.round((amount - total) * 100) / 100
  const over = remainder !== null && remainder < 0
  if (jars.length === 0) return null
  return (
    <fieldset className={`rounded-lg border border-slate-300 ${compact ? 'p-2' : 'p-3'} space-y-2`} data-testid={`${idPrefix}-jar-allocation`}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
        Put into jars in {accountName}
      </legend>
      <p className="text-xs text-slate-600">
        Leave a jar empty to keep that money unallocated. You can allocate it later from the Jars page.
      </p>
      <div className={compact ? 'grid gap-2 sm:grid-cols-2' : 'space-y-2'}>
        {jars.map((jar) => {
          const id = `${idPrefix}-jar-${jar.jarId}`
          return (
            <label key={jar.jarId} htmlFor={id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-800">
                {jar.name}
                <span className="ml-1 text-xs text-slate-500">
                  ({jar.balance === null ? 'balance not available' : formatMoney(fromAmount(jar.balance), currency)})
                </span>
              </span>
              <Input
                id={id}
                inputMode="decimal"
                className="w-28 text-right"
                placeholder="0.00"
                aria-label={`Amount for ${jar.name}`}
                value={value[jar.jarId] ?? ''}
                onChange={(e) => onChange({ ...value, [jar.jarId]: e.target.value })}
                {...selectOnFocusProps}
              />
            </label>
          )
        })}
      </div>
      <p className={`text-xs ${over ? 'text-rose-700' : 'text-slate-600'}`} aria-live="polite">
        {total === null
          ? 'Enter amounts as numbers.'
          : over
            ? `The jar amounts exceed the ${amount === null ? 'amount' : formatMoney(fromAmount(amount), currency)} received.`
            : remainder === null
              ? `Jars: ${formatMoney(fromAmount(total), currency)}`
              : `Stays unallocated: ${formatMoney(fromAmount(remainder), currency)}`}
      </p>
    </fieldset>
  )
}
