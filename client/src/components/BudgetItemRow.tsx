import { useEffect, useState } from 'react'
import type { BillStatus, ItemVM } from '../budgetModel'
import { itemRemaining } from '../budgetModel'
import { currencySymbol, formatMoney, parseMinor, toEditString, type Minor } from '../lib/money'
import { hueColor, hueTint, type CategoryHue } from '../lib/categoryColors'
import { useAuth } from '../auth/AuthContext'

interface Props {
  item: ItemVM
  currency: string
  saving: boolean
  onCommit: (itemId: string, plannedMinor: Minor) => void
  /** When provided, the line name is inline-editable. */
  onRename?: (itemId: string, name: string) => void
  /** When provided, a delete affordance is shown. */
  onDelete?: (itemId: string) => void
  /** When provided, the line can be tracked as a bill with a due day (null clears it). */
  onSetBill?: (itemId: string, dueDay: number | null) => void
  /** When provided, a bill line shows a paid checkbox. */
  onSetPaid?: (itemId: string, isPaid: boolean) => void
  /** Urgency of this line's bill relative to today (drives the due-date pill colour). */
  billStatus?: BillStatus | null
  /** When provided, ▲▼ controls reorder the line within its category. */
  onMove?: (itemId: string, direction: -1 | 1) => void
  isFirst?: boolean
  isLast?: boolean
  /**
   * For a fund line: the rolled-over available balance. When set, the last column
   * shows this (the fund's running balance) instead of the single-month remaining.
   */
  availableMinor?: Minor | null
  /** When set, a thin spent/planned progress bar (track = tint, fill = hue) is drawn under the row. */
  hue?: CategoryHue
}

/**
 * A single budget line: an (optionally) editable name, an inline-editable
 * planned amount parsed straight to integer minor units (no floating point),
 * its (read-only, transaction-derived) actual + remaining, and an optional
 * delete. Commits on blur or Enter (Escape reverts), only when the value
 * actually changed and is valid.
 */
export function BudgetItemRow({
  item,
  currency,
  saving,
  onCommit,
  onRename,
  onDelete,
  onSetBill,
  onSetPaid,
  onMove,
  isFirst = false,
  isLast = false,
  availableMinor,
  billStatus,
  hue,
}: Props) {
  // Structural edits need Admin+ (canWrite); marking a bill paid is day-to-day (canEnterData).
  const { canWrite, canEnterData } = useAuth()
  const [name, setName] = useState(item.name)
  const [draft, setDraft] = useState(toEditString(item.plannedMinor))
  const [billEditing, setBillEditing] = useState(false)
  const [billDraft, setBillDraft] = useState(item.dueDay?.toString() ?? '')

  // Re-sync when the underlying values change (optimistic update or rollback).
  useEffect(() => setName(item.name), [item.name])
  useEffect(() => setDraft(toEditString(item.plannedMinor)), [item.plannedMinor])
  useEffect(() => setBillDraft(item.dueDay?.toString() ?? ''), [item.dueDay])

  function commitBill() {
    if (!onSetBill) return
    const n = Number(billDraft)
    setBillEditing(false)
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      setBillDraft(item.dueDay?.toString() ?? '') // revert invalid input
      return
    }
    if (n !== item.dueDay) onSetBill(item.id, n)
  }

  function clearBill() {
    setBillEditing(false)
    onSetBill?.(item.id, null)
  }

  function commitName() {
    if (!onRename) return
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(item.name) // revert empty
      return
    }
    if (trimmed !== item.name) onRename(item.id, trimmed)
  }

  function commitPlanned() {
    const parsed = parseMinor(draft)
    if (parsed === null) {
      setDraft(toEditString(item.plannedMinor)) // revert invalid input
      return
    }
    if (parsed !== item.plannedMinor) onCommit(item.id, parsed)
  }

  const remaining = itemRemaining(item)
  const overspent = remaining < 0
  // A fund line shows its rolled-over available balance instead of the remaining.
  const showAvailable = availableMinor !== undefined && availableMinor !== null
  const fundOverdrawn = showAvailable && (availableMinor as Minor) < 0
  const overdue = billStatus === 'overdue'
  const dueSoon = billStatus === 'due-soon'
  const billPillClass = overdue
    ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300 hover:bg-rose-200 dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-500/40 dark:hover:bg-rose-500/25'
    : dueSoon
      ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/40 dark:hover:bg-amber-500/25'
      : 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25'
  const billTitle = overdue
    ? `Overdue — was due on day ${item.dueDay}`
    : dueSoon
      ? `Due soon — day ${item.dueDay}`
      : `Bill due on day ${item.dueDay}`
  // Non-interactive pill colours (no hover) for when the due day isn't editable.
  const billPillStatic = overdue
    ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200'
    : dueSoon
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'

  // The thin spent/planned bar (expense lines only — funds show Available instead).
  const showBar = hue !== undefined && !showAvailable && item.plannedMinor > 0
  const barPct = showBar
    ? Math.min(100, Math.max(0, Math.round((item.actualMinor / item.plannedMinor) * 100)))
    : 0

  return (
    <div className="px-4 py-2 hover:bg-slate-50">
    <div className="grid grid-cols-12 items-center gap-2">
      <div className="col-span-4 flex items-center gap-1">
        {canWrite && onMove && (
          <div className="flex shrink-0 flex-col">
            <button
              type="button"
              onClick={() => onMove(item.id, -1)}
              disabled={isFirst}
              aria-label={`Move ${item.name} up`}
              title="Move line up"
              className="flex h-5 w-5 items-center justify-center text-[11px] leading-none text-slate-500 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-500"
            >
              ▲
            </button>
            <button
              type="button"
              onClick={() => onMove(item.id, 1)}
              disabled={isLast}
              aria-label={`Move ${item.name} down`}
              title="Move line down"
              className="flex h-5 w-5 items-center justify-center text-[11px] leading-none text-slate-500 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-500"
            >
              ▼
            </button>
          </div>
        )}
        {canWrite && onRename ? (
          <input
            type="text"
            value={name}
            aria-label={`Rename ${item.name}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setName(item.name)
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-slate-700 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-slate-700">{item.name}</span>
        )}
        {saving && (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
            title="Saving…"
            aria-label="Saving"
          />
        )}

        {(item.dueDay !== null || (canWrite && onSetBill)) &&
          (canWrite && onSetBill && billEditing ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <input
                type="number"
                min={1}
                max={31}
                value={billDraft}
                aria-label={`Due day for ${item.name}`}
                onChange={(e) => setBillDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitBill()
                  if (e.key === 'Escape') {
                    setBillEditing(false)
                    setBillDraft(item.dueDay?.toString() ?? '')
                  }
                }}
                className="h-6 w-12 rounded-md border border-slate-400 px-1 text-xs tabular-nums focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <button
                type="button"
                onClick={commitBill}
                aria-label={`Save due day for ${item.name}`}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400"
              >
                ✓
              </button>
              {item.dueDay !== null && (
                <button
                  type="button"
                  onClick={clearBill}
                  aria-label={`Remove bill from ${item.name}`}
                  title="Remove bill"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                >
                  ✕
                </button>
              )}
            </span>
          ) : item.dueDay !== null ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {canWrite && onSetBill ? (
                <button
                  type="button"
                  onClick={() => setBillEditing(true)}
                  aria-label={`Edit due day for ${item.name}`}
                  title={billTitle}
                  className={`inline-flex min-h-6 items-center rounded px-1.5 text-[11px] font-medium tabular-nums ${billPillClass}`}
                >
                  {overdue ? '⚠' : '📅'} {item.dueDay}
                </button>
              ) : (
                <span
                  title={billTitle}
                  className={`inline-flex min-h-6 items-center rounded px-1.5 text-[11px] font-medium tabular-nums ${billPillStatic}`}
                >
                  {overdue ? '⚠' : '📅'} {item.dueDay}
                </span>
              )}
              {canEnterData && onSetPaid && (
                <button
                  type="button"
                  onClick={() => onSetPaid(item.id, !item.isPaid)}
                  aria-pressed={item.isPaid}
                  aria-label={`Mark ${item.name} paid`}
                  title={item.isPaid ? 'Paid' : 'Mark as paid'}
                  className={`inline-flex min-h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium ${
                    item.isPaid
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  <span aria-hidden>{item.isPaid ? '☑' : '☐'}</span>
                  Paid
                </button>
              )}
            </span>
          ) : canWrite && onSetBill ? (
            <button
              type="button"
              onClick={() => setBillEditing(true)}
              aria-label={`Add a due date to ${item.name}`}
              title="Track as a bill"
              className="inline-flex min-h-6 shrink-0 items-center rounded px-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-600"
            >
              📅
            </button>
          ) : null)}
      </div>

      <div className="col-span-3 flex items-center justify-end">
        <span className="mr-1 text-slate-500">{currencySymbol(currency)}</span>
        {canWrite ? (
          <input
            type="text"
            inputMode="decimal"
            value={draft}
            aria-label={`Planned amount for ${item.name}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitPlanned}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setDraft(toEditString(item.plannedMinor))
            }}
            className="w-24 rounded-lg border border-transparent bg-transparent px-2 py-1 text-right text-sm font-medium tabular-nums text-slate-800 transition hover:bg-slate-100 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
        ) : (
          <span className="w-24 px-2 py-1 text-right text-sm font-medium tabular-nums text-slate-800">
            {toEditString(item.plannedMinor)}
          </span>
        )}
      </div>

      <div className="col-span-2 flex items-center justify-end">
        <span
          className="text-sm tabular-nums text-slate-500"
          title="Total of the transactions assigned to this line"
        >
          {formatMoney(item.actualMinor, currency)}
        </span>
      </div>

      {showAvailable ? (
        <div
          className={`col-span-2 text-right text-sm font-semibold tabular-nums ${
            fundOverdrawn ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'
          }`}
          title="Available in this fund (rolled over from previous months)"
        >
          {formatMoney(availableMinor as Minor, currency)}
        </div>
      ) : (
        <div
          className={`col-span-2 text-right text-sm tabular-nums ${
            overspent ? 'font-semibold text-rose-600 dark:text-rose-400' : 'font-medium text-slate-500'
          }`}
        >
          {formatMoney(remaining, currency)}
        </div>
      )}

      <div className="col-span-1 flex justify-end">
        {canWrite && onDelete && (
          <button
            type="button"
            onClick={() => onDelete(item.id)}
            aria-label={`Delete ${item.name}`}
            title="Delete line"
            className="rounded-md px-1.5 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
          >
            ✕
          </button>
        )}
      </div>
    </div>

    {showBar && (
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full"
        style={{ background: hueTint(hue as CategoryHue) }}
        aria-hidden
      >
        <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: hueColor(hue as CategoryHue) }} />
      </div>
    )}
    </div>
  )
}
