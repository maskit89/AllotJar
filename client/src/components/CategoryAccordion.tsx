import { useEffect, useState } from 'react'
import type { CategoryVM } from '../budgetModel'
import { billStatus, categoryActual, categoryPlanned, effectiveDueDay } from '../budgetModel'
import { formatMoney, type Minor } from '../lib/money'
import { hueColor, type CategoryHue } from '../lib/categoryColors'
import { BudgetItemRow } from './BudgetItemRow'
import { useAuth } from '../auth/AuthContext'

interface Props {
  category: CategoryVM
  currency: string
  savingItemId: string | null
  /** The viewed month + today, used to flag overdue / due-soon bills. */
  monthYear: number
  monthNumber: number
  today: Date
  isFirst?: boolean
  isLast?: boolean
  /** The group's category hue — drives the header dot and each line's bar/Bill tag. */
  hue?: CategoryHue
  onMove?: (categoryId: string, direction: -1 | 1) => void
  onCommitItem: (itemId: string, plannedMinor: Minor) => void
  onSetBill: (itemId: string, dueDay: number | null) => void
  onSetPaid: (itemId: string, isPaid: boolean) => void
  onRenameItem: (itemId: string, name: string) => void
  onDeleteItem: (itemId: string) => void
  onAddItem: (categoryId: string, name: string) => void
  onRenameCategory: (categoryId: string, name: string) => void
  onDeleteCategory: (categoryId: string) => void
  onReorderItems: (categoryId: string, orderedItemIds: string[]) => void
}

/**
 * One expense group inside the "Everyday spending" panel: an uppercase header
 * with a category colour dot, the (editable) group name and its spent / planned
 * total, then the lines in the redesign's name + bar + "€left / €spent of
 * €planned" layout. Group rename / reorder / delete and add-line stay as quiet
 * affordances (revealed on hover) so the panel reads as the design while keeping
 * the budget fully editable for Admin+.
 */
export function CategoryAccordion({
  category,
  currency,
  savingItemId,
  monthYear,
  monthNumber,
  today,
  isFirst = false,
  isLast = false,
  hue = 'indigo',
  onMove,
  onCommitItem,
  onSetBill,
  onSetPaid,
  onRenameItem,
  onDeleteItem,
  onAddItem,
  onRenameCategory,
  onDeleteCategory,
  onReorderItems,
}: Props) {
  // Group structure (rename/move/delete/add line) needs Admin+; rows self-gate internally.
  const { canWrite } = useAuth()
  const [name, setName] = useState(category.name)
  const [newItemName, setNewItemName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => setName(category.name), [category.name])

  function moveItem(itemId: string, direction: -1 | 1) {
    const idx = category.items.findIndex((i) => i.id === itemId)
    const swap = idx + direction
    if (idx < 0 || swap < 0 || swap >= category.items.length) return
    const reordered = [...category.items]
    ;[reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]]
    onReorderItems(category.id, reordered.map((i) => i.id))
  }

  function commitName() {
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(category.name)
      return
    }
    if (trimmed !== category.name) onRenameCategory(category.id, trimmed)
  }

  function submitNewItem() {
    const trimmed = newItemName.trim()
    if (trimmed === '') return
    onAddItem(category.id, trimmed)
    setNewItemName('')
    setAdding(false)
  }

  const headerNumber = 'text-[11.5px] font-bold uppercase tracking-[0.07em] text-slate-500'

  return (
    <div className={`group/grp border-slate-100 ${isFirst ? '' : 'mt-3.5 border-t pt-4'}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-[9px] w-[9px] shrink-0 rounded-[3px]" style={{ background: hueColor(hue) }} aria-hidden />
          {canWrite ? (
            <input
              type="text"
              value={name}
              aria-label={`Rename group ${category.name}`}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setName(category.name)
              }}
              className={`min-w-0 rounded border border-transparent bg-transparent px-1 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30 ${headerNumber}`}
            />
          ) : (
            <span className={headerNumber}>{category.name}</span>
          )}

          {canWrite && onMove && (
            <div className="flex shrink-0 items-center opacity-0 transition group-hover/grp:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={() => onMove(category.id, -1)}
                disabled={isFirst}
                aria-label={`Move ${category.name} up`}
                title="Move group up"
                className="rounded px-0.5 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => onMove(category.id, 1)}
                disabled={isLast}
                aria-label={`Move ${category.name} down`}
                title="Move group down"
                className="rounded px-0.5 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30"
              >
                ▼
              </button>
            </div>
          )}

          {canWrite &&
            (confirmingDelete ? (
              <span className="flex items-center gap-1 text-[11px] normal-case">
                <button
                  type="button"
                  onClick={() => onDeleteCategory(category.id)}
                  aria-label={`Confirm delete ${category.name}`}
                  className="rounded bg-rose-600 px-1.5 py-0.5 font-semibold text-white hover:bg-rose-700"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  aria-label="Cancel delete"
                  className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                aria-label={`Delete group ${category.name}`}
                title="Delete group"
                className="shrink-0 rounded px-1 text-slate-400 opacity-0 transition hover:text-rose-600 group-hover/grp:opacity-100 focus:opacity-100"
              >
                🗑
              </button>
            ))}
        </div>

        <div className="shrink-0 text-xs tabular-nums text-slate-500">
          {formatMoney(categoryActual(category), currency)} / {formatMoney(categoryPlanned(category), currency)}
        </div>
      </div>

      {category.items.map((item, i, arr) => (
        <BudgetItemRow
          key={item.id}
          item={item}
          currency={currency}
          saving={savingItemId === item.id}
          isFirst={i === 0}
          isLast={i === arr.length - 1}
          hue={hue}
          onMove={moveItem}
          onCommit={onCommitItem}
          onSetBill={onSetBill}
          onSetPaid={onSetPaid}
          onRename={onRenameItem}
          onDelete={onDeleteItem}
          billStatus={billStatus(item, monthYear, monthNumber, today)}
          dueDayEffective={effectiveDueDay(item.dueDay, monthYear, monthNumber)}
        />
      ))}
      {category.items.length === 0 && (
        <p className="py-2.5 text-sm text-slate-500">No lines yet — add one below.</p>
      )}

      {canWrite &&
        (adding ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={newItemName}
              placeholder="Add a line (e.g. Groceries, Fuel)…"
              aria-label={`Add a line to ${category.name}`}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewItem()
                if (e.key === 'Escape') {
                  setNewItemName('')
                  setAdding(false)
                }
              }}
              onBlur={() => !newItemName.trim() && setAdding(false)}
              className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button
              type="button"
              onClick={submitNewItem}
              aria-label={`Add line to ${category.name}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-surface"
            >
              Add
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={`Add a line to ${category.name}`}
            className="mt-1 rounded px-1 py-1 text-xs font-semibold text-slate-400 opacity-0 transition hover:text-brand-700 group-hover/grp:opacity-100 focus:opacity-100"
          >
            + Add a line
          </button>
        ))}
    </div>
  )
}
