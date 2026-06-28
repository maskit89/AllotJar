import { useEffect, useState } from 'react'
import type { ItemVM } from '../budgetModel'
import { currencySymbol, formatMoney, formatPlain, parseMinor, toEditString, type Minor } from '../lib/money'
import { hueColor, hueTint } from '../lib/categoryColors'
import { useAuth } from '../auth/AuthContext'

interface Props {
  item: ItemVM
  currency: string
  saving: boolean
  onRename: (itemId: string, name: string) => void
  onCommitPlanned: (itemId: string, plannedMinor: Minor) => void
  onDelete: (itemId: string) => void
}

/**
 * A single income source in the "Income" card, in the everyday-spending line
 * style: an editable name over a received-vs-planned bar (the brand green), with
 * the planned amount inline-editable (formatted at rest, raw while focused) and
 * the transaction-derived received amount beneath it.
 */
export function IncomeLineRow({ item, currency, saving, onRename, onCommitPlanned, onDelete }: Props) {
  // Editing income lines (structure + amounts) needs Admin+ (canWrite).
  const { canWrite } = useAuth()
  const [name, setName] = useState(item.name)
  const [draft, setDraft] = useState(toEditString(item.plannedMinor))
  const [focused, setFocused] = useState(false)

  useEffect(() => setName(item.name), [item.name])
  useEffect(() => setDraft(toEditString(item.plannedMinor)), [item.plannedMinor])

  function commitName() {
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(item.name)
      return
    }
    if (trimmed !== item.name) onRename(item.id, trimmed)
  }

  function commitPlanned() {
    const parsed = parseMinor(draft)
    if (parsed === null) {
      setDraft(toEditString(item.plannedMinor))
      return
    }
    if (parsed !== item.plannedMinor) onCommitPlanned(item.id, parsed)
  }

  // Income reads as the brand green; the bar shows received vs planned.
  const pct =
    item.plannedMinor > 0 ? Math.min(100, Math.max(0, Math.round((item.actualMinor / item.plannedMinor) * 100))) : 0

  return (
    <div className="group flex items-center gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {canWrite ? (
            <input
              type="text"
              value={name}
              aria-label="Income source name"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setName(item.name)
              }}
              className="min-w-0 max-w-[14rem] rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          ) : (
            <span className="px-1.5 text-sm font-semibold text-slate-900">{item.name}</span>
          )}
          {saving && (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand-500"
              title="Saving…"
              aria-label="Saving"
            />
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: hueTint('emerald') }} aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: hueColor('emerald') }} />
        </div>
      </div>

      <div className="min-w-[124px] text-right">
        <div className="text-sm font-semibold tabular-nums text-slate-900">
          {currencySymbol(currency)}{canWrite ? (
            <input
              type="text"
              inputMode="decimal"
              value={focused ? draft : formatPlain(item.plannedMinor)}
              aria-label={`Planned amount for ${item.name}`}
              onChange={(e) => {
                setFocused(true)
                setDraft(e.target.value)
              }}
              onFocus={() => {
                setDraft(toEditString(item.plannedMinor))
                setFocused(true)
              }}
              onBlur={() => {
                setFocused(false)
                commitPlanned()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setDraft(toEditString(item.plannedMinor))
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              size={Math.max(4, (focused ? draft : formatPlain(item.plannedMinor)).length)}
              className="rounded border border-transparent bg-transparent text-sm font-semibold tabular-nums text-slate-900 transition hover:border-slate-300 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-1 focus:ring-brand-500/30"
            />
          ) : (
            formatPlain(item.plannedMinor)
          )}
        </div>
        <div className="mt-0.5 text-[11.5px] tabular-nums text-slate-500">
          {formatMoney(item.actualMinor, currency)} received
        </div>
      </div>

      {canWrite && (
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          aria-label={`Delete ${item.name}`}
          title="Delete income source"
          className="shrink-0 rounded-md px-1.5 py-1 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  )
}
