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
   * For a fund line: the rolled-over available balance. When set, the row renders
   * the fund grid (Available column) instead of the everyday-spending layout.
   */
  availableMinor?: Minor | null
  /** The category hue — colours the spent/planned bar, the dot and the Bill tag. */
  hue?: CategoryHue
}

/**
 * A single budget line. Expense lines render the redesign's "Everyday spending"
 * layout — name (+ Bill tag), a spent/planned progress bar, and a right-aligned
 * "€X left" over "€spent of €planned" with the planned amount inline-editable.
 * Fund lines keep the grid with a rolled-over Available column. The planned
 * amount is parsed straight to integer minor units; commits on blur/Enter
 * (Escape reverts) only when it actually changed and is valid.
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
  hue = 'indigo',
}: Props) {
  // Structural edits need Admin+ (canWrite); marking a bill paid is day-to-day (canEnterData).
  const { canWrite, canEnterData } = useAuth()
  const [name, setName] = useState(item.name)
  const [draft, setDraft] = useState(toEditString(item.plannedMinor))
  // The planned amount reads as clean "€spent of €planned" text (matching the
  // design) and only becomes an input once clicked — so the row never carries a
  // ragged inline field at rest.
  const [editingPlanned, setEditingPlanned] = useState(false)
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
  const showAvailable = availableMinor !== undefined && availableMinor !== null
  const fundOverdrawn = showAvailable && (availableMinor as Minor) < 0

  const savingDot = saving && (
    <span
      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand-500"
      title="Saving…"
      aria-label="Saving"
    />
  )

  // The editable line name (or static text when read-only).
  const nameEl =
    canWrite && onRename ? (
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
        className="min-w-0 max-w-[14rem] rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      />
    ) : (
      <span className="px-1.5 text-sm font-semibold text-slate-900">{item.name}</span>
    )

  // Reorder ▲▼ float in the card's left gutter so they never push the line name
  // out of alignment with its bar; they fade in on hover/focus.
  const reorder = canWrite && onMove && (
    <div className="absolute -left-5 top-1/2 flex -translate-y-1/2 flex-col opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={() => onMove(item.id, -1)}
        disabled={isFirst}
        aria-label={`Move ${item.name} up`}
        title="Move line up"
        className="flex h-3.5 w-4 items-center justify-center text-[10px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => onMove(item.id, 1)}
        disabled={isLast}
        aria-label={`Move ${item.name} down`}
        title="Move line down"
        className="flex h-3.5 w-4 items-center justify-center text-[10px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
      >
        ▼
      </button>
    </div>
  )

  // The fund-line delete sits in its grid; the expense-line delete (below) floats
  // in the right gutter so the amounts stay flush-right like the design.
  const deleteBtn = canWrite && onDelete && (
    <button
      type="button"
      onClick={() => onDelete(item.id)}
      aria-label={`Delete ${item.name}`}
      title="Delete line"
      className="shrink-0 rounded-md px-1.5 py-1 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
    >
      ✕
    </button>
  )

  // ---- Fund line: the grid with a rolled-over Available column --------------
  if (showAvailable) {
    return (
      <div className="grid grid-cols-12 items-center gap-2 px-4 py-2.5 hover:bg-slate-50">
        <div className="col-span-5 flex items-center gap-1">
          {nameEl}
          {savingDot}
        </div>
        <div className="col-span-2 flex items-center justify-end">
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
              className="w-20 rounded-lg border border-transparent bg-transparent px-2 py-1 text-right text-sm font-medium tabular-nums text-slate-800 transition hover:bg-slate-100 focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          ) : (
            <span className="w-20 px-2 py-1 text-right text-sm font-medium tabular-nums text-slate-800">
              {toEditString(item.plannedMinor)}
            </span>
          )}
        </div>
        <div className="col-span-2 text-right text-sm tabular-nums text-slate-500">
          {formatMoney(item.actualMinor, currency)}
        </div>
        <div
          className={`col-span-2 text-right text-sm font-semibold tabular-nums ${
            fundOverdrawn ? 'text-rose-600 dark:text-rose-400' : 'text-brand-700 dark:text-brand-200'
          }`}
          title="Available in this fund (rolled over from previous months)"
        >
          {formatMoney(availableMinor as Minor, currency)}
        </div>
        <div className="col-span-1 flex justify-end">{deleteBtn}</div>
      </div>
    )
  }

  // ---- Expense line: the "Everyday spending" layout ------------------------
  const barPct =
    item.plannedMinor > 0 ? Math.min(100, Math.max(0, Math.round((item.actualMinor / item.plannedMinor) * 100))) : 0
  const overdue = billStatus === 'overdue'
  const dueSoon = billStatus === 'due-soon'
  const billTitle = overdue
    ? `Overdue — was due on day ${item.dueDay}`
    : dueSoon
      ? `Due soon — day ${item.dueDay}`
      : `Bill due on day ${item.dueDay}`
  // The Bill tag carries the category hue (overdue/due-soon override to rose/amber).
  const billTagStyle = overdue
    ? { color: 'var(--color-rose-600)', background: 'color-mix(in srgb, var(--color-rose-600) 14%, transparent)' }
    : dueSoon
      ? { color: 'var(--color-amber-700)', background: 'color-mix(in srgb, var(--color-amber-700) 14%, transparent)' }
      : { color: hueColor(hue), background: hueTint(hue) }
  const billTagClass = 'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]'

  return (
    <div className="group relative flex items-center gap-[18px] py-2.5">
      {reorder}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {nameEl}
          {savingDot}

          {/* Bill tag / due-day editor / add-bill, preserving the bill controls. */}
          {item.dueDay !== null && !billEditing ? (
            canWrite && onSetBill ? (
              <button
                type="button"
                onClick={() => setBillEditing(true)}
                aria-label={`Edit due day for ${item.name}`}
                title={billTitle}
                className={billTagClass}
                style={billTagStyle}
              >
                Bill
              </button>
            ) : (
              <span title={billTitle} className={billTagClass} style={billTagStyle}>
                Bill
              </span>
            )
          ) : null}

          {canWrite && onSetBill && billEditing && (
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
                className="inline-flex h-6 w-6 items-center justify-center rounded text-brand-700 hover:bg-brand-50 dark:text-brand-200"
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
          )}

          {item.dueDay === null && canWrite && onSetBill && !billEditing && (
            <button
              type="button"
              onClick={() => setBillEditing(true)}
              aria-label={`Add a due date to ${item.name}`}
              title="Track as a bill"
              className="shrink-0 rounded px-1.5 text-xs text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100 focus:opacity-100"
            >
              📅
            </button>
          )}

          {item.dueDay !== null && canEnterData && onSetPaid && (
            <button
              type="button"
              onClick={() => onSetPaid(item.id, !item.isPaid)}
              aria-pressed={item.isPaid}
              aria-label={`Mark ${item.name} paid`}
              title={item.isPaid ? 'Paid' : 'Mark as paid'}
              className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium ${
                item.isPaid
                  ? 'text-brand-700 dark:text-brand-200'
                  : 'text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 focus:opacity-100'
              }`}
            >
              <span aria-hidden>{item.isPaid ? '☑' : '☐'}</span>
              Paid
            </button>
          )}
        </div>

        {/* Spent / planned bar (track = hue tint, fill = hue) — aligned with the name. */}
        <div className="ml-1.5 mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: hueTint(hue) }} aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: hueColor(hue) }} />
        </div>
      </div>

      <div className="min-w-[118px] text-right">
        <div
          className={`text-sm font-semibold tabular-nums ${
            overspent ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900'
          }`}
        >
          {formatMoney(remaining, currency)} <span className="text-[11.5px] font-medium text-slate-500">left</span>
        </div>
        <div className="mt-0.5 text-[11.5px] tabular-nums text-slate-500">
          {formatMoney(item.actualMinor, currency)} of{' '}
          {canWrite ? (
            editingPlanned ? (
              <span className="inline-flex items-center">
                <span className="text-slate-400">{currencySymbol(currency)}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  value={draft}
                  aria-label={`Planned amount for ${item.name}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    setEditingPlanned(false)
                    commitPlanned()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') {
                      setDraft(toEditString(item.plannedMinor))
                      setEditingPlanned(false)
                    }
                  }}
                  size={Math.max(3, draft.length)}
                  className="rounded border border-brand-500 bg-surface px-1 text-right text-[11.5px] tabular-nums text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-500/30"
                />
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Planned amount for ${item.name}`}
                onClick={() => {
                  setDraft(toEditString(item.plannedMinor))
                  setEditingPlanned(true)
                }}
                className="rounded px-0.5 font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                {formatMoney(item.plannedMinor, currency)}
              </button>
            )
          ) : (
            formatMoney(item.plannedMinor, currency)
          )}
        </div>
      </div>

      {canWrite && onDelete && (
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          aria-label={`Delete ${item.name}`}
          title="Delete line"
          className="absolute -right-5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[11px] text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  )
}
