import type { HouseholdMemberDto } from '../types'
import type { ItemOptionGroup } from '../lib/transactions'
import { useRef } from 'react'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { PlusButton } from './PlusButton'

export interface SplitRowDraft {
  budgetItemId: string
  amount: string
  memberId: string
}

interface SplitLinesEditorProps {
  rows: SplitRowDraft[]
  options: ItemOptionGroup[]
  /** Member selects render only when the household is shared (2+ people). */
  members: HouseholdMemberDto[]
  onChangeRow: (index: number, patch: Partial<SplitRowDraft>) => void
  onRemoveRow: (index: number) => void
}

/**
 * The slice rows of a split — category select, amount, optional member, per-row remove —
 * shared by the register's inline split editor and the add-modal's split mode so the two
 * surfaces (and their aria-labels, which the tests key on) can't drift.
 */
export function SplitLinesEditor({ rows, options, members, onChangeRow, onRemoveRow }: SplitLinesEditorProps) {
  return (
    <>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select
            value={row.budgetItemId}
            aria-label={`Split line ${index + 1} category`}
            onChange={(e) => onChangeRow(index, { budgetItemId: e.target.value })}
            className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            <option value="">Choose a line…</option>
            {options.map((g) => (
              <optgroup key={g.category} label={g.category}>
                {g.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <SplitAmount index={index} value={row.amount} onChange={(amount) => onChangeRow(index, { amount })} />
          {members.length >= 2 && (
            <select
              value={row.memberId}
              aria-label={`Split line ${index + 1} member`}
              onChange={(e) => onChangeRow(index, { memberId: e.target.value })}
              className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            >
              <option value="">No member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {rows.length > 2 && (
            <button
              type="button"
              onClick={() => onRemoveRow(index)}
              aria-label={`Remove split line ${index + 1}`}
              title="Remove line"
              className="rounded-md px-2 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/** The "Fully allocated" / "€X left" chip both split surfaces show. */
export function SplitRemainderChip({ remainderMinor, format }: { remainderMinor: number; format: (minor: number) => string }) {
  return (
    <span
      aria-label="Remaining to allocate"
      className={`text-xs font-semibold tabular-nums ${
        remainderMinor === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
      }`}
    >
      {remainderMinor === 0 ? 'Fully allocated' : `${format(remainderMinor)} left`}
    </span>
  )
}

/** One slice's amount with its "+" (a sum, "20+30", also on a phone's number pad). */
function SplitAmount({ index, value, onChange }: { index: number; value: string; onChange: (amount: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <span className="flex gap-1">
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        {...selectOnFocusProps}
        value={value}
        placeholder="0,00"
        aria-label={`Split line ${index + 1} amount`}
        onChange={(e) => onChange(e.target.value)}
        className="w-28 rounded-md border border-slate-300 px-2 py-1 text-right text-sm tabular-nums focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
      <PlusButton value={value} onChange={onChange} inputRef={ref} label={`Add to split line ${index + 1} amount`} />
    </span>
  )
}
