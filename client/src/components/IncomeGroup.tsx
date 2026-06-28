import { useState } from 'react'
import type { CategoryVM } from '../budgetModel'
import { categoryActual, categoryPlanned } from '../budgetModel'
import { formatMoney, type Minor } from '../lib/money'
import { IncomeLineRow } from './IncomeLineRow'
import { Card } from './ui'
import { useAuth } from '../auth/AuthContext'

interface Props {
  category: CategoryVM
  currency: string
  savingItemId: string | null
  onRenameItem: (itemId: string, name: string) => void
  onCommitPlanned: (itemId: string, plannedMinor: Minor) => void
  onDeleteItem: (itemId: string) => void
  onAddItem: (categoryId: string, name: string) => void
}

/**
 * The Income card — the pool the user assigns down to €0.00. Rendered in the same
 * clean style as the "Everyday spending" panel: a header with the received / planned
 * total, then each source as a name + received-vs-planned bar with the planned
 * amount inline-editable. Add / rename / remove income sources here.
 */
export function IncomeGroup({
  category,
  currency,
  savingItemId,
  onRenameItem,
  onCommitPlanned,
  onDeleteItem,
  onAddItem,
}: Props) {
  const { canWrite } = useAuth()
  const [newName, setNewName] = useState('')

  function submitNew() {
    const trimmed = newName.trim()
    if (trimmed === '') return
    onAddItem(category.id, trimmed)
    setNewName('')
  }

  return (
    <Card className="px-6 py-[22px]">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">{category.name}</h2>
        <div className="text-[13px] tabular-nums text-slate-700">
          {formatMoney(categoryActual(category), currency)}{' '}
          <span className="text-slate-500">of {formatMoney(categoryPlanned(category), currency)}</span>
        </div>
      </div>

      {category.items.map((item) => (
        <IncomeLineRow
          key={item.id}
          item={item}
          currency={currency}
          saving={savingItemId === item.id}
          onRename={onRenameItem}
          onCommitPlanned={onCommitPlanned}
          onDelete={onDeleteItem}
        />
      ))}
      {category.items.length === 0 && (
        <p className="py-2.5 text-sm text-slate-500">No income yet — add your first source below.</p>
      )}

      {canWrite && (
        <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-3">
          <input
            type="text"
            value={newName}
            placeholder="Add income source (e.g. Freelance, Child Benefit)…"
            aria-label="New income source name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew()
            }}
            className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            type="button"
            onClick={submitNew}
            aria-label="Add income source"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-surface"
          >
            + Add
          </button>
        </div>
      )}
    </Card>
  )
}
