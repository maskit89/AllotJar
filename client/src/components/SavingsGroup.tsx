import { useEffect, useState } from 'react'
import type { CategoryVM, ItemVM } from '../budgetModel'
import { categoryPlanned } from '../budgetModel'
import { formatMoney, fromAmount, sumMinor, type Minor } from '../lib/money'
import type { JarDto } from '../types'
import { BudgetItemRow } from './BudgetItemRow'
import { Card } from './ui'
import { useAuth } from '../auth/AuthContext'

interface Props {
  category: CategoryVM
  currency: string
  savingItemId: string | null
  /**
   * The month's jars (rule 14): each line reads what went into its jar this month and what is
   * still to go from here. Null while they load or when they could not be read.
   */
  jars: JarDto[] | null
  /** Omitted on a past month: its jar plans are history (rule 46), changed only through the jar. */
  onCommitItem?: (itemId: string, plannedMinor: Minor) => void
  onRenameItem: (itemId: string, name: string) => void
  /**
   * Rule 60: a jar's line cannot be deleted from a month. The ✕ opens the skip-or-archive
   * choice for the line instead; omitted (a past month) it is not shown at all.
   */
  onRemoveJarLine?: (item: ItemVM) => void
  /** Rule 60: plans a skipped month's contribution again (omitted for a past month). */
  onRestoreJarLine?: (itemId: string) => void
  /**
   * Opens the shared jar form (rule 73): a savings line IS a jar's monthly contribution,
   * so it's created through POST /jars — which plants the line here — never as a bare line.
   */
  onAddJar: (categoryId: string) => void
  onRenameCategory: (categoryId: string, name: string) => void
  onDeleteCategory: (categoryId: string) => void
}

/**
 * A group of jars, in the same clean card style as the Income / Everyday spending
 * panels: a header (violet dot marks it as savings) with the contributed / planned total (rule 14),
 * then each jar as a name + funding bar with its actual **Available** balance and an
 * inline-editable monthly contribution. New lines come from the jar form (rule 73), and
 * a line leaves a month only by being skipped or by archiving its jar (rule 60).
 */
export function SavingsGroup({
  category,
  currency,
  savingItemId,
  jars,
  onCommitItem,
  onRenameItem,
  onRemoveJarLine,
  onRestoreJarLine,
  onAddJar,
  onRenameCategory,
  onDeleteCategory,
}: Props) {
  // Fund-group structure needs Admin+; rows self-gate internally.
  const { canWrite } = useAuth()
  const [name, setName] = useState(category.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Rule 60: a jar's line leaves a month only by skipping it or archiving the jar, so a group
  // that still holds one cannot be deleted either (the server refuses it too).
  const holdsJarLines = category.items.some((i) => i.savingsId)
  // Rule 14: the header and each line show what went into the jar this month and what is still
  // to go, as the server reads them from the jar's postings (spending from the jar moves
  // Available, not these). A line whose jar is missing from the read shows only its plan, and so
  // does the header then: a total that counted the missing jar as 0 would read as complete.
  const contributionOf = (item: ItemVM) => {
    const jar = jars?.find((j) => j.id === item.savingsId)
    return jar ? { contributedMinor: fromAmount(jar.contributedThisMonth), remainingMinor: fromAmount(jar.remainingThisMonth) } : null
  }
  const everyJarRead = category.items.every((i) => !i.savingsId || contributionOf(i) !== null)
  const contributedTotal = jars && everyJarRead ? sumMinor(category.items.map((i) => contributionOf(i)?.contributedMinor ?? 0)) : null

  useEffect(() => setName(category.name), [category.name])

  function commitName() {
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(category.name)
      return
    }
    if (trimmed !== category.name) onRenameCategory(category.id, trimmed)
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
            !holdsJarLines &&
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
          {contributedTotal === null ? (
            <span className="text-slate-500">plan {formatMoney(categoryPlanned(category), currency)}</span>
          ) : (
            <>
              {formatMoney(contributedTotal, currency)} in{' '}
              <span className="text-slate-500">of {formatMoney(categoryPlanned(category), currency)}</span>
            </>
          )}
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
          onRemoveJarLine={onRemoveJarLine ? () => onRemoveJarLine(item) : undefined}
          onRestoreJarLine={onRestoreJarLine}
          availableMinor={item.savingsAvailableMinor}
          savingsLine
          contribution={contributionOf(item)}
        />
      ))}
      {category.items.length === 0 && (
        <p className="py-2.5 text-sm text-slate-500">No jars yet — add one below. Each jar is held in one of your accounts.</p>
      )}

      {canWrite && (
        <button
          type="button"
          onClick={() => onAddJar(category.id)}
          aria-label={`Add a jar to ${category.name}`}
          className="mt-1 rounded px-1 py-1 text-xs font-semibold text-slate-500 opacity-0 transition hover:text-brand-700 group-hover/grp:opacity-100 focus:opacity-100"
        >
          + Add jar
        </button>
      )}
    </Card>
  )
}
