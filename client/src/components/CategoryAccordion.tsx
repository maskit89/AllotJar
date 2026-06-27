import { useEffect, useState } from 'react'
import type { CategoryVM } from '../budgetModel'
import { billStatus, categoryActual, categoryPlanned } from '../budgetModel'
import { formatMoney, type Minor } from '../lib/money'
import { hueColor, type CategoryHue } from '../lib/categoryColors'
import { BudgetItemRow } from './BudgetItemRow'
import { Badge, Card } from './ui'
import { useAuth } from '../auth/AuthContext'

interface Props {
  category: CategoryVM
  currency: string
  savingItemId: string | null
  /** The viewed month + today, used to flag overdue / due-soon bills. */
  monthYear: number
  monthNumber: number
  today: Date
  defaultOpen?: boolean
  isFirst?: boolean
  isLast?: boolean
  /** The group's category hue — drives the header dot and each line's progress bar. */
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
 * An expense category group: an editable name, its planned total, inline-
 * editable lines (add / rename / set amount / delete), and a guarded group
 * delete (two-step confirm, because it removes every line inside it).
 */
export function CategoryAccordion({
  category,
  currency,
  savingItemId,
  monthYear,
  monthNumber,
  today,
  defaultOpen = true,
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
  const [open, setOpen] = useState(defaultOpen)
  const [name, setName] = useState(category.name)
  const [newItemName, setNewItemName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => setName(category.name), [category.name])

  // Move a line up (-1) or down (+1) within this category, then persist the order.
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
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-5 py-4">
        <div className="flex flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? `Collapse ${category.name}` : `Expand ${category.name}`}
            className={`text-slate-500 transition-transform hover:text-slate-600 ${open ? 'rotate-90' : ''}`}
          >
            ▶
          </button>
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: hueColor(hue) }}
            aria-hidden
          />
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
              className="rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-slate-800 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          ) : (
            <span className="px-2 py-1 text-base font-semibold text-slate-800">{category.name}</span>
          )}
          <Badge>{category.items.length}</Badge>
        </div>

        <div className="flex items-center gap-3">
          {canWrite && onMove && (
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onMove(category.id, -1)}
                disabled={isFirst}
                aria-label={`Move ${category.name} up`}
                title="Move group up"
                className="rounded px-1 text-slate-500 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => onMove(category.id, 1)}
                disabled={isLast}
                aria-label={`Move ${category.name} down`}
                title="Move group down"
                className="rounded px-1 text-slate-500 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                ▼
              </button>
            </div>
          )}
          <span className="text-sm tabular-nums text-slate-500">
            <span className="font-semibold text-slate-800">{formatMoney(categoryActual(category), currency)}</span>
            {' / '}
            {formatMoney(categoryPlanned(category), currency)}
          </span>
          {canWrite &&
            (confirmingDelete ? (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-slate-500">Delete group?</span>
                <button
                  type="button"
                  onClick={() => onDeleteCategory(category.id)}
                  aria-label={`Confirm delete ${category.name}`}
                  className="rounded-md bg-rose-600 px-2 py-1 font-semibold text-white hover:bg-rose-700"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  aria-label="Cancel delete"
                  className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100"
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
                className="rounded-md px-1.5 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
              >
                🗑
              </button>
            ))}
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-100">
          <div className="overflow-x-auto">
          <div className="min-w-[40rem]">
          <div className="grid grid-cols-12 gap-2 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            <div className="col-span-4">Line</div>
            <div className="col-span-3 text-right">Planned</div>
            <div className="col-span-2 text-right">Actual</div>
            <div className="col-span-2 text-right">Remaining</div>
            <div className="col-span-1" />
          </div>

          <div className="divide-y divide-slate-100">
            {category.items.map((item, i, arr) => (
              <BudgetItemRow
                key={item.id}
                item={item}
                currency={currency}
                saving={savingItemId === item.id}
                isFirst={i === 0}
                isLast={i === arr.length - 1}
                onMove={moveItem}
                onCommit={onCommitItem}
                onSetBill={onSetBill}
                onSetPaid={onSetPaid}
                onRename={onRenameItem}
                onDelete={onDeleteItem}
                billStatus={billStatus(item, monthYear, monthNumber, today)}
                hue={hue}
              />
            ))}
            {category.items.length === 0 && (
              <p className="px-4 py-3 text-sm text-slate-500">No lines yet — add one below.</p>
            )}
          </div>
          </div>
          </div>

          {canWrite && (
            <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
              <input
                type="text"
                value={newItemName}
                placeholder="Add a line (e.g. Groceries, Fuel)…"
                aria-label={`Add a line to ${category.name}`}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNewItem()
                }}
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <button
                type="button"
                onClick={submitNewItem}
                aria-label={`Add line to ${category.name}`}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-surface"
              >
                + Add
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
