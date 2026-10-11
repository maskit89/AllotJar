import { X } from 'lucide-react'
import type { HouseholdMemberDto } from '../types'
import { Input, Select } from './ui'
import type { ItemOptionGroup } from '../lib/transactions'
import { selectOnFocusProps } from '../lib/selectOnFocus'

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
 * The fields at the inline editors' size (the building blocks' Input and Select, a size down). The
 * field draws its own focus ring, so the global :focus-visible outline is dropped (no double ring).
 */
const FIELD = 'h-9 py-1.5 focus-visible:outline-none!'

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
          <Select
            value={row.budgetItemId}
            aria-label={`Split line ${index + 1} category`}
            onChange={(e) => onChangeRow(index, { budgetItemId: e.target.value })}
            className={`${FIELD} w-56 max-w-full`}
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
          </Select>
          <Input
            type="text"
            inputMode="decimal"
            {...selectOnFocusProps}
            value={row.amount}
            placeholder="0.00"
            aria-label={`Split line ${index + 1} amount`}
            onChange={(e) => onChangeRow(index, { amount: e.target.value })}
            className={`${FIELD} w-28 text-right tabular-nums`}
          />
          {members.length >= 2 && (
            <Select
              value={row.memberId}
              aria-label={`Split line ${index + 1} member`}
              onChange={(e) => onChangeRow(index, { memberId: e.target.value })}
              className={`${FIELD} w-36`}
            >
              <option value="">No member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
          {rows.length > 2 && (
            <button
              type="button"
              onClick={() => onRemoveRow(index)}
              aria-label={`Remove split line ${index + 1}`}
              title="Remove line"
              className="grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-bad-bg hover:text-bad"
            >
              <X aria-hidden className="size-4" />
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
        remainderMinor === 0 ? 'text-ok' : 'text-bad'
      }`}
    >
      {remainderMinor === 0 ? 'Fully allocated' : `${format(remainderMinor)} left`}
    </span>
  )
}
