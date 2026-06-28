import { useEffect, useState } from 'react'
import type { CategoryVM } from '../budgetModel'
import { categoryActual, categoryPlanned } from '../budgetModel'
import { formatMoney, type Minor } from '../lib/money'
import { BudgetItemRow } from './BudgetItemRow'
import { Card } from './ui'
import { useAuth } from '../auth/AuthContext'

interface Props {
  category: CategoryVM
  currency: string
  savingItemId: string | null
  onCommitItem: (itemId: string, plannedMinor: Minor) => void
  onRenameItem: (itemId: string, name: string) => void
  onDeleteItem: (itemId: string) => void
  onAddItem: (categoryId: string, name: string) => void
  onRenameCategory: (categoryId: string, name: string) => void
  onDeleteCategory: (categoryId: string) => void
}

/**
 * A group of sinking funds, in the same clean card style as the Income / Everyday
 * spending panels: a header (violet dot marks it as a fund) with the spent / planned
 * total, then each fund as a name + funding bar with its rolled-over **Available**
 * balance and an inline-editable monthly contribution.
 */
export function FundGroup({
  category,
  currency,
  savingItemId,
  onCommitItem,
  onRenameItem,
  onDeleteItem,
  onAddItem,
  onRenameCategory,
  onDeleteCategory,
}: Props) {
  // Fund-group structure needs Admin+; rows self-gate internally.
  const { canWrite } = useAuth()
  const [name, setName] = useState(category.name)
  const [newItemName, setNewItemName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => setName(category.name), [category.name])

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

  return (
    <Card className="group/grp px-6 py-[22px]">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-[9px] w-[9px] shrink-0 rounded-[3px] bg-violet-500" aria-hidden />
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
              className="min-w-0 rounded border border-transparent bg-transparent px-1 text-[15px] font-bold tracking-[-0.01em] text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          ) : (
            <h2 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">{category.name}</h2>
          )}

          {canWrite &&
            (confirmingDelete ? (
              <span className="flex items-center gap-1 text-[11px]">
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

        <div className="shrink-0 text-[13px] tabular-nums text-slate-700">
          {formatMoney(categoryActual(category), currency)}{' '}
          <span className="text-slate-500">of {formatMoney(categoryPlanned(category), currency)}</span>
        </div>
      </div>

      {category.items.map((item) => (
        <BudgetItemRow
          key={item.id}
          item={item}
          currency={currency}
          saving={savingItemId === item.id}
          onCommit={onCommitItem}
          onRename={onRenameItem}
          onDelete={onDeleteItem}
          availableMinor={item.fundAvailableMinor}
        />
      ))}
      {category.items.length === 0 && (
        <p className="py-2.5 text-sm text-slate-500">No savings goals yet — add one below.</p>
      )}

      {canWrite &&
        (adding ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={newItemName}
              placeholder="Add a savings goal (e.g. Car, Holiday, Christmas)…"
              aria-label={`Add a savings goal to ${category.name}`}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewItem()
                if (e.key === 'Escape') {
                  setNewItemName('')
                  setAdding(false)
                }
              }}
              onBlur={() => !newItemName.trim() && setAdding(false)}
              className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <button
              type="button"
              onClick={submitNewItem}
              aria-label={`Add a savings goal to ${category.name}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-surface"
            >
              Add
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={`Add a savings goal to ${category.name}`}
            className="mt-1 rounded px-1 py-1 text-xs font-semibold text-slate-500 opacity-0 transition hover:text-brand-700 group-hover/grp:opacity-100 focus:opacity-100"
          >
            + Add a savings goal
          </button>
        ))}
    </Card>
  )
}
