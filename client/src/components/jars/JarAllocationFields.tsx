import { useMemo, type ReactNode } from 'react'
import { Input } from '../ui'
import { GlassJar } from '../GlassJar'
import { InfoHint } from '../InfoHint'
import type { JarLedgerLineDto } from '../../types'
import { currencySymbol, formatMoney, fromAmount } from '../../lib/money'
import { selectOnFocusProps } from '../../lib/selectOnFocus'
import { jarAllocationsTotal } from '../../lib/jarAllocationFields'

export interface JarAllocationFieldsProps {
  /** The jars of the account the money reaches: its active jars, plus an archived one the stored answer names. */
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
  /** What leaving every jar empty does, when it isn't simply "unallocated" (O9b: a refund). */
  emptyNote?: string
  /**
   * 'dialog' (opt-in, the Allocation page's Allocate dialog, restyle PR 10): the polished mock-ups'
   * look. No frame: a small "Into jars" heading with an (i) holding the account and the note, one
   * row per jar (an empty glass jar, its name over what it holds, an amount field with the currency
   * sign), and "Stays unallocated" with the figure at the right. The fieldset keeps its full name
   * ("Put into jars in {account}") for assistive tech. Left out, the prompt looks as it always has.
   */
  look?: 'default' | 'dialog'
  /** Dialog look: the visible heading (default "Into jars"). */
  title?: string
  /** Dialog look: what the (i) says before the account and the note (e.g. whose money this is). */
  hint?: ReactNode
  /**
   * Dialog look: the (i)'s accessible name (default "About putting it into jars"); a dialog with
   * several of these names each one apart (e.g. by whose share it is).
   */
  hintLabel?: string
}

/**
 * The incoming-money prompt (rule 78): "how much of this goes to each jar?" for an account that
 * backs jars. Every field defaults to empty (unallocated); the remainder line shows what stays
 * unallocated. The prompt may be dismissed by leaving the fields empty.
 */
export function JarAllocationFields({
  jars, accountName, currency, amount, value, onChange, idPrefix, compact = false, emptyNote, look = 'default', title = 'Into jars', hint,
  hintLabel = 'About putting it into jars',
}: JarAllocationFieldsProps) {
  const total = useMemo(() => jarAllocationsTotal(value), [value])
  const remainder = amount === null || total === null ? null : Math.round((amount - total) * 100) / 100
  const over = remainder !== null && remainder < 0
  if (jars.length === 0) return null
  const note = emptyNote ?? 'Leave a jar empty to keep that money unallocated. You can allocate it later from the Jars page.'
  if (look === 'dialog') {
    const sign = currencySymbol(currency)
    return (
      <fieldset className="m-0 min-w-0 border-0 p-0" data-testid={`${idPrefix}-jar-allocation`}>
        <legend className="sr-only">Put into jars in {accountName}</legend>
        <div className="mb-1 flex items-center gap-1">
          <span aria-hidden className="text-xs font-[650] tracking-[0.05em] text-slate-500 uppercase">
            {title}
          </span>
          <InfoHint
            // Placed against the screen: the dialog's scrolling middle never cuts it off.
            fixed
            label={hintLabel}
            buttonClassName="relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
          >
            {hint && <span className="mb-1.5 block">{hint}</span>}
            <span className="block">
              Put into jars in {accountName}. {note}
            </span>
          </InfoHint>
        </div>
        {jars.map((jar) => {
          const id = `${idPrefix}-jar-${jar.jarId}`
          const held = jar.balance === null ? null : fromAmount(jar.balance)
          return (
            <label
              key={jar.jarId}
              htmlFor={id}
              className="grid min-h-14 cursor-pointer grid-cols-[22px_minmax(0,1fr)_112px] items-center gap-3 py-1.5 not-first-of-type:border-t not-first-of-type:border-line max-[699.98px]:gap-2.5"
            >
              {/* An empty jar: the ledger has no target or colour to fill it with. */}
              <GlassJar pct={0} hue="teal" width={22} className="-mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-semibold text-slate-900">{jar.name}</span>
                <span className={`truncate text-[13px] tabular-nums ${held !== null && held < 0 && !jar.isArchived ? 'text-bad' : 'text-slate-500'}`}>
                  {jar.isArchived ? (
                    'Archived'
                  ) : held === null ? (
                    'Balance not available'
                  ) : (
                    <>
                      <span className="sr-only">holds </span>
                      {formatMoney(held, currency)}
                    </>
                  )}
                </span>
              </span>
              <span className="dlg-in">
                <span aria-hidden>{sign}</span>
                <input
                  id={id}
                  inputMode="decimal"
                  aria-label={`Amount for ${jar.name}`}
                  value={value[jar.jarId] ?? ''}
                  onChange={(e) => onChange({ ...value, [jar.jarId]: e.target.value })}
                  {...selectOnFocusProps}
                />
              </span>
            </label>
          )
        })}
        <p
          className={`mt-0.5 flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px] ${over ? 'text-bad' : 'text-slate-500'}`}
          aria-live="polite"
        >
          {total === null ? (
            'Enter amounts as numbers.'
          ) : over ? (
            `The jar amounts exceed the ${amount === null ? 'amount' : formatMoney(fromAmount(amount), currency)} received.`
          ) : remainder === null ? (
            <>
              <span>
                Jars<span className="sr-only">: </span>
              </span>
              <b className="font-[650] text-slate-900 tabular-nums">{formatMoney(fromAmount(total), currency)}</b>
            </>
          ) : (
            <>
              <span>
                Stays unallocated<span className="sr-only">: </span>
              </span>
              <b className="font-[650] text-slate-900 tabular-nums">{formatMoney(fromAmount(remainder), currency)}</b>
            </>
          )}
        </p>
      </fieldset>
    )
  }
  return (
    <fieldset className={`rounded-lg border border-slate-300 ${compact ? 'p-2' : 'p-3'} space-y-2`} data-testid={`${idPrefix}-jar-allocation`}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
        Put into jars in {accountName}
      </legend>
      <p className="text-xs text-slate-600">
        {note}
      </p>
      <div className={compact ? 'grid gap-2 sm:grid-cols-2' : 'space-y-2'}>
        {jars.map((jar) => {
          const id = `${idPrefix}-jar-${jar.jarId}`
          return (
            <label key={jar.jarId} htmlFor={id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-800">
                {jar.name}
                <span className="ml-1 text-xs text-slate-500">
                  {jar.isArchived
                    ? '(archived)'
                    : `(${jar.balance === null ? 'balance not available' : formatMoney(fromAmount(jar.balance), currency)})`}
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
