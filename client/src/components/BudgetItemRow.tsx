import { useEffect, useState } from 'react'
import type { BillStatus, ItemVM } from '../budgetModel'
import { itemRemaining } from '../budgetModel'
import { currencySymbol, formatMoney, parseMinor, toEditString, type Minor } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { hueColor, hueTint, type CategoryHue } from '../lib/categoryColors'
import { useAuth } from '../auth/AuthContext'

interface Props {
  item: ItemVM
  currency: string
  saving: boolean
  /** Omitted when the planned amount can't be changed here (a past month's jar line). */
  onCommit?: (itemId: string, plannedMinor: Minor) => void
  /** When provided, the line name is inline-editable. */
  onRename?: (itemId: string, name: string) => void
  /** When provided, a delete affordance is shown. */
  onDelete?: (itemId: string) => void
  /**
   * Savings lines only (rule 60): when provided, the ✕ opens the skip-or-archive choice instead
   * of deleting — a jar's contribution cannot be removed from a month, only skipped.
   */
  onRemoveJarLine?: (itemId: string) => void
  /** Savings lines only (rule 60): plans a skipped month's contribution again. */
  onRestoreJarLine?: (itemId: string) => void
  /** When provided, the line can be tracked as a bill with a due day (null clears it). */
  onSetBill?: (itemId: string, dueDay: number | null) => void
  /** When provided, a bill line shows a paid checkbox. */
  onSetPaid?: (itemId: string, isPaid: boolean) => void
  /** Urgency of this line's bill relative to today (drives the due-date pill colour). */
  billStatus?: BillStatus | null
  /** The due day clamped to the month's length, for the tooltip (so February shows 28, not 31). */
  dueDayEffective?: number | null
  /** When provided, ▲▼ controls reorder the line within its category. */
  onMove?: (itemId: string, direction: -1 | 1) => void
  isFirst?: boolean
  isLast?: boolean
  /**
   * For a fund line: the rolled-over available balance. When set, the row renders
   * the fund grid (Available column) instead of the everyday-spending layout.
   */
  availableMinor?: Minor | null
  /**
   * True for a line in a Savings group: keeps the fund grid even when `availableMinor`
   * is null, which then reads "Not available" (the jar's account balance can't be
   * calculated, rule 67) rather than falling back to the expense layout.
   */
  savingsLine?: boolean
  /**
   * Savings lines only (rule 14): what went into the jar this month and what is still to go,
   * read from the jar itself. Null or omitted while the jars are loading or could not be read:
   * the line then shows only its plan.
   */
  contribution?: { contributedMinor: Minor; remainingMinor: Minor } | null
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
  onRemoveJarLine,
  onRestoreJarLine,
  onSetBill,
  onSetPaid,
  onMove,
  isFirst = false,
  isLast = false,
  availableMinor,
  savingsLine = false,
  contribution,
  billStatus,
  dueDayEffective,
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
    if (parsed !== item.plannedMinor) onCommit?.(item.id, parsed)
  }

  const remaining = itemRemaining(item)
  const overspent = remaining < 0
  const showAvailable = savingsLine || (availableMinor !== undefined && availableMinor !== null)
  const availableKnown = availableMinor !== undefined && availableMinor !== null
  const fundOverdrawn = availableKnown && (availableMinor as Minor) < 0
  // The progress bar fills to spent / planned for this line; a savings line fills to what
  // went into the jar this month against its plan (rule 14), never to what was spent from it.
  const barNumerator = savingsLine ? (contribution?.contributedMinor ?? 0) : item.actualMinor
  const barPct =
    item.plannedMinor > 0 ? Math.min(100, Math.max(0, Math.round((barNumerator / item.plannedMinor) * 100))) : 0

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
    <div className="absolute -left-7 top-1/2 flex -translate-y-1/2 flex-col opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={() => onMove(item.id, -1)}
        disabled={isFirst}
        aria-label={`Move ${item.name} up`}
        title="Move line up"
        className="flex min-h-6 min-w-6 items-center justify-center text-[10px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => onMove(item.id, 1)}
        disabled={isLast}
        aria-label={`Move ${item.name} down`}
        title="Move line down"
        className="flex min-h-6 min-w-6 items-center justify-center text-[10px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
      >
        ▼
      </button>
    </div>
  )

  // The planned amount — clean "€X" text that turns into an input on click. Shared
  // by the expense and fund line layouts so they read the same.
  const plannedEditor = canWrite && onCommit ? (
    editingPlanned ? (
      <span className="inline-flex items-center">
        <span className="text-slate-500">{currencySymbol(currency)}</span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          {...selectOnFocusProps}
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
    <span data-testid={`planned-${item.name}`}>{formatMoney(item.plannedMinor, currency)}</span>
  )

  // ---- Fund line: name + funding bar, with the rolled-over Available balance ----
  if (showAvailable) {
    return (
      <div className="group relative flex items-center gap-[18px] py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {nameEl}
            {item.isSkipped && (
              <span
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500"
                title="This month’s contribution was skipped (rule 60); the rest of the plan was spread over the months that are left."
              >
                Skipped
              </span>
            )}
            {item.isSkipped && canWrite && onRestoreJarLine && (
              <button
                type="button"
                onClick={() => onRestoreJarLine(item.id)}
                aria-label={`Plan ${item.name} again this month`}
                className="text-[11.5px] font-semibold text-slate-500 underline transition hover:text-brand-700 dark:hover:text-brand-200"
              >
                Plan it again
              </button>
            )}
            {savingDot}
          </div>
          {/* Funding bar: what went in of this month's contribution (violet marks a fund). */}
          <div className="ml-1.5 mt-2 h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-500/20" aria-hidden>
            <div className="h-full rounded-full bg-violet-500" style={{ width: `${barPct}%` }} />
          </div>
        </div>

        <div className="min-w-[118px] text-right">
          <div
            className={`text-sm font-semibold tabular-nums ${
              fundOverdrawn ? 'text-rose-600 dark:text-rose-400' : availableKnown ? 'text-slate-900' : 'text-slate-500'
            }`}
            title={availableKnown ? 'Available in this jar (its actual balance in its account)' : 'The jar’s account balance is not available'}
          >
            <span>{availableKnown ? formatMoney(availableMinor as Minor, currency) : 'Not available'}</span>{' '}
            <span className="text-[11.5px] font-medium text-slate-500">avail.</span>
          </div>
          {/* Rule 14: the plan stays as planned; what went into the jar this month and what is
              still to go are shown beside it, as the Jars page reads them from the jar's postings.
              Spending from the jar moves Available and the plan, not what went in. */}
          <div className="mt-0.5 text-[11.5px] tabular-nums text-slate-500">
            {!contribution ? (
              <>plan {plannedEditor}</>
            ) : (
              <>
                {formatMoney(contribution.contributedMinor, currency)} in of {plannedEditor} ·{' '}
                {formatMoney(contribution.remainingMinor, currency)} to go
              </>
            )}
          </div>
        </div>

        {canWrite && onRemoveJarLine ? (
          <button
            type="button"
            onClick={() => onRemoveJarLine(item.id)}
            aria-label={`Remove ${item.name} this month`}
            title="Skip this month’s contribution, or archive the jar"
            className="absolute -right-5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[11px] text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
          >
            ✕
          </button>
        ) : (
          canWrite &&
          onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              aria-label={`Delete ${item.name}`}
              title="Delete line"
              className="absolute -right-5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[11px] text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
            >
              ✕
            </button>
          )
        )}
      </div>
    )
  }

  // ---- Expense line: the "Everyday spending" layout ------------------------
  const overdue = billStatus === 'overdue'
  const dueSoon = billStatus === 'due-soon'
  // Show the clamped day so the tooltip matches the day urgency was scored against
  // (a bill set to day 31 reads "day 28" in February, not a day that doesn't exist).
  const dueDayShown = dueDayEffective ?? item.dueDay
  const billTitle = overdue
    ? `Overdue — was due on day ${dueDayShown}`
    : dueSoon
      ? `Due soon — day ${dueDayShown}`
      : `Bill due on day ${dueDayShown}`
  // The Bill tag: urgent states use dark-aware rose/amber tones; a normal bill uses
  // ink text on the category-hue tint. (The cat hues are graphics-tuned — too light as
  // small text — and an inline rose/amber dark-red would fail contrast on the dark tint.)
  const billUrgentTone = overdue
    ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
    : dueSoon
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      : null
  const billTagClass = `shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] ${billUrgentTone ?? ''}`
  const billTagStyle = billUrgentTone ? undefined : { color: 'var(--color-slate-900)', background: hueTint(hue) }

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
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                {...selectOnFocusProps}
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
              aria-label={item.isPaid ? `Mark ${item.name} unpaid` : `Mark ${item.name} paid`}
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
          {formatMoney(item.actualMinor, currency)} of {plannedEditor}
          {/* Rule 39: a refund nets off the line in the month it arrives; say so, or a net figure
              below the purchases reads as a mistake. */}
          {item.refundedMinor > 0 && (
            <span title="Refunds received against this line this month, already taken off the spent figure">
              {' '}
              · {formatMoney(item.refundedMinor, currency)} refunded
            </span>
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
