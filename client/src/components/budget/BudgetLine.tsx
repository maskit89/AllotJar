import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  Coins,
  Pencil,
  ReceiptText,
  RotateCcw,
  ShoppingBag,
  SkipForward,
  Trash2,
  Undo2,
  User,
  Wallet,
  X,
} from 'lucide-react'
import { itemRemaining, type BillStatus, type ItemVM } from '../../budgetModel'
import type { HouseholdMemberDto, JarDto } from '../../types'
import {
  currencySymbol,
  formatMoney,
  fromAmount,
  parseMinor,
  toEditString,
  tooPrecise,
  TOO_MANY_DECIMALS,
  type Minor,
} from '../../lib/money'
import { selectOnFocusProps } from '../../lib/selectOnFocus'
import { hueColor, memberHue, type CategoryHue } from '../../lib/categoryColors'
import { useAuth } from '../../auth/AuthContext'
import { InfoHint } from '../InfoHint'
import { JarNavIcon } from '../icons'
import { ActionSheet, RowMenu, type RowAction } from '../RowActions'
import { MiniBar, StatusChip } from '../StatusChip'
import { MemberAvatar } from '../MemberAvatar'

/** What a line is: an income source, a spending line (maybe a bill) or a jar's monthly contribution. */
export type LineKind = 'income' | 'expense' | 'jar'

/** Which inline editor is open in the row. */
type Mode = 'idle' | 'planned' | 'rename' | 'bill' | 'member'

/**
 * A text input as wide as its text (an invisible copy of the value sizes the cell), so what
 * follows it (an earner, the saving dot) sits right after the name. Reads as plain text at rest;
 * a hairline shows on hover and the field on focus.
 */
export function AutoWidthInput({
  value,
  className = '',
  inputRef,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { value: string; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <span
      data-value={value || ' '}
      className={`-ml-1.5 inline-grid max-w-full min-w-0 *:col-start-1 *:row-start-1 after:invisible after:col-start-1 after:row-start-1 after:overflow-hidden after:border after:px-1.5 after:py-0.5 after:whitespace-pre after:content-[attr(data-value)] ${className}`}
    >
      <input
        ref={inputRef}
        type="text"
        // No intrinsic width of its own (an input's default is ~20 characters): the hidden copy
        // of the value sizes the cell.
        size={1}
        value={value}
        className="w-full min-w-0 text-ellipsis rounded-md border border-transparent bg-transparent px-1.5 py-0.5 [text-transform:inherit] transition hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:ring-2 focus:ring-brand-500/30 focus:outline-none"
        {...rest}
      />
    </span>
  )
}

/** A line's 30px leading tile: a glyph for what the line is, on its colour's tint. */
function Tile({ hue, children }: { hue: CategoryHue; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-[30px] place-items-center rounded-[9px] text-[13px] font-semibold [&_svg]:size-4"
      style={{ background: `color-mix(in srgb, ${hueColor(hue)} 13%, var(--color-card))`, color: hueColor(hue) }}
    >
      {children}
    </span>
  )
}

/**
 * What is left, over or still to go on a line: a fixed column (wide enough for "€1,234.56 left"),
 * right-aligned, so every bar beside it ends at the same place, as in the mock-up.
 */
const LEFT_TEXT = 'text-[13px] font-semibold whitespace-nowrap tabular-nums'
const LEFT = `min-w-[84px] text-right ${LEFT_TEXT}`

export interface BudgetLineProps {
  kind: LineKind
  item: ItemVM
  currency: string
  saving: boolean
  /** Phone layout: no ⋯; the whole line opens its actions in a bottom sheet. */
  phone: boolean
  /** The line's colour: its group's (spending), the jar's (jar lines). */
  hue: CategoryHue
  /** Omitted when the planned amount can't be changed here (a past month's jar line). */
  onCommit?: (itemId: string, plannedMinor: Minor) => void
  onRename?: (itemId: string, name: string) => void
  onDelete?: (itemId: string) => void
  // Income
  members?: HouseholdMemberDto[]
  /** Shared households: who earns each income line. */
  showMember?: boolean
  onSetMember?: (itemId: string, memberId: string | null) => void
  // Spending
  billStatus?: BillStatus | null
  /** The bill's due date in the viewed month, e.g. "20 Oct" (the day clamped to the month). */
  dueDate?: string | null
  onSetBill?: (itemId: string, dueDay: number | null) => void
  onSetPaid?: (itemId: string, isPaid: boolean) => void
  /** Reorder within the group (spending lines only). */
  onMove?: (itemId: string, direction: -1 | 1) => void
  isFirst?: boolean
  isLast?: boolean
  // Jar lines
  /**
   * The line's jar as read for the month (rule 14: what went in and what is still to go). Null
   * while the jars load, when they could not be read or when the jar is missing from the read.
   */
  jar?: JarDto | null
  /** Rule 60: skip this month's contribution (opens the skip-or-archive dialog). */
  onSkip?: (item: ItemVM) => void
  /** Archive the jar (opens the same dialog, archive armed). */
  onArchive?: (item: ItemVM) => void
  /** Rule 60: plan a skipped month's contribution again. */
  onRestore?: (itemId: string) => void
}

/**
 * One budget line (restyle PR 3): icon | name | status | planned | ⋯.
 *
 * - The status says the one thing worth seeing: a bill's chip (Paid / Overdue / Due 20 Oct), a
 *   spending line's bar and what is left or over, whether an income arrived, a jar's progress
 *   this month. Spent-of-planned is kept as screen-reader text for the bar.
 * - Rarely used actions live behind the ⋯ (shown on hover or focus); on a phone the whole line is
 *   one tap target that opens the same actions in a bottom sheet.
 * - Lays itself out by the Budget card's width: one row from 500px, else the status drops under
 *   the name.
 *
 * Edits are the same as before the restyle: the planned amount commits on Enter or blur (Escape
 * reverts, too many decimals keeps the field open with an alert); names commit on Enter or blur
 * (Escape reverts, empty reverts); the due day commits on Enter or ✓ (Escape cancels).
 */
export function BudgetLine({
  kind,
  item,
  currency,
  saving,
  phone,
  hue,
  onCommit,
  onRename,
  onDelete,
  members = [],
  showMember = false,
  onSetMember,
  billStatus,
  dueDate,
  onSetBill,
  onSetPaid,
  onMove,
  isFirst = false,
  isLast = false,
  jar,
  onSkip,
  onArchive,
  onRestore,
}: BudgetLineProps) {
  // Structure, names and amounts need Admin+ (canWrite); marking a bill paid is day-to-day work
  // a Limited member may do too (canEnterData).
  const { canWrite, canEnterData } = useAuth()
  const [name, setName] = useState(item.name)
  const [draft, setDraft] = useState(toEditString(item.plannedMinor))
  // A typed amount with more decimals than cents stays in the field with this message (D1).
  const [plannedError, setPlannedError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [billDraft, setBillDraft] = useState(item.dueDay?.toString() ?? '')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [nameInputEl, setNameInputEl] = useState<HTMLInputElement | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // Where focus goes back to when an inline editor closes by Enter, Escape or a choice (not when
  // it closes because focus moved on): the planned amount when it was opened from there, else
  // the line's ⋯ (desktop) or the line itself (phone), so the user keeps their place.
  const refocus = useRef<'planned' | 'trigger' | null>(null)
  // On a wide screen a rename picked from the ⋯ edits the name in place, with no mode: Enter or
  // Escape gives focus back to the ⋯ directly. Escape drops the edit, so the blur it causes must
  // not save it.
  const [renameFromMenu, setRenameFromMenu] = useState(false)
  const skipCommit = useRef(false)
  const [plannedFrom, setPlannedFrom] = useState<'planned' | 'trigger'>('trigger')

  useEffect(() => {
    const want = refocus.current
    if (!want || mode !== 'idle') return
    refocus.current = null
    const row = rowRef.current
    const target =
      (want === 'planned' ? row?.querySelector<HTMLElement>('[data-planned-button]') : null) ??
      row?.querySelector<HTMLElement>('[data-row-trigger]')
    target?.focus()
  }, [mode])

  // Re-sync when the underlying values change (optimistic update or rollback).
  useEffect(() => setName(item.name), [item.name])
  useEffect(() => setDraft(toEditString(item.plannedMinor)), [item.plannedMinor])
  useEffect(() => setBillDraft(item.dueDay?.toString() ?? ''), [item.dueDay])

  const money = (minor: Minor) => formatMoney(minor, currency)
  const canEditPlanned = canWrite && !!onCommit
  const canRename = canWrite && !!onRename
  const isBill = kind === 'expense' && item.dueDay !== null
  const member = item.memberId ? members.find((m) => m.id === item.memberId) : undefined
  const memberIndex = member ? members.indexOf(member) : -1

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
    if (tooPrecise(draft, item.plannedMinor)) {
      setPlannedError(TOO_MANY_DECIMALS)
      setMode('planned') // keep the typed amount open for correction, never rounded
      refocus.current = null
      return
    }
    setPlannedError(null)
    const parsed = parseMinor(draft)
    if (parsed === null) {
      setDraft(toEditString(item.plannedMinor)) // revert invalid input
      return
    }
    if (parsed !== item.plannedMinor) onCommit?.(item.id, parsed)
  }

  function commitBill() {
    if (!onSetBill) return
    const n = Number(billDraft)
    setMode('idle')
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      setBillDraft(item.dueDay?.toString() ?? '') // revert invalid input
      return
    }
    if (n !== item.dueDay) onSetBill(item.id, n)
  }

  function openPlanned(from: 'planned' | 'trigger' = 'trigger') {
    setPlannedFrom(phone ? 'trigger' : from)
    setDraft(toEditString(item.plannedMinor))
    setMode('planned')
  }

  /** Close the open editor and give focus back (see `refocus`). */
  function closeEditor(to: 'planned' | 'trigger' = 'trigger') {
    refocus.current = to
    setMode('idle')
  }

  function startRename() {
    if (phone) {
      setMode('rename')
      return
    }
    setRenameFromMenu(true)
    nameInputEl?.focus()
    nameInputEl?.select()
  }

  // ---- The line's actions: the ⋯ menu, or the phone sheet ------------------------------------
  const actions: RowAction[] = []
  if (canWrite) {
    if (onCommit) actions.push({ key: 'amount', label: 'Edit amount', icon: <Coins aria-hidden />, after: 'focus', onSelect: () => openPlanned() })
    if (onRename) actions.push({ key: 'rename', label: 'Rename', icon: <Pencil aria-hidden />, after: 'focus', onSelect: startRename })
    if (kind === 'income' && showMember && onSetMember) {
      actions.push({ key: 'member', label: 'Who earns', icon: <User aria-hidden />, after: 'focus', onSelect: () => setMode('member') })
    }
    if (kind === 'expense' && onSetBill) {
      actions.push({
        key: 'bill',
        label: 'Bill due day',
        icon: <CalendarDays aria-hidden />,
        after: 'focus',
        onSelect: () => {
          setBillDraft(item.dueDay?.toString() ?? '')
          setMode('bill')
        },
      })
    }
  }
  if (isBill && canEnterData && onSetPaid) {
    actions.push({
      key: 'paid',
      label: item.isPaid ? 'Mark unpaid' : 'Mark paid',
      icon: item.isPaid ? <Undo2 aria-hidden /> : <Check aria-hidden />,
      onSelect: () => onSetPaid(item.id, !item.isPaid),
    })
  }
  if (canWrite) {
    if (kind === 'expense' && onMove) {
      actions.push({ key: 'up', label: 'Move up', icon: <ArrowUp aria-hidden />, disabled: isFirst, onSelect: () => onMove(item.id, -1) })
      actions.push({ key: 'down', label: 'Move down', icon: <ArrowDown aria-hidden />, disabled: isLast, onSelect: () => onMove(item.id, 1) })
    }
    if (kind === 'jar') {
      if (item.isSkipped && onRestore) {
        actions.push({ key: 'restore', label: 'Plan again this month', icon: <RotateCcw aria-hidden />, onSelect: () => onRestore(item.id) })
      }
      const tail: RowAction[] = []
      if (!item.isSkipped && onSkip) {
        tail.push({ key: 'skip', label: 'Skip this month', icon: <SkipForward aria-hidden />, after: 'dialog', onSelect: () => onSkip(item) })
      }
      if (item.savingsId && onArchive) {
        tail.push({ key: 'archive', label: 'Archive jar', icon: <Archive aria-hidden />, after: 'dialog', onSelect: () => onArchive(item) })
      }
      if (tail.length > 0) tail[0] = { ...tail[0], separatorBefore: actions.length > 0 }
      actions.push(...tail)
    } else if (onDelete) {
      actions.push({
        key: 'delete',
        label: 'Delete',
        icon: <Trash2 aria-hidden />,
        danger: true,
        separatorBefore: actions.length > 0,
        onSelect: () => onDelete(item.id),
      })
    }
  }

  // A jar line's menu (and sheet) says what the jar holds: the line itself no longer does, as
  // the shelf shows it.
  const jarNote =
    kind === 'jar'
      ? item.savingsAvailableMinor !== null
        ? `${money(item.savingsAvailableMinor)} in the jar`
        : 'Balance not available'
      : null

  // Two lines may share a name (each earner's "Take-home pay"): the earner tells them apart in
  // the names of the line's controls, as the "· Alex" after the name does on screen.
  const earner = kind === 'income' && showMember && member ? member.name : null
  const lineLabel = earner ? `${item.name} (${earner})` : item.name

  // ---- Leading icon ----------------------------------------------------------------------------
  const icon =
    kind === 'income' ? (
      showMember && member ? (
        <MemberAvatar name={member.name} hue={memberHue(memberIndex)} />
      ) : (
        <Tile hue="emerald">
          <Wallet strokeWidth={1.8} />
        </Tile>
      )
    ) : kind === 'jar' ? (
      <Tile hue={hue}>
        <JarNavIcon strokeWidth={1.8} />
      </Tile>
    ) : (
      // No category icons in the data: one glyph per kind of line (a bill, a spending line).
      <Tile hue={hue}>{isBill ? <ReceiptText strokeWidth={1.8} /> : <ShoppingBag strokeWidth={1.8} />}</Tile>
    )

  // ---- Name ------------------------------------------------------------------------------------
  const savingDot = saving && (
    <span role="img" aria-label="Saving" className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand-500" />
  )
  const memberSuffix = kind === 'income' && showMember && item.memberId && (
    // Pulled back over the name field's inner padding and border and the row's gap, so it reads
    // "Take-home pay · Alex", a space apart.
    <span className={`shrink-0 text-sm font-medium text-slate-500 ${canRename && !phone ? '-ml-2.5' : ''}`}>
      · {member?.name ?? 'Assigned'}
    </span>
  )
  const nameInput = (
    <AutoWidthInput
      inputRef={setNameInputEl}
      value={name}
      aria-label={kind === 'income' ? 'Income source name' : `Rename ${item.name}`}
      autoFocus={phone && mode === 'rename'}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        setRenameFromMenu(false)
        if (skipCommit.current) skipCommit.current = false
        else commitName()
        if (mode === 'rename') setMode('idle')
      }}
      onKeyDown={(e) => {
        const trigger = renameFromMenu
          ? rowRef.current?.querySelector<HTMLElement>('[data-row-trigger]')
          : null
        if (e.key === 'Enter') {
          if (mode === 'rename' || trigger) {
            // No keypress after this keydown: it would reach the line or the ⋯ (focused by then)
            // and open it.
            e.preventDefault()
            if (mode === 'rename') refocus.current = 'trigger'
          }
          ;(e.target as HTMLInputElement).blur()
          trigger?.focus()
        }
        if (e.key === 'Escape') {
          setName(item.name)
          if (mode === 'rename') closeEditor()
          else if (trigger) {
            skipCommit.current = true
            trigger.focus()
          }
        }
      }}
      className={`text-sm font-semibold text-slate-900 ${phone ? 'relative z-10' : ''}`}
    />
  )

  const sheetDescription =
    kind === 'jar'
      ? `${jarNote}${item.isSkipped ? ' · Skipped this month' : ''}`
      : kind === 'income'
        ? `${money(item.plannedMinor)} planned · ${money(item.actualMinor)} received`
        : `${money(item.plannedMinor)} planned · ${money(item.actualMinor)} spent`

  let nameEl: ReactNode
  if (canRename && (!phone || mode === 'rename')) {
    nameEl = nameInput
  } else if (phone && actions.length > 0) {
    // The whole line is the button (its ::after covers the row); the editors sit above it.
    nameEl = (
      <ActionSheet
        title={earner ? `${item.name} · ${earner}` : item.name}
        description={sheetDescription}
        actions={actions}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      >
        {/* The ring is drawn around the whole row (the ::after); `!` beats the app-wide
            :focus-visible outline, which is not in a layer. */}
        <button
          type="button"
          data-row-trigger=""
          aria-label={earner ? lineLabel : undefined}
          className="min-w-0 truncate text-left text-sm font-semibold text-slate-900 after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
        >
          {item.name}
        </button>
      </ActionSheet>
    )
  } else {
    nameEl = <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{item.name}</span>
  }

  // ---- Status ----------------------------------------------------------------------------------
  let status: ReactNode = null
  // Words for screen readers only, when the line shows no status (a jar line that is complete).
  let srStatus: ReactNode = null
  if (mode === 'bill' && canWrite && onSetBill) {
    status = (
      <span className="relative z-10 flex items-center gap-1">
        <span aria-hidden className="mr-1 shrink-0 text-[13px] whitespace-nowrap text-slate-500">
          Due day
        </span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoFocus
          {...selectOnFocusProps}
          value={billDraft}
          aria-label={`Due day for ${item.name}`}
          onChange={(e) => setBillDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault() // see refocus: the Enter must not also press the ⋯
              refocus.current = 'trigger'
              commitBill()
            }
            if (e.key === 'Escape') {
              closeEditor()
              setBillDraft(item.dueDay?.toString() ?? '')
            }
          }}
          className="h-8 w-14 rounded-md border border-input bg-surface px-2 text-sm tabular-nums focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            refocus.current = 'trigger'
            commitBill()
          }}
          aria-label={`Save due day for ${item.name}`}
          className="grid size-8 place-items-center rounded-md text-brand-700 hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"
        >
          <Check aria-hidden className="size-4" />
        </button>
        {item.dueDay !== null && (
          <button
            type="button"
            onClick={() => {
              closeEditor()
              onSetBill(item.id, null)
            }}
            aria-label={`Remove bill from ${item.name}`}
            className="grid size-8 place-items-center rounded-md text-slate-500 hover:bg-bad-bg hover:text-bad"
          >
            <X aria-hidden className="size-4" />
          </button>
        )}
      </span>
    )
  } else if (mode === 'member' && canWrite && onSetMember) {
    status = (
      <select
        autoFocus
        value={item.memberId ?? ''}
        aria-label={`Who earns ${item.name}`}
        onChange={(e) => {
          onSetMember(item.id, e.target.value || null)
          closeEditor()
        }}
        onBlur={() => setMode('idle')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeEditor()
        }}
        className="relative z-10 h-8 max-w-full rounded-md border border-input bg-surface px-2 text-sm text-slate-700 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
      >
        <option value="">Whole household</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    )
  } else if (kind === 'expense') {
    const remaining = itemRemaining(item)
    const over = remaining < 0
    const spentText = (
      <span className="sr-only">
        {money(item.actualMinor)} of {money(item.plannedMinor)} spent
      </span>
    )
    // Beside a bar it keeps its column; after a bill's chip it simply follows.
    const overText = (column: boolean) => over && <span className={`${column ? LEFT : LEFT_TEXT} text-bad`}>{money(-remaining)} over</span>
    // Rule 39: a refund nets off the line in the month it arrives; say so, or a net figure below
    // the purchases reads as a mistake.
    const refunded = item.refundedMinor > 0 && (
      <span className="text-xs whitespace-nowrap text-slate-500 tabular-nums">{money(item.refundedMinor)} refunded</span>
    )
    if (isBill) {
      const chip = item.isPaid ? (
        <StatusChip tone="ok">
          <Check aria-hidden strokeWidth={2.4} />
          Paid
        </StatusChip>
      ) : billStatus === 'overdue' ? (
        // The day it was due, so every role (also those without the due-day editor) can see it.
        <StatusChip tone="bad">Overdue{dueDate ? ` · ${dueDate}` : ''}</StatusChip>
      ) : (
        <StatusChip tone={billStatus === 'due-soon' ? 'warn' : 'line'}>Due {dueDate}</StatusChip>
      )
      status = (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {chip}
          {overText(false)}
          {refunded}
          {spentText}
        </span>
      )
    } else {
      const pct = item.plannedMinor > 0 ? (item.actualMinor / item.plannedMinor) * 100 : 0
      status = (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <MiniBar pct={over ? 100 : pct} hue={hue} over={over} className="flex-1" />
          {overText(true) || <span className={`${LEFT} text-slate-500`}>{money(remaining)} left</span>}
          {refunded}
          {spentText}
        </span>
      )
    }
  } else if (kind === 'income') {
    const received = item.plannedMinor > 0 && item.actualMinor >= item.plannedMinor
    status = received ? (
      <StatusChip tone="ok">
        <Check aria-hidden strokeWidth={2.4} />
        Received
      </StatusChip>
    ) : (
      <StatusChip tone="line">{money(item.actualMinor)} in</StatusChip>
    )
  } else if (item.isSkipped) {
    status = (
      <span className="flex items-center gap-1.5">
        <StatusChip tone="neutral">Skipped</StatusChip>
        {/* Above the phone line's full-row tap target, so the (i) is its own button there too. */}
        <InfoHint
          label={`Why ${item.name} is skipped`}
          className="relative z-10"
          align={phone ? 'center' : 'start'}
          buttonClassName="relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
        >
          This month’s contribution was skipped; the rest of the plan was spread over the months that are left.
        </InfoHint>
      </span>
    )
  } else if (jar && item.plannedMinor > 0) {
    // Rule 14: the plan stays as planned; what went into the jar this month and what is still to
    // go come from the jar's own postings (spending from the jar moves its balance, not these).
    // Once the month's contribution is in, the line shows nothing more (as in the mock-up): a
    // full bar beside "€0.00 to go" would say one thing twice, and a full bar means "all spent"
    // on a spending line.
    const contributed = fromAmount(jar.contributedThisMonth)
    const toGo = fromAmount(jar.remainingThisMonth)
    const inOf = (
      <span className="sr-only">
        {money(contributed)} in of {money(item.plannedMinor)}
      </span>
    )
    if (toGo > 0) {
      status = (
        <span className="flex items-center gap-3">
          <MiniBar pct={(contributed / item.plannedMinor) * 100} hue={hue} className="flex-1" />
          <span className={`${LEFT} text-slate-500`}>{money(toGo)} to go</span>
          {inOf}
        </span>
      )
    } else {
      srStatus = inOf
    }
  }

  // ---- Planned ---------------------------------------------------------------------------------
  let planned: ReactNode
  if (mode === 'planned' && canEditPlanned) {
    planned = (
      <span className="relative z-10 inline-flex items-center justify-end gap-1.5">
        <span aria-hidden className="text-sm text-slate-500">
          {currencySymbol(currency)}
        </span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          {...selectOnFocusProps}
          value={draft}
          aria-label={`Planned amount for ${item.name}`}
          aria-invalid={plannedError ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setMode('idle')
            commitPlanned()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // No keypress after this keydown: it would press the control focus returns to.
              e.preventDefault()
              refocus.current = plannedFrom
              ;(e.target as HTMLInputElement).blur()
            }
            if (e.key === 'Escape') {
              setDraft(toEditString(item.plannedMinor))
              closeEditor(plannedFrom)
              setPlannedError(null)
            }
          }}
          className="h-8 w-full max-w-[72px] min-w-0 rounded-md border border-brand-500 bg-surface px-1.5 text-right text-sm font-semibold text-slate-900 tabular-nums focus:ring-2 focus:ring-brand-500/30 focus:outline-none"
        />
      </span>
    )
  } else if (canEditPlanned && !phone) {
    planned = (
      <button
        type="button"
        data-planned-button=""
        onClick={() => openPlanned('planned')}
        className="-mr-1.5 rounded-md px-1.5 py-0.5 text-sm font-semibold text-slate-900 tabular-nums transition hover:bg-surface-2 dark:hover:bg-foreground/7"
      >
        {/* "Planned amount for Rent: €1,100.00", the amount shown inside the spoken name. */}
        <span className="sr-only">Planned amount for {item.name}:</span> {money(item.plannedMinor)}
      </button>
    )
  } else {
    planned = (
      <span
        data-testid={canEditPlanned ? undefined : `planned-${item.name}`}
        className="text-sm font-semibold whitespace-nowrap text-slate-900 tabular-nums"
      >
        {money(item.plannedMinor)}
      </span>
    )
  }

  const hasMenu = !phone && actions.length > 0
  const twoLine = status !== null
  const cols = `${hasMenu ? 'grid-cols-[30px_minmax(0,1fr)_auto_auto]' : 'grid-cols-[30px_minmax(0,1fr)_auto]'} ${
    phone
      ? // The status column outweighs the name's, so a bar keeps its length on a laptop-wide card.
        '@min-[500px]:grid-cols-[30px_minmax(0,1fr)_minmax(0,1.25fr)_88px]'
      : '@min-[500px]:grid-cols-[30px_minmax(0,1fr)_minmax(0,1.25fr)_88px_32px]'
  }`

  return (
    <div
      ref={rowRef}
      className={`group relative grid items-center gap-x-3 py-[11px] not-first:border-t not-first:border-line @min-[500px]:min-h-14 @min-[500px]:gap-x-3.5 @min-[500px]:py-2.5 ${cols}`}
    >
      <div className={`col-start-1 row-start-1 self-center ${twoLine ? 'row-span-2 @min-[500px]:row-span-1' : ''}`}>{icon}</div>
      <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        {nameEl}
        {memberSuffix}
        {savingDot}
        {srStatus}
      </div>
      {status !== null && (
        <div className="col-[2/-1] row-start-2 mt-[7px] min-w-0 @min-[500px]:col-[3/4] @min-[500px]:row-start-1 @min-[500px]:mt-0">
          {status}
        </div>
      )}
      <div className="col-start-3 row-start-1 flex justify-end text-right @min-[500px]:col-start-4">{planned}</div>
      {hasMenu && (
        <div className="col-start-4 row-start-1 flex justify-end @min-[500px]:col-start-5">
          <RowMenu
            label={`${lineLabel}: more actions`}
            actions={actions}
            note={jarNote}
            triggerClassName="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </div>
      )}
      {plannedError && (
        <p role="alert" className="col-[2/-1] mt-1 text-xs text-bad">
          {plannedError}
        </p>
      )}
    </div>
  )
}
