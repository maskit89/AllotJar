import { Fragment, memo, type ReactNode } from 'react'
import { ArrowLeftRight, CalendarCheck, Pencil, Plus, ReceiptText, ShoppingBag, Split, Trash2, Undo2, Wallet } from 'lucide-react'
import { CommitSelect } from '../CommitSelect'
import { InfoHint } from '../InfoHint'
import { StatusChip } from '../StatusChip'
import { ActionSheet, RowMenu, type RowAction } from '../RowActions'
import { JarNavIcon } from '../icons'
import { AssignChip, CategoryChip, FILL_CHIP, NEUTRAL, TxTile } from './TxParts'
import type { TransactionDto } from '../../types'
import { TransactionType } from '../../types'
import { currencySymbol, formatMoney, formatPlain, fromAmount } from '../../lib/money'
import { dayHeading, formatDate, monthYear, shortDate } from '../../lib/dates'
import { hueColor, type CategoryHue } from '../../lib/categoryColors'
import { transactionTypeLabel, type ItemOptionGroup } from '../../lib/transactions'
import { PRIVATE_ACCOUNT } from '../../lib/accountHolders'
import { formatForeign } from '../../lib/conversion'

/*
 * The Transactions list's days and rows (restyle PR 5), memoised: a keystroke in an inline editor
 * or in the search re-renders the page, and only the day holding the row being edited (and in it,
 * that row) renders again. The page owns every state and action; a row reports what was chosen
 * through `ctx.dispatch`, and the row's inline editors come in as nodes (`editForm`, `legEditor`,
 * `below`).
 */

/** What a row asks the page to do. */
export type TxRowEvent =
  | {
      type: 'edit' | 'edit-transfer' | 'split' | 'refund' | 'not-refund' | 'leg' | 'delete' | 'assign' | 'assign-escape' | 'assign-blur' | 'fx'
      t: TransactionDto
    }
  /** A line chosen in the revealed select; `blur`: chosen by leaving the select (focus stays where it went). */
  | { type: 'assign-pick'; t: TransactionDto; budgetItemId: string | null; blur?: boolean }
  | { type: 'sheet'; t: TransactionDto; open: boolean }

/** What every row shares; the page keeps it one object (memoised) so the rows can skip a render. */
export interface TxRowContext {
  canEnterData: boolean
  budgetCurrency: string
  /** Budget line → its category's hue (the Dashboard's colours). */
  itemHue: Record<string, CategoryHue>
  /** Budget lines that are bills (have a due day). */
  billItemIds: Set<string>
  /** Whether the line is a jar's savings line whose money sits in the paying account. */
  isJarLineFor: (budgetItemId: string | null | undefined, accountId: string | null | undefined) => boolean
  incomeOptions: ItemOptionGroup[]
  expenseOptions: ItemOptionGroup[]
  /** Stable: the page reads its latest state when it runs. */
  dispatch: (event: TxRowEvent) => void
}

/**
 * When an assigned transaction is budgeted to a line in a *different* month than its own date
 * (e.g. a 31 Jan purchase budgeted to a February line), returns a compact "Feb 2026"-style label
 * for that line's month, for the row's note. Returns null when the transaction is unassigned, the
 * line's month wasn't loaded, or the months already match.
 */
function budgetedToLabel(t: TransactionDto): string | null {
  if (!t.budgetItemId || t.budgetItemYear == null || t.budgetItemMonth == null) return null
  const txYear = Number(t.date.slice(0, 4))
  const txMonth = Number(t.date.slice(5, 7))
  if (t.budgetItemYear === txYear && t.budgetItemMonth === txMonth) return null
  return monthYear(`${t.budgetItemYear}-${String(t.budgetItemMonth).padStart(2, '0')}-01`)
}

/** A refund row's note: which purchase the money came back from. */
function refundOfLabel(t: TransactionDto): string | null {
  if (!t.refundOfTransactionId) return null
  const who = t.refundOfPayee || 'a purchase'
  return t.refundOfDate ? `Refund of ${who} · ${shortDate(t.refundOfDate)}` : `Refund of ${who}`
}

type JarPosting = { jarName: string | null; amount: number }
const jarName = (a: JarPosting) => a.jarName ?? 'a jar'
const jarWithAmount = (a: JarPosting) => `${jarName(a)} ${formatPlain(fromAmount(Math.abs(a.amount)))}`

/**
 * The compact description of a stored jar split (rules 78/79), for the desktop row's chips: "→
 * Holiday 300.00, Car 200.00" for money put into jars, "from Holiday" for money drawn from one jar
 * (with the amounts when it came from several). Empty when the leg follows the default.
 */
function jarSplitLabels(t: TransactionDto): string[] {
  const postings = (t.jarAllocations ?? []).filter((a) => a.jarId)
  const out = postings.filter((a) => a.amount < 0)
  const into = postings.filter((a) => a.amount > 0)
  const labels: string[] = []
  if (out.length === 1) labels.push(`from ${jarName(out[0])}`)
  else if (out.length > 1) labels.push(`from ${out.map(jarWithAmount).join(', ')}`)
  if (into.length > 0) labels.push(`→ ${into.map(jarWithAmount).join(', ')}`)
  return labels
}

/** The same jar split in words, for a phone row's note (a phone's second line has no room for it). */
function jarSplitNotes(t: TransactionDto): string[] {
  const postings = (t.jarAllocations ?? []).filter((a) => a.jarId)
  const out = postings.filter((a) => a.amount < 0)
  const into = postings.filter((a) => a.amount > 0)
  const notes: string[] = []
  if (out.length === 1) notes.push(`From jar: ${jarName(out[0])}`)
  else if (out.length > 1) notes.push(`From jars: ${out.map(jarWithAmount).join(', ')}`)
  if (into.length > 0) notes.push(`${into.length === 1 ? 'Into jar' : 'Into jars'}: ${into.map(jarWithAmount).join(', ')}`)
  return notes
}

/** What a transfer's status means, in words (the ⋯ note; a chip has no room for it). */
function transferStatusNote(t: TransactionDto): string | null {
  if (t.transferStatus === 'InTransit') {
    return `Left ${t.accountName ?? 'the source'} on ${formatDate(t.departedOn ?? t.date)}; receipt not yet confirmed.`
  }
  if (t.transferStatus === 'Returned') return `Sent back to ${t.accountName ?? 'the source'} on ${formatDate(t.returnedOn ?? t.date)}.`
  if (t.transferStatus === 'PendingReview') {
    return `Received by ${t.transferAccountName ?? 'the destination'} on ${formatDate(t.receivedOn ?? t.date)}; departure date unknown, so nothing is posted until it is supplied.`
  }
  return null
}

/** The ⋯ shows while the row is hovered or holds focus (and always on a touch screen), as on the Dashboard. */
const HOVER_TRIGGER =
  'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'

/** An (i) in a row, as on the Dashboard's cards: a 22px target, the icon at 15px. */
const ROW_HINT =
  "relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"

/** A chip that gives way first when its line is short of room: it truncates, at most its cell wide. */
const GIVES_WAY = 'max-w-full min-w-0 shrink!'

export interface TxRowProps {
  t: TransactionDto
  phone: boolean
  ctx: TxRowContext
  /** The id of the row's day header, which (with the amount) describes the row's ⋯ or row button. */
  dayId: string
  /** A write on this row is in flight. */
  saving: boolean
  /** The row's line picker is open. */
  assigning: boolean
  /** The row's phone action sheet is open. */
  sheetOpen: boolean
  /** The row's transfer-leg editor (in the row, under its line). */
  legEditor?: ReactNode
  /** The row's edit form, which takes the row's place while it is open. */
  editForm?: ReactNode
  /** Editors under the row (the refund link, the split editor). */
  below?: ReactNode
}

export const TxRow = memo(function TxRow({ t, phone, ctx, dayId, saving, assigning, sheetOpen, legEditor, editForm, below }: TxRowProps) {
  const { canEnterData, budgetCurrency, itemHue, billItemIds, isJarLineFor, dispatch } = ctx
  const name = t.payee || t.date
  const payeeText = t.payee || (t.type === TransactionType.Transfer ? 'Transfer' : '—')
  const isIncome = transactionTypeLabel(t.type) === 'Income'
  const isTransfer = t.type === TransactionType.Transfer
  const isRefund = !!t.refundOfTransactionId
  // A transfer's fee row: changed through its transfer, never on its own (it can still be put on a line).
  const isFeeRow = !!t.feeForTransferId
  const hasRefunds = (t.refundCount ?? 0) > 0
  const editing = !!editForm
  const legOpen = !!legEditor
  // Only lines the server accepts for the direction: a refund follows its purchase onto
  // expense/savings lines (rule 38), other income goes on income lines.
  const rowOptions = isRefund || t.type !== TransactionType.Income ? ctx.expenseOptions : ctx.incomeOptions
  // W13 (P56/P57): an entry in someone else's private account is theirs to change. The others
  // may only confirm the leg on the shared side of a transfer with a private account, the
  // receipt into it or the departure out of it.
  const rowEditable = canEnterData && !t.inPrivateAccount
  const canConfirmVisibleLeg =
    canEnterData &&
    !!t.inPrivateAccount &&
    ((t.transferStatus === 'InTransit' && t.accountName === PRIVATE_ACCOUNT) ||
      (t.transferStatus === 'PendingReview' && t.transferAccountName === PRIVATE_ACCOUNT))
  const legPending = t.transferStatus === 'PendingReview'
  const legMissing = isTransfer && (t.transferStatus === 'InTransit' || legPending)
  const hue = t.budgetItemId ? itemHue[t.budgetItemId] : undefined
  const lineColor = hue ? hueColor(hue) : NEUTRAL
  const jarLine = !isTransfer && isJarLineFor(t.budgetItemId, t.accountId)
  const isBill = !isTransfer && !!t.budgetItemId && billItemIds.has(t.budgetItemId)
  const budgetedTo = isTransfer ? null : budgetedToLabel(t)
  const splitText = t.isSplit
    ? t.splits
        .map((s) => `${s.budgetItemName ?? 'Unassigned'}${s.memberName ? ` (${s.memberName})` : ''} ${formatMoney(fromAmount(s.amount), t.currency)}`)
        .join(' · ')
    : ''
  // What the row's ⋯ and its phone row button are described by: the day and the amount.
  const amountId = `tx-amt-${t.id}`
  const describedBy = `${dayId} ${amountId}`

  // ---- The row's actions: the ⋯ menu (desktop) and the phone sheet, one list --------------------
  const actions: RowAction[] = []
  if (rowEditable && !isFeeRow) {
    if (isTransfer) {
      actions.push({
        key: 'edit-transfer',
        label: 'Edit transfer',
        ariaLabel: `Edit transfer: ${name}`,
        icon: <Pencil aria-hidden />,
        after: 'dialog',
        onSelect: () => dispatch({ type: 'edit-transfer', t }),
      })
    } else {
      actions.push({ key: 'edit', label: 'Edit', ariaLabel: `Edit transaction: ${name}`, icon: <Pencil aria-hidden />, after: 'focus', onSelect: () => dispatch({ type: 'edit', t }) })
      // A refund's whole amount reduces one line; it is never split (rule 38).
      if (!isRefund) {
        actions.push({ key: 'split', label: 'Split', ariaLabel: `Split transaction: ${name}`, icon: <Split aria-hidden />, after: 'focus', onSelect: () => dispatch({ type: 'split', t }) })
      }
      // Rules 38/39: money received can be marked as a refund of a purchase, and back.
      if (isRefund) {
        actions.push({
          key: 'not-refund',
          label: 'Not a refund',
          ariaLabel: `Not a refund: ${name}`,
          icon: <Undo2 aria-hidden />,
          disabled: saving,
          onSelect: () => dispatch({ type: 'not-refund', t }),
        })
      } else if (isIncome && !t.isSplit) {
        actions.push({
          key: 'refund',
          label: 'Mark as refund',
          ariaLabel: `Mark as refund: ${name}`,
          icon: <Undo2 aria-hidden />,
          after: 'focus',
          onSelect: () => dispatch({ type: 'refund', t }),
        })
      }
    }
  }
  if ((rowEditable || canConfirmVisibleLeg) && legMissing && !legOpen) {
    const label = legPending ? 'Add departure date' : 'Confirm receipt'
    actions.push({
      key: 'leg',
      label,
      ariaLabel: `${label}: ${name}`,
      icon: <CalendarCheck aria-hidden />,
      after: 'focus',
      onSelect: () => dispatch({ type: 'leg', t }),
    })
  }
  if (rowEditable && !isFeeRow) {
    // Straight away, as before: no confirmation (deleting a transfer also drops its fee row).
    actions.push({
      key: 'delete',
      label: 'Delete',
      ariaLabel: `Delete transaction: ${name}`,
      icon: <Trash2 aria-hidden />,
      danger: true,
      separatorBefore: actions.length > 0,
      disabled: saving,
      onSelect: () => dispatch({ type: 'delete', t }),
    })
  }

  // ---- What the row has no room to say: the ⋯ note, the sheet's line, or an (i) ----------------
  // Only what needs attention or would otherwise be misread is a chip in the row (In transit,
  // Pending review, Returned, Bill); a refund's purchase, a fee row and a line in another month
  // are said here.
  const notes: string[] = []
  if (isRefund) notes.push(refundOfLabel(t) ?? 'Refund')
  if (hasRefunds) {
    const n = t.refundCount ?? 0
    notes.push(`${formatMoney(fromAmount(t.refundedAmount ?? 0), budgetCurrency)} refunded${n > 1 ? ` (${n} refunds)` : ''}`)
  }
  if (budgetedTo) notes.push(`Budgeted to a ${budgetedTo} line, not this transaction’s own month.`)
  const statusNote = isTransfer ? transferStatusNote(t) : null
  if (statusNote) notes.push(statusNote)
  if (isTransfer && t.fee != null && t.fee > 0) notes.push(`Fee on ${t.feeBudgetItemName ?? 'no budget line'}.`)
  if (isFeeRow) notes.push('A transfer’s fee: edit the transfer to change it.')
  // A phone's second line holds the category and the account only: the slices (which truncate
  // there) and the jar split are said in full here.
  if (phone && t.isSplit) notes.push(`Split: ${splitText}`)
  if (phone) notes.push(...jarSplitNotes(t))
  if (!t.fxPending && t.budgetAmount != null) {
    notes.push(`The account keeps its ${t.currency} amount; the budget counts it in ${budgetCurrency}.`)
  }
  if (t.fxPending) notes.push(`In another currency: not counted anywhere until it has its ${budgetCurrency} amount.`)
  const note: ReactNode =
    notes.length > 0 ? (
      <>
        {notes.map((line, i) => (
          // The space keeps the lines apart in what a screen reader reads.
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className={phone ? 'block' : 'block max-w-[240px] text-balance'}>{line}</span>
          </Fragment>
        ))}
      </>
    ) : undefined
  const rowHint = note && (
    <InfoHint label={`About ${name}`} buttonClassName={ROW_HINT} align={phone ? 'center' : 'end'}>
      {note}
    </InfoHint>
  )

  // ---- Icon: one glyph per kind of row (no category icons in the data), in the line's colour ----
  const splitColor = t.isSplit && t.splits[0]?.budgetItemId && itemHue[t.splits[0].budgetItemId]
  const tile = isTransfer ? (
    <TxTile color={hueColor('teal')}>
      <ArrowLeftRight strokeWidth={1.8} />
    </TxTile>
  ) : isIncome && !isRefund ? (
    <TxTile color={hueColor('emerald')}>
      <Wallet strokeWidth={1.8} />
    </TxTile>
  ) : (
    <TxTile color={t.isSplit ? (splitColor ? hueColor(splitColor) : NEUTRAL) : lineColor}>
      {isRefund ? (
        <Undo2 strokeWidth={1.8} />
      ) : jarLine ? (
        <JarNavIcon strokeWidth={1.8} />
      ) : isBill ? (
        <ReceiptText strokeWidth={1.8} />
      ) : (
        <ShoppingBag strokeWidth={1.8} />
      )}
    </TxTile>
  )

  // ---- Payee, with the "Bill" chip when the row pays a bill (as in the mock-up) ----------------
  const tags = isBill && <StatusChip tone="line">Bill</StatusChip>
  const payee =
    phone && actions.length > 0 ? (
      // The whole row is the button (its ::after covers the row); the chips sit above it.
      <ActionSheet
        title={payeeText}
        description={note}
        actions={actions}
        open={sheetOpen}
        onOpenChange={(open) => dispatch({ type: 'sheet', t, open })}
      >
        <button
          type="button"
          data-row-trigger=""
          aria-describedby={describedBy}
          className="min-w-0 truncate text-left text-sm font-semibold text-slate-900 after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:-outline-offset-1 focus-visible:after:outline-ring"
        >
          {payeeText}
        </button>
      </ActionSheet>
    ) : (
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{payeeText}</span>
    )

  // ---- Category: the chip in the line's colour, "+ Assign", the split, the transfer ------------
  // A transfer's state, when it has one: the chips that ask for something (a leg to confirm), and
  // Returned, without which the row would read as money that reached the other account. The
  // titles say the dates for a pointer; the ⋯ note says them for everyone. In a narrow column a
  // chip truncates (its title and the note keep the words) rather than spill into the next cell; on
  // a phone it keeps its words and the account beside it gives way.
  const statusGivesWay = phone ? undefined : GIVES_WAY
  const statusChip = !isTransfer ? null : t.transferStatus === 'Returned' ? (
    <StatusChip tone="line" className={statusGivesWay} title={`Sent back to ${t.accountName ?? 'the source'} on ${formatDate(t.returnedOn ?? t.date)}`}>
      <span className="min-w-0 truncate">Returned</span>
    </StatusChip>
  ) : t.transferStatus === 'InTransit' ? (
    <StatusChip
      tone="line"
      className={statusGivesWay}
      title={`Left ${t.accountName ?? 'the source'} on ${formatDate(t.departedOn ?? t.date)}; receipt not yet confirmed`}
    >
      <span className="min-w-0 truncate">In transit</span>
    </StatusChip>
  ) : t.transferStatus === 'PendingReview' ? (
    <StatusChip
      tone="warn"
      className={statusGivesWay}
      title={`Received by ${t.transferAccountName ?? 'the destination'} on ${formatDate(t.receivedOn ?? t.date)}; departure date unknown — nothing is posted until it is supplied`}
    >
      <span className="min-w-0 truncate">Pending review</span>
    </StatusChip>
  ) : null
  let category: ReactNode
  if (isTransfer) {
    category = (
      <>
        <StatusChip tone="line">
          <ArrowLeftRight aria-hidden strokeWidth={2} />
          Transfer
        </StatusChip>
        {statusChip}
      </>
    )
  } else if (t.isSplit) {
    // One line, as in the mock-up: the slices truncate (the title, and a phone's note, hold them all).
    category = (
      <StatusChip tone="line" className={GIVES_WAY} title={`Split: ${splitText}`}>
        <Split aria-hidden strokeWidth={2} />
        <span className="sr-only">Split</span>
        <span className="sr-only">: </span>
        <span className="min-w-0 truncate">{splitText}</span>
      </StatusChip>
    )
  } else if (assigning && rowEditable) {
    category = (
      // Arrow keys move the choice; Enter, leaving the select or a pointer choice commits it, and
      // Escape closes it unchanged (#350 P3-1). A commit with no change only closes it.
      <CommitSelect
        autoFocus
        initial={t.budgetItemId ?? ''}
        disabled={saving}
        aria-label={`Assign ${t.payee || 'transaction'}`}
        onCommit={(value, how) =>
          (value || null) === (t.budgetItemId ?? null)
            ? dispatch({ type: how === 'blur' ? 'assign-blur' : 'assign-escape', t })
            : dispatch({ type: 'assign-pick', t, budgetItemId: value || null, blur: how === 'blur' })
        }
        onCancel={() => dispatch({ type: 'assign-escape', t })}
        className="relative z-10 h-8 w-56 max-w-full rounded-lg border border-input bg-surface px-2 text-sm text-slate-700 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none focus-visible:outline-none! disabled:opacity-50"
      >
        <option value="">Unassigned</option>
        {rowOptions.map((g) => (
          <optgroup key={g.category} label={g.category}>
            {g.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </optgroup>
        ))}
      </CommitSelect>
    )
  } else if (rowEditable) {
    // One button whichever way it looks, so focus stays on it when a save turns one into the other.
    category = (
      <AssignChip
        color={t.budgetItemId ? lineColor : undefined}
        line={jarLine}
        icon={jarLine ? <JarNavIcon strokeWidth={2} /> : undefined}
        label={t.budgetItemId ? t.budgetItemName : 'Assign'}
        aria-label={`${t.budgetItemId ? 'Reassign' : 'Assign'} ${t.payee || 'transaction'}`}
        onClick={() => dispatch({ type: 'assign', t })}
        className={phone ? 'z-10' : ''}
      />
    )
  } else if (t.budgetItemId) {
    category = (
      <CategoryChip color={lineColor} line={jarLine} icon={jarLine ? <JarNavIcon strokeWidth={2} /> : undefined}>
        {t.budgetItemName}
      </CategoryChip>
    )
  } else {
    category = <span className="text-[13px] text-slate-500">Unassigned</span>
  }
  // A stored jar split (rules 78/79): where this money went, or came from (a phone says it in the note).
  const jarChips = phone
    ? null
    : jarSplitLabels(t).map((label) => (
        <StatusChip key={label} tone="line" className={GIVES_WAY} title={`Jars: ${label}`}>
          <JarNavIcon aria-hidden strokeWidth={2} />
          <span className="min-w-0 truncate">{label}</span>
        </StatusChip>
      ))

  const accountText = isTransfer ? `${t.accountName ?? '—'} → ${t.transferAccountName ?? '—'}` : (t.accountName ?? '—')
  const account = (
    <span data-tx-account="" className={`truncate text-slate-400 ${phone ? 'min-w-10 shrink-[4] text-xs' : 'min-w-0 text-[13px]'}`}>
      {accountText}
    </span>
  )

  // ---- Amount: cents, the app's sign, money in green, a transfer muted --------------------------
  const sign = isTransfer ? '' : isIncome ? '+' : '−'
  const fxChip = t.fxPending && rowEditable && !t.isSplit
  const fxPendingTitle = `In another currency. Not counted anywhere until you enter the amount in ${budgetCurrency}.`
  const small = 'text-xs font-normal whitespace-nowrap text-slate-400 tabular-nums'
  const amount = (
    <div data-tx-amount="" className="flex min-w-0 flex-col items-end gap-[3px] text-right">
      {fxChip ? (
        <button
          type="button"
          data-fx-chip=""
          onClick={() => dispatch({ type: 'fx', t })}
          aria-label={`Enter amount in ${budgetCurrency}: ${t.payee || t.date}`}
          title={fxPendingTitle}
          className={`${FILL_CHIP} ${phone ? 'z-10' : ''}`}
        >
          <Plus aria-hidden strokeWidth={2} />
          {currencySymbol(budgetCurrency)} amount
        </button>
      ) : (
        <span
          id={amountId}
          className={`text-sm whitespace-nowrap tabular-nums ${
            isTransfer || t.fxPending ? 'font-semibold text-slate-500' : isIncome ? 'font-[650] text-ok' : 'font-[650] text-slate-900'
          }`}
        >
          {sign}
          {/* A row waiting for its budget-currency amount shows its own figure labelled with the
              code, so it never reads as budget money. */}
          {t.fxPending ? formatForeign(t.amount, t.currency) : formatMoney(fromAmount(t.amount), t.currency)}
        </span>
      )}
      {fxChip && (
        <span id={amountId} className={small}>
          {sign}
          {formatForeign(t.amount, t.currency)}
        </span>
      )}
      {t.fxPending && !fxChip && (
        <StatusChip tone="warn" title={fxPendingTitle}>
          Needs {budgetCurrency} amount
        </StatusChip>
      )}
      {!t.fxPending && t.originalCurrency && t.originalAmount != null && (
        <span className={small} title={`Paid in ${t.originalCurrency}`}>
          {formatForeign(t.originalAmount, t.originalCurrency)}
        </span>
      )}
      {!t.fxPending && t.budgetAmount != null && (
        <span className={small} title={`The account keeps its ${t.currency} amount; the budget counts this`}>
          Counts as {formatMoney(fromAmount(t.budgetAmount), budgetCurrency)}
        </span>
      )}
      {/* The fee that left the source on top of what arrived (its own row). */}
      {isTransfer && t.fee != null && t.fee > 0 && (
        <span className={small} title={`Fee on ${t.feeBudgetItemName ?? 'no budget line'}`}>
          + fee {formatPlain(fromAmount(t.fee))}
        </span>
      )}
    </div>
  )

  // ---- The ⋯ (desktop), or an (i) with the note where there are no actions ----------------------
  const more =
    actions.length > 0 ? (
      <RowMenu label={`${name}: more actions`} actions={actions} note={note} triggerClassName={HOVER_TRIGGER} describedBy={describedBy} />
    ) : (
      rowHint
    )

  // ---- The row: desktop one line (icon | payee | category | account | amount | ⋯); a phone two
  // lines (payee and amount, then the category and the account), the whole row one button.
  let row: ReactNode
  if (editing) {
    row = editForm
  } else if (phone) {
    row = (
      <>
        <div className="col-start-1 row-span-2 row-start-1 self-center">{tile}</div>
        <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-2">
          {payee}
          {tags}
          {actions.length === 0 && rowHint && <span className="relative z-10 inline-flex">{rowHint}</span>}
        </div>
        <div className="col-start-2 row-start-2 flex min-w-0 items-center gap-2">
          {isTransfer ? (
            <>
              {/* No Transfer chip on a phone (the tile and the accounts say it), but a screen reader is told. */}
              <span className="sr-only">Transfer</span>
              {statusChip}
              {account}
            </>
          ) : (
            <>
              {category}
              {/* No column to hold a "—" on a phone: a row with no account just leaves it out. */}
              {t.accountName && account}
            </>
          )}
        </div>
        <div className="col-start-3 row-span-2 row-start-1 self-center">{amount}</div>
        {legEditor}
      </>
    )
  } else {
    row = (
      <>
        {tile}
        <div className="flex min-w-0 items-center gap-2">
          {payee}
          {tags}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {category}
          {jarChips}
        </div>
        {account}
        {amount}
        <div className="flex justify-end">{more}</div>
        {legEditor}
      </>
    )
  }

  return (
    <li data-tx-id={t.id} className="not-first:border-t not-first:border-line">
      <div
        data-testid="tx-row"
        className={
          editing
            ? ''
            : phone
              ? 'group relative grid min-h-[60px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-[5px] py-[11px]'
              : // Under 1100px (the sidebar beside a narrow window) the quiet account column gives
                // the category room first.
                'group relative grid min-h-14 grid-cols-[30px_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.9fr)_120px_32px] items-center gap-x-3.5 py-3 max-[1099.98px]:grid-cols-[30px_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.7fr)_120px_32px] max-[1099.98px]:gap-x-3'
        }
      >
        {row}
      </div>
      {below}
    </li>
  )
})

/** The editors open on a row (the page builds them for the one row that has one). */
export interface TxRowEditors {
  legEditor?: ReactNode
  editForm?: ReactNode
  below?: ReactNode
}

/** Which rows are busy, and their editors: given only to the day that holds one of them. */
export interface TxDayState {
  savingId: string | null
  assigningId: string | null
  sheetFor: string | null
  editorsFor: (t: TransactionDto) => TxRowEditors | undefined
}

/** The day headers (the shared eyebrow: 12px uppercase, as the mock-ups' group and day headers). */
const DAY_HEADER = 'text-xs font-[650] tracking-[0.05em] text-slate-500 uppercase'

/**
 * One day of the list: its header ("Today", "Yesterday", "Tue 7 Oct") and its rows. `state` is null
 * for a day with nothing open or saving, so that day skips the page's renders.
 */
export const TxDay = memo(function TxDay({
  date,
  rows,
  phone,
  ctx,
  state,
}: {
  date: string
  rows: TransactionDto[]
  phone: boolean
  ctx: TxRowContext
  state: TxDayState | null
}) {
  // The day's id: each row's ⋯ (a phone's row button) is described by its day and amount.
  const dayId = `tx-day-${date}`
  return (
    <>
      <h2 id={dayId} className={`${DAY_HEADER} pt-[22px] pb-0.5 max-[699.98px]:pt-[18px] max-[699.98px]:pb-0`}>
        {dayHeading(date)}
      </h2>
      <ul>
        {rows.map((t) => {
          const editors = state?.editorsFor(t)
          return (
            <TxRow
              key={t.id}
              t={t}
              phone={phone}
              ctx={ctx}
              dayId={dayId}
              saving={state?.savingId === t.id}
              assigning={state?.assigningId === t.id}
              sheetOpen={state?.sheetFor === t.id}
              legEditor={editors?.legEditor}
              editForm={editors?.editForm}
              below={editors?.below}
            />
          )
        })}
      </ul>
    </>
  )
})
