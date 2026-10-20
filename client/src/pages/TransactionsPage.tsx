import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, Plus, Search, X } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, EmptyState, ErrorBanner, Input, SegmentedControl, Select } from '../components/ui'
import { ConvertedAmountModal } from '../components/ConvertedAmountModal'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { DASH_CARD } from '../components/budget/card'
import { TxDay, type TxDayState, type TxRowContext, type TxRowEvent } from '../components/transactions/TxRow'
import { Modal } from '../components/Modal'
import { TransactionsIcon } from '../components/icons'
import { useFeatures } from '../features/FeatureContext'
import { useMonth } from '../features/MonthContext'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { useMediaQuery } from '../lib/useMediaQuery'
import { EVENTS, track } from '../analytics'
import type {
  AccountDto,
  BudgetMonthDto,
  ConfirmTransferLegsRequest,
  ConversionSuggestionDto,
  CreateTransferRequest,
  DeleteTransactionResult,
  HouseholdMemberDto,
  TransactionDto,
  UpdateTransferRequest,
} from '../types'
import { TransactionType } from '../types'
import { formatMoney, formatPlain, fromAmount, parseMinor, sumMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { shortDate, todayIso } from '../lib/dates'
import { hueForIndex, type CategoryHue } from '../lib/categoryColors'
import { buildItemOptions, jarLinesOf, transactionTypeLabel } from '../lib/transactions'
import { SplitLinesEditor, SplitRemainderChip, type SplitRowDraft } from '../components/SplitLinesEditor'
import { appendSplitRow, patchSplitRow, removeSplitRowAt, startSplitRows } from '../lib/splitRows'
import { JarAllocationFields } from '../components/jars/JarAllocationFields'
import { PAID_FROM_UNALLOCATED, PaidFromJarSelect } from '../components/jars/PaidFromJarSelect'
import {
  activeJars,
  archivedJarMessage,
  archivedJarNamed,
  archivedJarNewlyNamed,
  incomingAllocationsOf,
  jarsForAnswer,
  namedJarIds,
  paidFromJarOf,
  storedSharesOf,
  useJarLedgers,
} from '../lib/jarLedgers'
import { fromJarAllocations, jarAllocationsProblem, toJarAllocations } from '../lib/jarAllocationFields'
import { crossMonthError, editConflict, serverErrors } from '../lib/serverErrors'
import { fetchConversionSuggestion, suggestionHint } from '../lib/conversion'

/**
 * The add form's third "type": a refund is money received (sent as Income) linked to the
 * purchase it comes back from (rules 38/39). UI-only — the API knows Expense/Income/Transfer.
 */
const ADD_REFUND = -1

/**
 * The jars a stored answer names on this account, so an archived jar it names stays offered
 * while the edit is open (it can be picked back after moving off it), and is sent back unchanged.
 */
function storedJarIds(t: TransactionDto | null | undefined, accountId: string | null | undefined, direction: 'in' | 'out'): string[] {
  return t && accountId ? [...storedSharesOf(t.jarAllocations, accountId, direction).keys()] : []
}

/**
 * Purchases a refund can point at: the user's expenses that are not themselves refunds, newest
 * first. A split purchase counts too, as on the server, but it has no single line for the refund
 * to follow: the user picks the refund's line (rule 39's netting shows on that line).
 */
function refundablePurchases(transactions: TransactionDto[]): TransactionDto[] {
  return transactions
    .filter((t) => t.type === TransactionType.Expense && !t.refundOfTransactionId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** The yyyy-MM key of a budget month, to compare against a date's first seven characters. */
function monthKeyOf(m: BudgetMonthDto): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`
}

/** A short hint beside a transfer form field whose value came from a bank statement. */
function StatementLockHint() {
  return <span className="font-normal text-slate-500">Confirmed by the bank statement</span>
}

/** Newest first, as the server sends them; a stable sort keeps the list's own order within a day (a new row first). */
function newestFirst(list: TransactionDto[]): TransactionDto[] {
  return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Whether a row matches the list's search: its payee (a transfer's note), its category or split lines, or its accounts. */
function matchesSearch(t: TransactionDto, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const fields = [
    t.payee,
    t.type === TransactionType.Transfer ? 'Transfer' : null,
    t.budgetItemName,
    ...t.splits.map((s) => s.budgetItemName),
    t.accountName,
    t.transferAccountName,
  ]
  return fields.some((f) => !!f && f.toLowerCase().includes(q))
}

/** The first of `selectors` found in `row`. */
function firstIn(row: HTMLElement | undefined, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const target = row?.querySelector<HTMLElement>(selector)
    if (target) return target
  }
  return null
}

/**
 * Where focus goes back to for the row `id`: the first of `targets` in it; when the row has gone
 * (deleted, or out of the filter) or has nothing to focus (someone else's private entry), the
 * nearest row after it that has a control, else the nearest before it (`order` is the list as it
 * was shown, to know where a row that has gone stood); with no row left, the list's filter, else
 * Add transaction.
 */
function focusTarget(id: string, targets: string[], order: TransactionDto[]): HTMLElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-tx-id]'))
  const own = rows.find((el) => el.dataset.txId === id)
  const target = firstIn(own, targets)
  if (target) return target
  let after = own ? rows.indexOf(own) + 1 : -1
  if (after < 0) {
    const at = new Map(rows.map((el, i) => [el.dataset.txId, i]))
    const from = order.findIndex((x) => x.id === id)
    for (let i = from + 1; i < order.length && after < 0; i++) after = at.get(order[i].id) ?? -1
    if (after < 0) after = rows.length
  }
  const before = own ? rows.indexOf(own) - 1 : after - 1
  const controls = ['[data-row-trigger]', '[data-assign-chip]']
  for (let i = after; i < rows.length; i++) {
    const el = firstIn(rows[i], controls)
    if (el) return el
  }
  for (let i = before; i >= 0; i--) {
    const el = firstIn(rows[i], controls)
    if (el) return el
  }
  return (
    document.querySelector<HTMLElement>('[aria-label="Filter transactions"] [aria-pressed="true"]') ??
    document.querySelector<HTMLElement>('button[aria-label="Add transaction"]')
  )
}

/** An inline editor's panel, inside the list card under (or in place of) its row. Each panel
 *  carries `data-entry`, so coming back to the app never reloads the page under it (appReturn). */
const EDITOR_PANEL = 'rounded-xl border border-slate-200/70 bg-surface-2 p-3 dark:bg-foreground/[0.03]'

/**
 * The small fields of the inline editors (the building blocks' Input and Select, a size down). The
 * field draws its own focus ring, so the global :focus-visible outline is dropped (no double ring).
 */
const FIELD = 'h-9 py-1.5 focus-visible:outline-none!'

/** The inline editors' buttons, as tall as their fields so each editor row lines up. */
const EDITOR_BUTTON = 'h-9'

export function TransactionsPage() {
  const features = useFeatures()
  // Recording/editing transactions is day-to-day entry (Limited+). Importing (Admin+) is reached
  // from the sidebar and the phone's More sheet, which offer it under the same rule.
  const { canEnterData, budgetCurrency } = useAuth()
  const [transactions, setTransactions] = useState<TransactionDto[]>([])
  const [month, setMonth] = useState<BudgetMonthDto | null>(null)
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [members, setMembers] = useState<HouseholdMemberDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The list could not be read: there is nothing to call empty (the alert says what happened).
  const [loadFailed, setLoadFailed] = useState(false)
  // What a saved edit or delete left for the user to settle, e.g. jars no longer backed by the
  // account's money (D10): the change stands, so this is a notice, not an error.
  const [notice, setNotice] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  // One prompt for every cross-month confirmation (assign, edit, split, add): the server
  // rejected under the `crossMonth` key; Confirm re-runs the same action acknowledged.
  const [crossMonthPrompt, setCrossMonthPrompt] = useState<
    { message: string; retry: () => void } | null
  >(null)

  // The Add transaction / transfer modal (opened from the toolbar's + button).
  const [showAdd, setShowAdd] = useState(false)
  // Add form: "transaction" (spend/receive) or "transfer" (move between accounts).
  const [mode, setMode] = useState<'transaction' | 'transfer'>('transaction')

  // Add-transaction form state.
  const [date, setDate] = useState(todayIso)
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [type, setType] = useState<number>(TransactionType.Expense)
  // The purchase a new refund comes back from (rules 38/39); only read when type is ADD_REFUND.
  const [refundOf, setRefundOf] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [account, setAccount] = useState('')
  const [member, setMember] = useState('')
  const [adding, setAdding] = useState(false)
  // Add-modal split mode: the expense is divided across 2+ budget lines at creation.
  const [addSplit, setAddSplit] = useState(false)
  const [addRows, setAddRows] = useState<SplitRowDraft[]>(() => startSplitRows())
  // "Paid in another currency": the foreign figure is kept for reference; the Amount above stays
  // the budget-currency amount the user confirms, and is the one that counts.
  const [paidForeign, setPaidForeign] = useState(false)
  const [fxCurrency, setFxCurrency] = useState('')
  const [fxAmount, setFxAmount] = useState('')
  const [fxSuggestion, setFxSuggestion] = useState<ConversionSuggestionDto | null>(null)
  const [fxSuggesting, setFxSuggesting] = useState(false)

  // The fxPending row whose amount in the budget currency is being entered.
  const [convertingId, setConvertingId] = useState<string | null>(null)

  // Transfer form state (a completed bank transfer between two of the user's own accounts).
  // tDate is the departure the user confirms; tReceived is optional — left blank, the money is
  // shown in transit until the receipt is confirmed on the register (rule 71).
  const [tDate, setTDate] = useState(todayIso)
  const [tReceived, setTReceived] = useState('')
  const [tConfirmed, setTConfirmed] = useState(false)
  const [tAmount, setTAmount] = useState('')
  const [tFrom, setTFrom] = useState('')
  const [tTo, setTTo] = useState('')
  const [tPayee, setTPayee] = useState('')
  const [transferring, setTransferring] = useState(false)
  // An optional fee on top of the transfer: extra money leaving the source on the departure
  // date, recorded as its own row on the chosen budget line ('' = uncategorised).
  const [tFee, setTFee] = useState('')
  const [tFeeLine, setTFeeLine] = useState('')
  // Editing a recorded transfer reuses the same form (PUT /transactions/{id}/transfer); null
  // while recording a new one. tReturned is the date the bank sent the money back, if it did.
  const [editingTransfer, setEditingTransfer] = useState<TransactionDto | null>(null)
  const [tReturned, setTReturned] = useState('')
  // Budget months other than the loaded one, fetched for a fee dated in them (null = none).
  const [feeMonths, setFeeMonths] = useState<Record<string, BudgetMonthDto | null>>({})

  // Inline leg confirmation on a transfer row: the receipt date for an in-transit transfer, or
  // the departure date for a receipt held for review.
  const [legId, setLegId] = useState<string | null>(null)
  const [legDate, setLegDate] = useState(todayIso)

  // Register filter — All or just Unassigned (the list card's segmented control).
  const [filter, setFilter] = useState<'all' | 'unassigned'>('all')
  // The list's search (restyle PR 5): narrows the rows already loaded, on the client. Null = closed.
  const [query, setQuery] = useState<string | null>(null)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  // The row whose phone action sheet is open.
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  // The top bar has room for Add transaction from 900px (AppShell's own breakpoint); below it the
  // button sits under the KPI row, as in the mock-up. Phones (the mock-ups' 700px breakpoint): a
  // row is one button that opens its actions in a bottom sheet.
  const desktop = useMediaQuery('(min-width: 900px)')
  const phone = useMediaQuery('(max-width: 699.98px)')
  // Where focus goes once an inline editor or a dialog it raised has closed: the first of
  // `targets` found in the row (its ⋯ or row button, its assign chip), so the user keeps their place.
  // When the row has gone (deleted, or out of the filter) or has no control, the nearest row that
  // has one: `order` is the list as it was shown when focus was asked for. `ifLost`: only when focus
  // has fallen to the page (a save that ended after the user moved on leaves focus where it is).
  const [pendingFocus, setPendingFocus] = useState<
    { id: string; targets: string[]; order: TransactionDto[]; ifLost?: boolean } | null
  >(null)
  // The rows on screen, as of the last render (set below, once `visible` is known).
  const visibleRef = useRef<TransactionDto[]>([])
  const refocusRow = useCallback(
    (id: string, targets: string[] = ['[data-row-trigger]'], ifLost = false) =>
      setPendingFocus({ id, targets, order: visibleRef.current, ifLost }),
    [],
  )

  // Which row is showing its inline category picker (the redesign's "+ Assign").
  const [assigningId, setAssigningId] = useState<string | null>(null)

  // Which income row is being marked as a refund, and the purchase picked for it (rules 38/39).
  const [refundingId, setRefundingId] = useState<string | null>(null)
  const [refundPick, setRefundPick] = useState('')

  // Inline edit state.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eDate, setEDate] = useState('')
  const [ePayee, setEPayee] = useState('')
  const [eAmount, setEAmount] = useState('')
  const [eType, setEType] = useState<number>(TransactionType.Expense)
  const [eAccount, setEAccount] = useState('')
  const [eMember, setEMember] = useState('')

  // Split editor state.
  const [splittingId, setSplittingId] = useState<string | null>(null)
  const [splitRows, setSplitRows] = useState<{ budgetItemId: string; amount: string; memberId: string }[]>([])

  // The jar prompts (rules 78/79): which accounts back jars, and each surface's answer. Every
  // answer defaults to "unallocated" (empty fields / no jar) and is reset when its account,
  // direction or line changes, so a stale jar id never rides along with a different account.
  const { ledgers, reload: reloadLedgers, loaded: ledgersLoaded } = useJarLedgers()
  const [addJarAlloc, setAddJarAlloc] = useState<Record<string, string>>({})
  const [addPaidFrom, setAddPaidFrom] = useState(PAID_FROM_UNALLOCATED)
  const [tFromJar, setTFromJar] = useState(PAID_FROM_UNALLOCATED)
  const [tJarAlloc, setTJarAlloc] = useState<Record<string, string>>({})
  const [eJarAlloc, setEJarAlloc] = useState<Record<string, string>>({})
  const [ePaidFrom, setEPaidFrom] = useState(PAID_FROM_UNALLOCATED)
  const [splitPaidFrom, setSplitPaidFrom] = useState(PAID_FROM_UNALLOCATED)
  const [legJarAlloc, setLegJarAlloc] = useState<Record<string, string>>({})
  const [legFromJar, setLegFromJar] = useState(PAID_FROM_UNALLOCATED)
  // "+ Assign" of a payment from a jar-backed account to a line that is not a jar asks which
  // jar it comes from before the assignment is saved (rule 79).
  const [paidFromPrompt, setPaidFromPrompt] = useState<
    { transaction: TransactionDto; budgetItemId: string; value: string } | null
  >(null)

  const ledgerOf = useCallback(
    (accountId: string | null | undefined) => (accountId ? ledgers.find((l) => l.accountId === accountId) : undefined),
    [ledgers],
  )
  const jarsOf = useCallback((accountId: string | null | undefined) => activeJars(ledgerOf(accountId)), [ledgerOf])
  // Budget line → the jar it is the savings line of, for this month's jar lines.
  const jarLines = useMemo(() => jarLinesOf(month), [month])
  /**
   * A line is a jar line for a payment when it is a jar's savings line AND that jar's money sits
   * in the paying account (the server's rule): the payment draws from that jar, so no prompt.
   */
  const isJarLineFor = useCallback(
    (budgetItemId: string | null | undefined, accountId: string | null | undefined) => {
      const jarId = budgetItemId ? jarLines.get(budgetItemId) : undefined
      return !!jarId && (ledgerOf(accountId)?.jars.some((j) => j.jarId === jarId) ?? false)
    },
    [jarLines, ledgerOf],
  )
  /** True when part of the payment sits on a line that is not a jar, so rule 79's prompt applies. */
  const hasNonJarLine = useCallback(
    (t: TransactionDto, accountId: string | null = t.accountId) =>
      t.isSplit
        ? t.splits.some((s) => !!s.budgetItemId && !isJarLineFor(s.budgetItemId, accountId))
        : !!t.budgetItemId && !isJarLineFor(t.budgetItemId, accountId),
    [isJarLineFor],
  )
  /** The jars named by the transaction's own lines (their portions never need the paid-from answer). */
  const lineJarIdsOf = useCallback(
    (t: TransactionDto) => {
      const ids = new Set<string>()
      for (const line of t.isSplit ? t.splits.map((s) => s.budgetItemId) : [t.budgetItemId]) {
        const jarId = line ? jarLines.get(line) : undefined
        if (jarId) ids.add(jarId)
      }
      return ids
    },
    [jarLines],
  )
  const resetAddJarPrompts = useCallback(() => {
    setAddJarAlloc({})
    setAddPaidFrom(PAID_FROM_UNALLOCATED)
    setTFromJar(PAID_FROM_UNALLOCATED)
    setTJarAlloc({})
  }, [])

  // Which of the add modal's prompts apply, from its current answers. A refund is money received
  // (the rule 78 prompt applies as to any income) that lands on an expense/savings line.
  const addIsRefund = type === ADD_REFUND
  const addApiType = addIsRefund ? TransactionType.Income : type
  const addLineDirection = addIsRefund ? TransactionType.Expense : type
  const addLedger = ledgerOf(account)
  const addJars = activeJars(addLedger)
  const addSplitting = addSplit && type === TransactionType.Expense
  const addIncomeJarsApply = addJars.length > 0 && addApiType === TransactionType.Income
  const addPaidFromApplies =
    addJars.length > 0 &&
    type === TransactionType.Expense &&
    (addSplitting
      ? addRows.some((r) => !!r.budgetItemId && !isJarLineFor(r.budgetItemId, account))
      : !!assignTo && !isJarLineFor(assignTo, account))
  // The jars each side offers: the active ones, plus an archived jar the stored answer of the
  // transfer being edited still names, so that share can be seen and sent back unchanged.
  const tFromLedger = ledgerOf(tFrom)
  const tFromJars = jarsForAnswer(tFromLedger, [tFromJar, ...storedJarIds(editingTransfer, editingTransfer?.accountId, 'out')])
  const tToLedger = ledgerOf(tTo)
  const tToJars = jarsForAnswer(tToLedger, [...namedJarIds(tJarAlloc), ...storedJarIds(editingTransfer, editingTransfer?.transferAccountId, 'in')])
  // The fee is dated the departure date, so its line picker offers that month's lines: the
  // loaded month when the date falls in it, otherwise that month fetched on demand (the loaded
  // month stands in while it loads or when it has no budget; the cross-month prompt covers it).
  const tFeeMinor = tFee.trim() ? parseMinor(tFee) : null
  const tHasFee = tFeeMinor !== null && tFeeMinor > 0
  const feeMonthKey = /^\d{4}-\d{2}/.test(tDate) ? tDate.slice(0, 7) : ''
  const feeMonthIsLoaded = !!month && feeMonthKey === monthKeyOf(month)
  const feeMonthWanted = showAdd && mode === 'transfer' && tHasFee && !!feeMonthKey && !feeMonthIsLoaded
  useEffect(() => {
    if (!feeMonthWanted || feeMonthKey in feeMonths) return
    let cancelled = false
    const [year, monthNum] = feeMonthKey.split('-').map(Number)
    api
      .get<BudgetMonthDto>(`/budget/${year}/${monthNum}`)
      .then(({ data }) => {
        if (cancelled) return
        const loaded = data && Array.isArray(data.categories) ? data : null
        setFeeMonths((prev) => ({ ...prev, [feeMonthKey]: loaded }))
      })
      // No budget for that month yet (404): the loaded month's lines stand in.
      .catch(() => !cancelled && setFeeMonths((prev) => ({ ...prev, [feeMonthKey]: null })))
    return () => {
      cancelled = true
    }
  }, [feeMonthWanted, feeMonthKey, feeMonths])
  const feeMonth = feeMonthIsLoaded || !feeMonthKey ? month : (feeMonths[feeMonthKey] ?? month)
  const feeLineOptions = buildItemOptions(feeMonth, TransactionType.Expense)
  // The legs a bank statement confirmed keep the bank's date and amount (edit only).
  const departureLocked = !!editingTransfer?.departureConfirmedByStatement
  const receiptLocked = !!editingTransfer?.receiptConfirmedByStatement
  const returnLocked = !!editingTransfer?.returnConfirmedByStatement
  // What arrived (or came back) is the bank's once a statement confirmed the receipt or the
  // return. A confirmed departure fixes only what left the source, the amount plus the fee, so
  // the amount can still move between the two and the fee follows as the rest (P3-7).
  const amountLocked = receiptLocked || returnLocked
  const departureTotalMinor =
    departureLocked && editingTransfer ? fromAmount(editingTransfer.amount) + fromAmount(editingTransfer.fee ?? 0) : null
  // "Returned on" applies only to a transfer that departed and was never received.
  const returnApplies = !!editingTransfer && !!tDate && !tReceived

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<TransactionDto[]>('/transactions'),
      api.get<BudgetMonthDto>('/budget/current').catch(() => null),
      api.get<AccountDto[]>('/accounts').catch(() => null),
      api.get<HouseholdMemberDto[]>('/members').catch(() => null),
    ])
      .then(([tx, budget, acc, mem]) => {
        if (cancelled) return
        setTransactions(tx.data)
        setMonth(budget?.data ?? null)
        setAccounts(Array.isArray(acc?.data) ? acc.data : [])
        setMembers(Array.isArray(mem?.data) ? mem.data : [])
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not load transactions.')
        setLoadFailed(true)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  /** Re-read the register, for a write that changes more than the one row it returns (a transfer's fee row). */
  const reloadTransactions = useCallback(() => {
    api
      .get<TransactionDto[]>('/transactions')
      .then(({ data }) => Array.isArray(data) && setTransactions(data))
      // The row the write returned is already shown; a failed refresh only leaves the fee row stale.
      .catch(() => {})
  }, [])

  const assign = useCallback(
    // Named, so the cross-month retry below can run it again acknowledged.
    async function assignTo(id: string, budgetItemId: string | null, acknowledgeCrossMonth = false, paidFromJarId?: string | null) {
      setSavingId(id)
      setError(null)
      try {
        const body = {
          budgetItemId,
          ...(acknowledgeCrossMonth ? { acknowledgeCrossMonth: true } : {}),
          // Rule 79: the answer to "which jar does this come from?" rides along with the line
          // (null = unallocated); omitted when the prompt did not apply.
          ...(paidFromJarId !== undefined ? { paidFromJarId } : {}),
        }
        const { data } = await api.put<TransactionDto>(`/transactions/${id}/assignment`, body)
        // In the Unassigned filter the row leaves the list: focus moves to its neighbour if it was lost.
        refocusRow(id, ['[data-assign-chip]', '[data-row-trigger]'], true)
        setTransactions((prev) => prev.map((t) => (t.id === id ? data : t)))
        setCrossMonthPrompt(null)
        reloadLedgers()
      } catch (err) {
        // A cross-month assignment isn't a failure — it's a confirmable choice (a purchase dated
        // last month that you want budgeted to this month's line). The server flags it under the
        // `crossMonth` key; prompt, then re-send acknowledged (with the same jar answer).
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => assignTo(id, budgetItemId, true, paidFromJarId) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that assignment.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [reloadLedgers, refocusRow],
  )

  // Add-modal split-row helpers; the register's editor below uses the same shared row functions.
  const resetAddSplit = useCallback(() => {
    setAddSplit(false)
    setAddRows(startSplitRows())
  }, [])
  const updateAddRow = useCallback((index: number, patch: Partial<SplitRowDraft>) => {
    setAddRows((rows) => patchSplitRow(rows, index, patch))
  }, [])
  const addAddRow = useCallback(() => setAddRows(appendSplitRow), [])
  const removeAddRow = useCallback((index: number) => setAddRows((rows) => removeSplitRowAt(rows, index)), [])

  const resetAddForeign = useCallback(() => {
    setPaidForeign(false)
    setFxCurrency('')
    setFxAmount('')
    setFxSuggestion(null)
  }, [])

  /** The add form's foreign figure, or the reason it can't be used yet. */
  const foreignFigure = useCallback((): { currency: string; amount: number } | string => {
    const code = fxCurrency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) return 'Enter the three-letter code of the currency you paid in, like USD.'
    if (code === budgetCurrency) return `${budgetCurrency} is your budget currency. Untick “Paid in another currency”.`
    const minor = parseMinor(fxAmount)
    if (minor === null || minor <= 0) return `Enter the amount you paid in ${code}, greater than zero.`
    return { currency: code, amount: toAmount(minor) }
  }, [fxCurrency, fxAmount, budgetCurrency])

  /** Fill the Amount with a suggested budget-currency figure. Nothing is saved; it stays editable. */
  const suggestAddAmount = useCallback(async () => {
    const foreign = foreignFigure()
    if (typeof foreign === 'string') {
      setError(foreign)
      return
    }
    setFxSuggesting(true)
    setError(null)
    try {
      const s = await fetchConversionSuggestion(foreign.currency, foreign.amount, date)
      setFxSuggestion(s)
      if (s.suggestedAmount !== null) setAmount(toEditString(fromAmount(s.suggestedAmount)))
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not get a suggestion. Enter the amount yourself.')
    } finally {
      setFxSuggesting(false)
    }
  }, [foreignFigure, date])

  const addTransaction = useCallback(async function add(acknowledgeCrossMonth = false) {
    const minor = parseMinor(amount)
    if (minor === null || minor <= 0) {
      setError('Enter a valid amount greater than zero.')
      return
    }
    if (tooPrecise(amount) || (addSplit && addRows.some((r) => tooPrecise(r.amount)))) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    if (!date) {
      setError('Enter the date of the transaction.')
      return
    }
    const jarProblem = addIncomeJarsApply ? jarAllocationsProblem(addJarAlloc, toAmount(minor)) : null
    if (jarProblem) {
      setError(jarProblem)
      return
    }
    if (addIsRefund && !refundOf) {
      setError('Choose the purchase this refund is for.')
      return
    }
    // A split purchase has no one line for the refund to follow (the server would record it
    // unassigned): the refund's line is the user's to pick.
    if (addIsRefund && !assignTo && transactions.some((t) => t.id === refundOf && t.isSplit)) {
      setError('That purchase is split across several lines: choose the category the refund goes to.')
      return
    }
    const foreign = foreignFigure()
    if (paidForeign && typeof foreign === 'string') {
      setError(foreign)
      return
    }
    const splitting = addSplit && type === TransactionType.Expense
    if (splitting) {
      const rowMinors = addRows.map((r) => parseMinor(r.amount))
      if (addRows.some((r, i) => !r.budgetItemId || rowMinors[i] === null || (rowMinors[i] ?? 0) <= 0)) {
        setError('Give every split line a category and an amount greater than zero.')
        return
      }
      if (sumMinor(rowMinors.map((m) => m ?? 0)) !== minor) {
        setError('The split lines must add up to the transaction total.')
        return
      }
    }
    setAdding(true)
    setError(null)
    try {
      const { data } = await api.post<TransactionDto>('/transactions', {
        date,
        payee,
        amount: toAmount(minor),
        type: addApiType,
        // A split transaction carries no whole-transaction category/member — the slices do.
        budgetItemId: splitting ? null : assignTo || null,
        // Rules 38/39: a refund names the purchase it comes back from; with no category chosen
        // the server puts it on the purchase's line in this month.
        ...(addIsRefund ? { refundOfTransactionId: refundOf } : {}),
        accountId: account || null,
        memberId: splitting ? null : member || null,
        splits: splitting
          ? addRows.map((r) => ({
              budgetItemId: r.budgetItemId,
              amount: toAmount(parseMinor(r.amount) ?? 0),
              memberId: r.memberId || null,
            }))
          : null,
        ...(acknowledgeCrossMonth ? { acknowledgeCrossMonth: true } : {}),
        // Rule 78: how income reaching a jar-backed account is divided among its jars (nothing
        // named = all unallocated). Rule 79: which jar a payment on a non-jar line comes from
        // (null = unallocated). Neither key is sent when its prompt did not apply.
        ...(addIncomeJarsApply && toJarAllocations(addJarAlloc).length > 0
          ? { jarAllocations: toJarAllocations(addJarAlloc) }
          : {}),
        ...(addPaidFromApplies ? { paidFromJarId: addPaidFrom || null } : {}),
        // Paid in another currency: the foreign figure rides along; `amount` is still the
        // budget-currency amount the user confirmed.
        ...(paidForeign && foreign && typeof foreign !== 'string'
          ? { originalAmount: foreign.amount, originalCurrency: foreign.currency }
          : {}),
      })
      setTransactions((prev) => [data, ...prev])
      reloadLedgers()
      // The purchase's row carries its refunded total as the server counts it.
      if (data.refundOfTransactionId) reloadTransactions()
      track(EVENTS.transactionAdded, {
        line_type: addIsRefund ? 'refund' : type === TransactionType.Income ? 'income' : 'expense',
        ...(splitting ? { split: true } : {}),
      })
      setPayee('')
      setAmount('')
      setRefundOf('')
      // Reset the category back to its Unassigned default too — otherwise a later "unassigned" add
      // silently inherits the previous line and the server-side auto-categorizer never runs.
      setAssignTo('')
      resetAddSplit()
      resetAddJarPrompts()
      resetAddForeign()
      setShowAdd(false)
      setCrossMonthPrompt(null)
    } catch (err) {
      // A backdated entry put on this month's line is the same confirmable cross-month choice.
      const crossMonth = crossMonthError(err)
      if (crossMonth && !acknowledgeCrossMonth) {
        setCrossMonthPrompt({ message: crossMonth, retry: () => add(true) })
      } else {
        // Rule 74 refusals ("Savings would be -50.00 EUR on …") and jar validation show verbatim.
        setError(serverErrors(err) ?? 'Could not add that transaction.')
      }
    } finally {
      setAdding(false)
    }
  }, [
    date, payee, amount, type, addIsRefund, addApiType, refundOf, assignTo, account, member, addSplit, addRows, resetAddSplit, transactions,
    addIncomeJarsApply, addJarAlloc, addPaidFromApplies, addPaidFrom, resetAddJarPrompts, reloadLedgers, reloadTransactions,
    paidForeign, foreignFigure, resetAddForeign,
  ])

  /** Back to a blank transfer form (after editing a transfer, whose values must not linger). */
  function resetTransferForm() {
    setEditingTransfer(null)
    setTDate(todayIso())
    setTReceived('')
    setTReturned('')
    setTConfirmed(false)
    setTAmount('')
    setTFrom('')
    setTTo('')
    setTPayee('')
    setTFee('')
    setTFeeLine('')
    setTFromJar(PAID_FROM_UNALLOCATED)
    setTJarAlloc({})
  }

  /** Close the add/transfer modal; an edit in progress is dropped. */
  function closeAddModal() {
    setShowAdd(false)
    resetAddSplit()
    if (editingTransfer) resetTransferForm()
  }

  /** Open the transfer form pre-filled with a recorded transfer, to edit it in place. */
  function startTransferEdit(t: TransactionDto) {
    setEditingId(null)
    cancelSplit()
    setLegId(null)
    setError(null)
    setEditingTransfer(t)
    setMode('transfer')
    setTDate(t.departedOn ?? '')
    setTReceived(t.receivedOn ?? '')
    setTReturned(t.returnedOn ?? '')
    setTAmount(toEditString(fromAmount(t.amount)))
    setTFrom(t.accountId ?? '')
    setTTo(t.transferAccountId ?? '')
    setTPayee(t.payee)
    setTFee(t.fee != null ? toEditString(fromAmount(t.fee)) : '')
    setTFeeLine(t.feeBudgetItemId ?? '')
    // The edit re-answers the jar questions, so pre-fill them from the stored split (an omitted
    // answer would return that leg to its default on save).
    setTFromJar(paidFromJarOf(t.jarAllocations, t.accountId, new Set()) ?? PAID_FROM_UNALLOCATED)
    setTJarAlloc(fromJarAllocations(incomingAllocationsOf(t.jarAllocations, t.transferAccountId)))
    setShowAdd(true)
  }

  /**
   * Record a new transfer, or save the one being edited. A plain function (not memoised) so the
   * cross-month prompt can re-run it acknowledged, as the other forms do.
   */
  async function submitTransfer(acknowledgeCrossMonth = false) {
    const editing = editingTransfer
    const minor = parseMinor(tAmount)
    if (minor === null || minor <= 0) {
      setError('Enter a valid transfer amount greater than zero.')
      return
    }
    // A typed amount is whole cents (D1); the edited transfer's own figures go back as they are.
    if (
      tooPrecise(tAmount, editing ? fromAmount(editing.amount) : null) ||
      tooPrecise(tFee, editing?.fee != null ? fromAmount(editing.fee) : null)
    ) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    if (!tFrom || !tTo) {
      setError('Choose both a source and a destination account.')
      return
    }
    if (tFrom === tTo) {
      setError('A transfer needs two different accounts.')
      return
    }
    // Dates two bank statements supplied stand as the banks gave them; only a changed date is checked.
    const datesChanged = !editing || tDate !== (editing.departedOn ?? '') || tReceived !== (editing.receivedOn ?? '')
    if (datesChanged && tReceived && tDate && tReceived < tDate) {
      setError('The receipt date can’t be before the departure date.')
      return
    }
    const returnedOn = returnApplies ? tReturned || null : null
    if (returnedOn && returnedOn < tDate) {
      setError('The return date can’t be before the departure date.')
      return
    }
    if (departureTotalMinor !== null && minor > departureTotalMinor) {
      setError(`The bank statement shows ${formatPlain(departureTotalMinor)} leaving the source account, so the amount can’t be more than that.`)
      return
    }
    if (tFee.trim() && !tHasFee) {
      setError('Enter a valid fee greater than zero, or leave it blank.')
      return
    }
    if (tHasFee && !tDate) {
      setError('A fee needs the date the money left the source account.')
      return
    }
    // Rule 91: a fee is spent from a budget line.
    if (tHasFee && !tFeeLine) {
      setError('Choose the budget line the fee is spent from.')
      return
    }
    if (!editing && !tDate) {
      setError('Enter the date the money left the source account.')
      return
    }
    // The destination's jar answer applies on arrival, so it can be given while in transit; a
    // returned transfer never arrives.
    const incomingApplies = !(returnApplies && tReturned)
    const jarProblem =
      incomingApplies && tToJars.length > 0
        ? jarAllocationsProblem(
            tJarAlloc,
            toAmount(minor),
            editing ? fromJarAllocations(incomingAllocationsOf(editing.jarAllocations, editing.transferAccountId)) : undefined,
          )
        : null
    if (jarProblem) {
      setError(jarProblem)
      return
    }
    if (!editing && !tConfirmed) {
      setError('Confirm that you’ve completed this transfer before recording it.')
      return
    }
    // P3-10: an edit re-sends the stored jar answers. The server accepts an archived jar's stored
    // share sent back unchanged on a leg that keeps its date and has posted (#283); it refuses a
    // jar newly named, a changed share, or one on a re-dated leg, so only those are stopped here.
    const sourceUnchanged =
      !!editing &&
      tFrom === editing.accountId &&
      tDate === (editing.departedOn ?? '') &&
      !!editing.departedOn &&
      minor === fromAmount(editing.amount) &&
      (tHasFee ? toAmount(tFeeMinor as number) : null) === (editing.fee ?? null)
    const destinationUnchanged =
      !!editing && tTo === editing.transferAccountId && !!editing.receivedOn && tReceived === editing.receivedOn
    const archived = editing
      ? archivedJarNewlyNamed(
          tFromLedger,
          [[tFromJar || null, toAmount(minor)] as const],
          storedSharesOf(editing.jarAllocations, editing.accountId, 'out'),
          sourceUnchanged,
        ) ??
        (incomingApplies
          ? archivedJarNewlyNamed(
              tToLedger,
              toJarAllocations(tJarAlloc).map((a) => [a.jarId, a.amount] as const),
              storedSharesOf(editing.jarAllocations, editing.transferAccountId, 'in'),
              destinationUnchanged,
            )
          : null)
      : null
    if (archived) {
      setError(archivedJarMessage(archived))
      return
    }
    const fee = tHasFee ? toAmount(tFeeMinor as number) : null
    const feeBudgetItemId = tHasFee ? tFeeLine || null : null
    setTransferring(true)
    setError(null)
    try {
      if (editing) {
        // An edit replaces the transfer, so every field is sent, the jar answers included
        // (null returns a leg to its default). Until the jar ledgers are known (still loading,
        // or the read failed) the form can't tell whether a leg backs jars, so it sends the
        // pre-filled answers unchanged rather than resetting them to the default.
        const incoming = toJarAllocations(tJarAlloc)
        const body: UpdateTransferRequest = {
          fromAccountId: tFrom,
          toAccountId: tTo,
          amount: toAmount(minor),
          departedOn: tDate || null,
          receivedOn: tReceived || null,
          returnedOn,
          payee: tPayee || null,
          fee,
          feeBudgetItemId,
          // A fee kept on the line and date it already had was accepted there when it was
          // recorded, so an unchanged re-save doesn't ask the cross-month question again (P3-8).
          acknowledgeCrossMonth:
            acknowledgeCrossMonth ||
            (fee !== null &&
              editing.fee != null &&
              feeBudgetItemId === (editing.feeBudgetItemId ?? null) &&
              (tDate || null) === (editing.departedOn ?? null)),
          fromJarId: (!ledgersLoaded || tFromJars.length > 0) && tDate ? tFromJar || null : null,
          jarAllocations: incomingApplies && (ledgersLoaded ? tToJars.length > 0 : incoming.length > 0) ? incoming : null,
          // One version covers both legs: an edit of either since this form loaded refuses the save (D11).
          version: editing.version ?? null,
        }
        const { data } = await api.put<TransactionDto>(`/transactions/${editing.id}/transfer`, body)
        setTransactions((prev) => prev.map((x) => (x.id === editing.id ? data : x)))
        // Saved either way; a receipt lowered, re-dated or re-pointed after its jar money moved on
        // leaves the jars unbacked, and the answer says so (D10).
        setNotice(data.warning ?? null)
        track(EVENTS.transactionEdited)
        resetTransferForm()
      } else {
        const body: CreateTransferRequest = {
          departedOn: tDate,
          receivedOn: tReceived || null,
          amount: toAmount(minor),
          fromAccountId: tFrom,
          toAccountId: tTo,
          payee: tPayee || null,
        }
        // Rule 80: a transfer out of a jar-backed account may say which jar it leaves (null =
        // unallocated); rule 78: a receipt already dated into one says how it is divided.
        if (tFromJars.length > 0) body.fromJarId = tFromJar || null
        if (tToJars.length > 0) {
          const rows = toJarAllocations(tJarAlloc)
          if (rows.length > 0) body.jarAllocations = rows
        }
        if (fee !== null) {
          body.fee = fee
          body.feeBudgetItemId = feeBudgetItemId
        }
        if (acknowledgeCrossMonth) body.acknowledgeCrossMonth = true
        const { data } = await api.post<TransactionDto>('/transactions/transfer', body)
        setTransactions((prev) => [data, ...prev])
        track(EVENTS.transferCreated)
        setTAmount('')
        setTPayee('')
        setTReceived('')
        setTConfirmed(false)
        setTFee('')
        setTFeeLine('')
        resetAddJarPrompts()
      }
      reloadLedgers()
      // A fee is its own row: reload the register so it appears (or updates) beside the transfer.
      if (fee !== null || editing?.fee != null) reloadTransactions()
      setShowAdd(false)
      setCrossMonthPrompt(null)
    } catch (err) {
      // A fee put on a line in another month than its date is the same confirmable choice.
      const crossMonth = crossMonthError(err)
      const conflict = editing ? editConflict(err) : null
      if (editing && conflict) {
        // Someone else saved this transfer first: reopen the form on what they saved.
        setCrossMonthPrompt(null)
        const fresh = await reloadAfterConflict(editing.id)
        if (fresh) startTransferEdit(fresh)
        else closeAddModal()
        setError(conflict)
      } else if (crossMonth && !acknowledgeCrossMonth) {
        setCrossMonthPrompt({ message: crossMonth, retry: () => submitTransfer(true) })
      } else {
        setError(serverErrors(err) ?? (editing ? 'Could not save that transfer.' : 'Could not record that transfer.'))
      }
    } finally {
      setTransferring(false)
    }
  }

  /** Confirm the bank leg a transfer is still missing (never rewrites a confirmed one). */
  const confirmLeg = useCallback(
    async (t: TransactionDto) => {
      if (!legDate) return
      // P3-10: the stored jar answer (or, once every jar in the account is archived, the answer
      // the server keeps when none is sent) may name a jar archived while the leg was missing.
      const departing = t.transferStatus === 'PendingReview'
      const legAccount = departing ? t.accountId : t.transferAccountId
      const liveJars = jarsOf(legAccount).length > 0
      const archived = archivedJarNamed(
        ledgerOf(legAccount),
        departing
          ? [liveJars ? legFromJar : paidFromJarOf(t.jarAllocations, t.accountId, new Set())]
          : liveJars
            ? Object.keys(legJarAlloc).filter((jarId) => (parseMinor(legJarAlloc[jarId]) ?? 0) > 0)
            : incomingAllocationsOf(t.jarAllocations, t.transferAccountId).map((a) => a.jarId),
      )
      if (archived) {
        setError(archivedJarMessage(archived))
        return
      }
      const body: ConfirmTransferLegsRequest = {}
      if (departing) {
        body.departedOn = legDate
        // Rule 80: the departure from a jar-backed account may name the jar it left.
        if (jarsOf(t.accountId).length > 0) body.fromJarId = legFromJar || null
      } else {
        body.receivedOn = legDate
        // Rule 78: the receipt into a jar-backed account says how it is divided among its jars.
        // The fields start from the answer given when it was recorded, so they are always sent
        // (an empty list leaves it all unallocated).
        if (jarsOf(t.transferAccountId).length > 0) {
          const problem = jarAllocationsProblem(
            legJarAlloc,
            t.amount,
            fromJarAllocations(incomingAllocationsOf(t.jarAllocations, t.transferAccountId)),
          )
          if (problem) {
            setError(problem)
            return
          }
          body.jarAllocations = toJarAllocations(legJarAlloc)
        }
      }
      setSavingId(t.id)
      setError(null)
      try {
        const { data } = await api.put<TransactionDto>(`/transactions/${t.id}/transfer-legs`, body)
        setTransactions((prev) => prev.map((x) => (x.id === t.id ? data : x)))
        setLegId(null)
        refocusRow(t.id)
        reloadLedgers()
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not confirm that transfer.')
      } finally {
        setSavingId(null)
      }
    },
    [legDate, legFromJar, legJarAlloc, jarsOf, ledgerOf, reloadLedgers, refocusRow],
  )

  /** Delete a row; focus goes to the row that takes its place on screen (the next one with a control, else the one before). */
  const removeTransaction = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    try {
      // 204, or 200 with a warning when the delete left jars unbacked (D10).
      const { data } = await api.delete<DeleteTransactionResult | ''>(`/transactions/${id}`)
      setNotice(data ? (data.warning ?? null) : null)
      refocusRow(id, ['[data-row-trigger]', '[data-assign-chip]'])
      // The server deletes a transfer's fee row with it (P71): drop that row too.
      setTransactions((prev) => prev.filter((t) => t.id !== id && t.feeForTransferId !== id))
      reloadLedgers()
      // A deleted refund leaves its purchase's refunded total.
      if (transactions.some((t) => t.id === id && t.refundOfTransactionId)) reloadTransactions()
      track(EVENTS.transactionDeleted)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not delete that transaction.')
    } finally {
      setSavingId(null)
    }
  }, [reloadLedgers, reloadTransactions, transactions, refocusRow])

  /**
   * Mark money received as a refund of a purchase, or clear the link (rules 38/39). The server
   * moves a newly linked refund off any income line onto the purchase's line in its own month,
   * and an unlinked one off its expense line.
   */
  const linkRefund = useCallback(
    async (id: string, refundOfTransactionId: string | null) => {
      setSavingId(id)
      setError(null)
      try {
        const { data } = await api.put<TransactionDto>(`/transactions/${id}/refund`, { refundOfTransactionId })
        setTransactions((prev) => prev.map((t) => (t.id === id ? data : t)))
        // The purchase rows carry their refunded totals as the server counts them (linked or unlinked).
        reloadTransactions()
        setRefundingId(null)
        setRefundPick('')
        refocusRow(id)
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not update that refund.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadTransactions, refocusRow],
  )

  const startEdit = useCallback(
    (t: TransactionDto) => {
      setSplittingId(null)
      setEditingId(t.id)
      setEDate(t.date)
      setEPayee(t.payee)
      setEAmount(toEditString(fromAmount(t.amount)))
      setEType(t.type)
      setEAccount(t.accountId ?? '')
      setEMember(t.memberId ?? '')
      // The edit re-answers the jar prompts, so pre-fill them from the stored split (an omitted
      // answer would reset the leg to its default on save).
      setEJarAlloc(fromJarAllocations(incomingAllocationsOf(t.jarAllocations, t.accountId)))
      setEPaidFrom(paidFromJarOf(t.jarAllocations, t.accountId, lineJarIdsOf(t)) ?? PAID_FROM_UNALLOCATED)
    },
    [lineJarIdsOf],
  )

  /**
   * D11: someone else saved this row after it was loaded. Re-read the register so the page shows
   * what they saved, and hand the latest row back to the form that was editing it (null when it
   * is gone, or the register can't be read).
   */
  const reloadAfterConflict = useCallback(async (id: string) => {
    try {
      const { data } = await api.get<TransactionDto[]>('/transactions')
      if (!Array.isArray(data)) return null
      setTransactions(data)
      return data.find((x) => x.id === id) ?? null
    } catch {
      return null
    }
  }, [])

  const saveEdit = useCallback(
    async function save(t: TransactionDto, acknowledgeCrossMonth = false) {
      const minor = parseMinor(eAmount)
      if (minor === null || minor <= 0) {
        setError('Enter a valid amount greater than zero.')
        return
      }
      if (tooPrecise(eAmount, fromAmount(t.amount))) {
        setError(TOO_MANY_DECIMALS)
        return
      }
      const id = t.id
      // Until the jar ledgers are known (still loading, or the read failed) the form can't tell
      // whether the account backs jars, so a stored answer is sent back unchanged rather than
      // left out, which would return the money to its default.
      const answerJars = jarsForAnswer(
        ledgerOf(eAccount),
        eType === TransactionType.Income
          ? [...namedJarIds(eJarAlloc), ...storedJarIds(t, t.accountId, 'in')]
          : [ePaidFrom, ...storedJarIds(t, t.accountId, 'out')],
      )
      const backsJars =
        answerJars.length > 0 ||
        (!ledgersLoaded && (eType === TransactionType.Income ? toJarAllocations(eJarAlloc).length > 0 : !!ePaidFrom))
      const jarProblem =
        backsJars && eType === TransactionType.Income
          ? jarAllocationsProblem(eJarAlloc, toAmount(minor), fromJarAllocations(incomingAllocationsOf(t.jarAllocations, t.accountId)))
          : null
      if (jarProblem) {
        setError(jarProblem)
        return
      }
      const paidFromApplies = eType === TransactionType.Expense && hasNonJarLine(t, eAccount || null)
      const sendsPaidFrom = backsJars && paidFromApplies
      // P3-10: the pre-filled jar answers are re-sent (or, once every jar there is archived, left
      // out, which would return the money to unallocated). The server accepts an archived jar's
      // stored share sent back unchanged on an entry that keeps its date and account (#283) and
      // refuses a jar newly named, a changed share, or one on a re-dated entry.
      const unchanged = eDate === t.date && eAccount === (t.accountId ?? '')
      // Rule 79: the paid-from answer covers the part of the payment on lines that are not jars.
      const unlinedMinor = t.isSplit
        ? sumMinor(t.splits.filter((s) => !isJarLineFor(s.budgetItemId, eAccount || null)).map((s) => fromAmount(s.amount)))
        : minor
      const archived = archivedJarNewlyNamed(
        ledgerOf(eAccount),
        eType === TransactionType.Income
          ? toJarAllocations(eJarAlloc).map((a) => [a.jarId, a.amount] as const)
          : paidFromApplies
            ? [[ePaidFrom || null, toAmount(unlinedMinor)] as const]
            : [],
        storedSharesOf(t.jarAllocations, t.accountId, eType === TransactionType.Income ? 'in' : 'out'),
        unchanged,
      )
      if (archived) {
        setError(archivedJarMessage(archived))
        return
      }
      setSavingId(id)
      setError(null)
      try {
        const { data } = await api.put<TransactionDto>(`/transactions/${id}`, {
          date: eDate,
          payee: ePayee,
          amount: toAmount(minor),
          type: eType,
          accountId: eAccount || null,
          memberId: eMember || null,
          ...(acknowledgeCrossMonth ? { acknowledgeCrossMonth: true } : {}),
          // An edit re-answers the jar prompts: the current answer is always sent when the
          // account backs jars, because omitting it would reset the leg to its default.
          ...(backsJars && eType === TransactionType.Income ? { jarAllocations: toJarAllocations(eJarAlloc) } : {}),
          ...(backsJars && eType === TransactionType.Expense ? { paidFromJarId: sendsPaidFrom ? ePaidFrom || null : null } : {}),
          // The version this form was loaded from: a save over someone else's change is refused (D11).
          version: t.version ?? null,
        })
        setTransactions((prev) => prev.map((x) => (x.id === id ? data : x)))
        setNotice(data.warning ?? null)
        reloadLedgers()
        track(EVENTS.transactionEdited)
        setEditingId(null)
        refocusRow(id)
        setCrossMonthPrompt(null)
      } catch (err) {
        // Moving an assigned/split transaction into another month keeps it budgeted to the
        // original month's line — a confirmable choice, not a failure.
        const crossMonth = crossMonthError(err)
        const conflict = editConflict(err)
        if (conflict) {
          // Someone else saved this row first: show theirs in the form, to redo the change on top.
          setCrossMonthPrompt(null)
          const fresh = await reloadAfterConflict(id)
          if (fresh) startEdit(fresh)
          else setEditingId(null)
          setError(conflict)
        } else if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => save(t, true) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that change.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [eDate, ePayee, eAmount, eType, eAccount, eMember, eJarAlloc, ePaidFrom, ledgersLoaded, ledgerOf, hasNonJarLine, isJarLineFor, reloadLedgers, reloadAfterConflict, startEdit, refocusRow],
  )

  const startSplit = useCallback(
    (t: TransactionDto) => {
      setEditingId(null)
      setSplittingId(t.id)
      setSplitPaidFrom(paidFromJarOf(t.jarAllocations, t.accountId, lineJarIdsOf(t)) ?? PAID_FROM_UNALLOCATED)
      if (t.isSplit && t.splits.length > 0) {
        setSplitRows(
          t.splits.map((s) => ({
            budgetItemId: s.budgetItemId ?? '',
            amount: toEditString(fromAmount(s.amount)),
            memberId: s.memberId ?? '',
          })),
        )
      } else {
        setSplitRows(startSplitRows({ budgetItemId: t.budgetItemId ?? '', memberId: t.memberId ?? '' }))
      }
    },
    [lineJarIdsOf],
  )

  function cancelSplit() {
    setSplittingId(null)
    setSplitRows([])
  }

  const removeSplit = useCallback(
    async (id: string) => {
      await assign(id, null) // clearing the assignment drops the split server-side
      cancelSplit()
      refocusRow(id)
    },
    [assign, refocusRow],
  )

  function updateSplitRow(index: number, patch: Partial<SplitRowDraft>) {
    setSplitRows((rows) => patchSplitRow(rows, index, patch))
  }

  function addSplitRow() {
    setSplitRows(appendSplitRow)
  }

  function removeSplitRow(index: number) {
    setSplitRows((rows) => removeSplitRowAt(rows, index))
  }

  const saveSplit = useCallback(
    async function save(t: TransactionDto, acknowledgeCrossMonth = false) {
      const parsed = splitRows.map((r) => ({
        budgetItemId: r.budgetItemId,
        memberId: r.memberId,
        minor: parseMinor(r.amount),
      }))
      if (parsed.length < 2 || parsed.some((a) => !a.budgetItemId || a.minor === null || a.minor <= 0)) {
        setError('Give every split line a category and an amount greater than zero.')
        return
      }
      // Slices are whole cents (D1), unless the row's own amount carries more decimals (a
      // converted amount restated at four): its slices must still add up to it.
      if (fromAmount(t.amount) % 100 === 0 && splitRows.some((r) => tooPrecise(r.amount))) {
        setError(TOO_MANY_DECIMALS)
        return
      }
      const allocatedMinor = sumMinor(parsed.map((a) => a.minor as number))
      if (allocatedMinor !== fromAmount(t.amount)) {
        setError('The split lines must add up to the transaction total.')
        return
      }
      // Rule 79: the slices on lines that are not jars draw from the named jar (null = unallocated).
      const drawsUnlined = t.type === TransactionType.Expense && parsed.some((a) => !isJarLineFor(a.budgetItemId, t.accountId))
      const paidFromApplies = drawsUnlined && jarsForAnswer(ledgerOf(t.accountId), [splitPaidFrom, ...storedJarIds(t, t.accountId, 'out')]).length > 0
      // P3-10: a pre-filled answer naming an archived jar is refused (or dropped with the account's
      // last live jar), unless it is the jar's stored share sent back unchanged (#283): the split
      // keeps the entry's date, so only a changed draw from an archived jar is stopped here.
      const unlinedMinor = sumMinor(parsed.filter((a) => !isJarLineFor(a.budgetItemId, t.accountId)).map((a) => a.minor as number))
      const archived = drawsUnlined
        ? archivedJarNewlyNamed(
            ledgerOf(t.accountId),
            [[splitPaidFrom || null, toAmount(unlinedMinor)] as const],
            storedSharesOf(t.jarAllocations, t.accountId, 'out'),
            true,
          )
        : null
      if (archived) {
        setError(archivedJarMessage(archived))
        return
      }
      setSavingId(t.id)
      setError(null)
      try {
        const { data } = await api.put<TransactionDto>(`/transactions/${t.id}/splits`, {
          allocations: parsed.map((a) => ({
            budgetItemId: a.budgetItemId,
            amount: toAmount(a.minor as number),
            memberId: a.memberId || null,
          })),
          ...(acknowledgeCrossMonth ? { acknowledgeCrossMonth: true } : {}),
          ...(paidFromApplies ? { paidFromJarId: splitPaidFrom || null } : {}),
          // The version the slices were loaded from: a split saved over someone else's change is
          // refused (D11, #308 review P2-1).
          version: t.version ?? null,
        })
        setTransactions((prev) => prev.map((x) => (x.id === t.id ? data : x)))
        cancelSplit()
        refocusRow(t.id)
        setCrossMonthPrompt(null)
        reloadLedgers()
      } catch (err) {
        // Splitting an older transaction across this month's lines is the same confirmable
        // cross-month choice as a whole assignment.
        const crossMonth = crossMonthError(err)
        const conflict = editConflict(err)
        if (conflict) {
          // Someone else changed this row first: reopen the editor on what they saved, to redo
          // the split on top.
          setCrossMonthPrompt(null)
          const fresh = await reloadAfterConflict(t.id)
          if (fresh) startSplit(fresh)
          else cancelSplit()
          setError(conflict)
        } else if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => save(t, true) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that split.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [splitRows, splitPaidFrom, ledgerOf, isJarLineFor, reloadLedgers, reloadAfterConflict, startSplit, refocusRow],
  )

  // Split rows only ever target expense/savings lines (the add modal offers splits for expenses).
  // Built once per month, not once per render or per row: the rows get them unchanged, so a
  // keystroke in an inline field leaves the other rows alone.
  const expenseSplitOptions = useMemo(() => buildItemOptions(month, TransactionType.Expense), [month])
  // Income lines, for the list's income rows.
  const incomeOptions = useMemo(() => buildItemOptions(month, TransactionType.Income), [month])
  const addRemainderMinor = (parseMinor(amount) ?? 0) - sumMinor(addRows.map((r) => parseMinor(r.amount) ?? 0))
  const addCurrency = month?.baseCurrency ?? budgetCurrency
  // The prompts' "stays unallocated" line needs the arriving amount in major units (null while unparsable).
  const addMinor = parseMinor(amount)
  const addAmountMajor = addMinor === null ? null : toAmount(addMinor)
  const tMinor = parseMinor(tAmount)
  const tAmountMajor = tMinor === null ? null : toAmount(tMinor)
  const eMinor = parseMinor(eAmount)
  const eAmountMajor = eMinor === null ? null : toAmount(eMinor)

  // Map each budget line to its category's hue, so an assigned transaction's chip
  // carries the same colour as its group on the Dashboard. Income lines read as
  // the Dashboard's emerald; expense/fund groups cycle the five-hue palette.
  const itemHue = useMemo(() => {
    const map: Record<string, CategoryHue> = {}
    if (!month) return map
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const hue: CategoryHue =
        c.kind === 'Income' ? 'emerald' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) map[it.id] = hue
    }
    return map
  }, [month])

  // Hero totals — derived (never stored), like the budget's read-time actuals. A refund is
  // never money in (rule 41); it comes off money out in the month it was received (rules 38/39).
  // A row still waiting for its amount in the budget currency (fxPending) counts nowhere; a row on
  // an account kept in another currency counts its budget figure, not the account's amount.
  // The register lists every month; the hero counts only the month the top bar shows.
  const { year: viewYear, month: viewMonth, label: monthLabel } = useMonth()
  const viewKey = `${viewYear}-${String(viewMonth).padStart(2, '0')}`
  // A transfer's shared side kept after its other account was erased is still a transfer to the
  // household, so it counts in neither total.
  const counted = useMemo(
    () => transactions.filter((t) => !t.fxPending && !t.counterpartyErased && t.date.startsWith(viewKey)),
    [transactions, viewKey],
  )
  const moneyInMinor = useMemo(
    () =>
      sumMinor(
        counted
          .filter((t) => t.type === TransactionType.Income && !t.refundOfTransactionId)
          .map((t) => fromAmount(t.budgetAmount ?? t.amount)),
      ),
    [counted],
  )
  const moneyOutMinor = useMemo(
    () =>
      sumMinor(counted.filter((t) => t.type === TransactionType.Expense).map((t) => fromAmount(t.budgetAmount ?? t.amount))) -
      sumMinor(counted.filter((t) => !!t.refundOfTransactionId).map((t) => fromAmount(t.budgetAmount ?? t.amount))),
    [counted],
  )
  const purchases = useMemo(() => refundablePurchases(transactions), [transactions])
  const unassignedCount = useMemo(
    () =>
      transactions.filter(
        (t) => t.type !== TransactionType.Transfer && !t.counterpartyErased && !t.isSplit && t.budgetItemId === null,
      ).length,
    [transactions],
  )
  const currency = month?.baseCurrency ?? budgetCurrency

  // Budget lines that are bills (have a due day) — so an assigned transaction can
  // show the "Bill" tag, like the design's Vodafone → Internet row.
  const billItemIds = useMemo(() => {
    const set = new Set<string>()
    month?.categories.forEach((c) => c.items.forEach((i) => i.dueDay != null && set.add(i.id)))
    return set
  }, [month])

  // ---- The list (restyle PR 5) ---------------------------------------------------------------
  // "Unassigned": external (non-transfer) transactions not yet given a budget line.
  const filtered = useMemo(
    () =>
      filter === 'all'
        ? transactions
        : transactions.filter(
            (t) => t.type !== TransactionType.Transfer && !t.counterpartyErased && !t.isSplit && t.budgetItemId === null,
          ),
    [transactions, filter],
  )
  // The search narrows the loaded rows only: no request, and the list keeps every month.
  const searchText = query?.trim() ?? ''
  const visible = useMemo(
    () => newestFirst(searchText ? filtered.filter((t) => matchesSearch(t, searchText)) : filtered),
    [filtered, searchText],
  )
  // Grouped by day under small headers, newest first.
  const days = useMemo(() => {
    const groups: { date: string; rows: TransactionDto[] }[] = []
    for (const t of visible) {
      const last = groups[groups.length - 1]
      if (last && last.date === t.date) last.rows.push(t)
      else groups.push({ date: t.date, rows: [t] })
    }
    return groups
  }, [visible])

  useLayoutEffect(() => {
    visibleRef.current = visible
  }, [visible])

  // Focus back to the row once its editor (or the dialog it raised) has closed; see pendingFocus.
  useEffect(() => {
    if (!pendingFocus || showAdd || crossMonthPrompt || paidFromPrompt || convertingId) return
    setPendingFocus(null)
    const { id, targets, order, ifLost } = pendingFocus
    const active = document.activeElement
    if (ifLost && active && active !== document.body && active.isConnected) return
    focusTarget(id, targets, order)?.focus()
  }, [pendingFocus, showAdd, crossMonthPrompt, paidFromPrompt, convertingId])

  // The split editor opens on its first line's amount (the line itself is filled in).
  const [splitPanel, setSplitPanel] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    splitPanel?.querySelector<HTMLElement>('[aria-label="Split line 1 amount"]')?.focus()
  }, [splitPanel])

  // Escape (or the ✕) closes the search and gives focus back to its button.
  const refocusSearch = useRef(false)
  useEffect(() => {
    if (query === null && refocusSearch.current) {
      refocusSearch.current = false
      searchButtonRef.current?.focus()
    }
  }, [query])
  function closeSearch() {
    refocusSearch.current = true
    setQuery(null)
  }

  /** Close the row's open editor from its Cancel (or Escape), focus back to the row. */
  function cancelEditor(t: TransactionDto, which: 'edit' | 'split' | 'refund' | 'leg') {
    if (which === 'edit') setEditingId(null)
    if (which === 'split') cancelSplit()
    if (which === 'refund') setRefundingId(null)
    if (which === 'leg') setLegId(null)
    refocusRow(t.id)
  }

  const money = (minor: number) => formatMoney(minor, currency)
  const spentHint = (
    <>
      Everything paid out in {monthLabel}, transfer fees and payments from jars included, less refunds received that
      month. Transfers between your own accounts and payments still waiting for their {budgetCurrency} amount are not
      counted.
    </>
  )

  const addButton =
    canEnterData && !loading ? (
      <Button
        onClick={() => {
          setMode('transaction')
          setError(null)
          // Close the list's inline split editor — the modal's split rows share its aria-labels,
          // and two mounted editors would collide.
          cancelSplit()
          resetAddSplit()
          resetAddJarPrompts()
          resetAddForeign()
          setShowAdd(true)
        }}
        aria-label="Add transaction"
        className="h-[38px] gap-[7px] rounded-[10px] px-4 shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:bg-primary dark:hover:bg-brand-600"
      >
        <Plus aria-hidden className="size-4" />
        Add transaction
      </Button>
    ) : null

  // ---- The rows --------------------------------------------------------------------------------
  // Each row is a memoised TxRow. A row asks for an action through one stable `dispatch`, which runs
  // the page's latest handler (kept in a ref after every render), so a keystroke in an editor or in
  // the search renders only the rows whose props changed: the one being edited, never the rest.
  function onRowEvent(e: TxRowEvent) {
    const { t } = e
    switch (e.type) {
      case 'edit-transfer':
        startTransferEdit(t)
        return
      case 'edit':
        startEdit(t)
        return
      case 'split':
        startSplit(t)
        return
      case 'not-refund':
        void linkRefund(t.id, null)
        return
      case 'refund':
        setEditingId(null)
        setSplittingId(null)
        setRefundPick('')
        setRefundingId(t.id)
        return
      case 'leg': {
        const legPending = t.transferStatus === 'PendingReview'
        setLegId(t.id)
        setLegDate(legPending ? t.receivedOn ?? todayIso() : t.departedOn ?? todayIso())
        // Start from the jar answers given when it was recorded.
        setLegJarAlloc(fromJarAllocations(incomingAllocationsOf(t.jarAllocations, t.transferAccountId)))
        setLegFromJar(paidFromJarOf(t.jarAllocations, t.accountId, new Set()) ?? PAID_FROM_UNALLOCATED)
        return
      }
      case 'delete':
        void removeTransaction(t.id)
        return
      case 'assign':
        setAssigningId(t.id)
        return
      case 'assign-blur':
        setAssigningId(null)
        return
      case 'assign-escape':
        setAssigningId(null)
        refocusRow(t.id, ['[data-assign-chip]', '[data-row-trigger]'])
        return
      case 'assign-pick': {
        const next = e.budgetItemId
        setAssigningId(null)
        // Chosen by leaving the select: focus stays where it went.
        if (!e.blur) refocusRow(t.id, ['[data-assign-chip]', '[data-row-trigger]'])
        // Rule 79: a payment from a jar-backed account put on a line that is not a jar asks
        // which jar it comes from first; a jar line draws from its own jar and clearing the
        // line draws from unallocated — no prompt.
        if (next && t.type === TransactionType.Expense && jarsOf(t.accountId).length > 0 && !isJarLineFor(next, t.accountId)) {
          setPaidFromPrompt({ transaction: t, budgetItemId: next, value: PAID_FROM_UNALLOCATED })
        } else {
          void assign(t.id, next)
        }
        return
      }
      case 'fx':
        refocusRow(t.id, ['[data-fx-chip]', '[data-row-trigger]'])
        setConvertingId(t.id)
        return
      case 'sheet':
        setSheetFor(e.open ? t.id : null)
        return
    }
  }
  const rowEvents = useRef(onRowEvent)
  useLayoutEffect(() => {
    rowEvents.current = onRowEvent
  })
  const dispatchRow = useCallback((e: TxRowEvent) => rowEvents.current(e), [])
  const rowCtx = useMemo<TxRowContext>(
    () => ({
      canEnterData,
      budgetCurrency,
      itemHue,
      billItemIds,
      isJarLineFor,
      incomeOptions,
      expenseOptions: expenseSplitOptions,
      dispatch: dispatchRow,
    }),
    [canEnterData, budgetCurrency, itemHue, billItemIds, isJarLineFor, incomeOptions, expenseSplitOptions, dispatchRow],
  )

  // ---- The inline editors, built for the one row that has one open --------------------------------
  const escapeCloses = (t: TransactionDto, which: 'edit' | 'split' | 'refund' | 'leg') => (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    cancelEditor(t, which)
  }

  /** Confirming a transfer's missing leg: in the row, under its line. */
  function legEditorFor(t: TransactionDto) {
    const legPending = t.transferStatus === 'PendingReview'
    return (
      <div data-entry className={`relative z-10 col-span-full mt-2.5 mb-1 flex flex-col gap-2.5 ${EDITOR_PANEL}`} onKeyDown={escapeCloses(t, 'leg')}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] font-semibold text-slate-700">
            {legPending ? 'Departure date' : 'Receipt date'}
            <Input
              type="date"
              autoFocus
              value={legDate}
              aria-label={legPending ? 'Departure date' : 'Receipt date'}
              onChange={(e) => setLegDate(e.target.value)}
              className={`${FIELD} text-slate-700`}
            />
          </label>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" onClick={() => confirmLeg(t)} disabled={savingId === t.id} aria-label="Save transfer leg" className={EDITOR_BUTTON}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => cancelEditor(t, 'leg')} aria-label="Cancel transfer leg" className={EDITOR_BUTTON}>
              Cancel
            </Button>
          </div>
        </div>
        {/* The jar question of the leg being confirmed (rules 78/80): a receipt into a jar-backed
            account asks how it is divided; a departure from one may name the jar it left. */}
        {(() => {
          const ledger = ledgerOf(legPending ? t.accountId : t.transferAccountId)
          const jars = activeJars(ledger)
          if (!ledger || jars.length === 0) return null
          return legPending ? (
            <PaidFromJarSelect
              id={`departure-${t.id}-from-jar`}
              compact
              jars={jars}
              accountName={ledger.accountName}
              currency={ledger.currency}
              value={legFromJar}
              onChange={setLegFromJar}
            />
          ) : (
            <JarAllocationFields
              jars={jars}
              accountName={ledger.accountName}
              currency={ledger.currency}
              amount={t.amount}
              value={legJarAlloc}
              onChange={setLegJarAlloc}
              idPrefix={`receipt-${t.id}`}
              compact
            />
          )
        })()}
      </div>
    )
  }

  /** The row's edit form, in place of its line. */
  function editFormFor(t: TransactionDto) {
    const isRefund = !!t.refundOfTransactionId
    const hasRefunds = (t.refundCount ?? 0) > 0
    return (
      <div data-entry className={`my-2 flex flex-wrap items-center gap-2 ${EDITOR_PANEL}`} onKeyDown={escapeCloses(t, 'edit')}>
        <Input type="date" autoFocus value={eDate} aria-label="Edit date" onChange={(e) => setEDate(e.target.value)} className={`${FIELD} text-slate-700`} />
        <Input type="text" value={ePayee} aria-label="Edit payee" placeholder="Payee" onChange={(e) => setEPayee(e.target.value)} className={`${FIELD} min-w-32 flex-1`} />
        <Input
          type="text"
          inputMode="decimal"
          {...selectOnFocusProps}
          value={eAmount}
          aria-label="Edit amount"
          onChange={(e) => setEAmount(e.target.value)}
          className={`${FIELD} w-28 text-right tabular-nums`}
        />
        <Select
          value={eType}
          aria-label="Edit type"
          onChange={(e) => setEType(Number(e.target.value))}
          // A refund stays money received, and a refunded purchase stays a purchase, until the
          // link is removed (rules 38/39).
          disabled={isRefund || hasRefunds}
          title={
            isRefund
              ? 'A refund is money received. Use “Not a refund” first to change its type.'
              : hasRefunds
                ? 'This purchase has refunds linked to it; unmark them first to change its type.'
                : undefined
          }
          className={FIELD}
        >
          <option value={TransactionType.Expense}>Expense</option>
          <option value={TransactionType.Income}>Income</option>
        </Select>
        {accounts.length > 0 && (
          <Select
            value={eAccount}
            aria-label="Edit account"
            onChange={(e) => {
              setEAccount(e.target.value)
              // Another account has other jars — start its answers from the default.
              setEJarAlloc({})
              setEPaidFrom(PAID_FROM_UNALLOCATED)
            }}
            className={FIELD}
          >
            <option value="">No account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
        {members.length >= 2 && (
          <Select value={eMember} aria-label="Edit member" onChange={(e) => setEMember(e.target.value)} className={FIELD}>
            <option value="">No member</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
        {/* The jar prompts, pre-filled from the stored split (rules 78/79). */}
        {(() => {
          const ledger = ledgerOf(eAccount)
          const jars = jarsForAnswer(
            ledger,
            eType === TransactionType.Income
              ? [...namedJarIds(eJarAlloc), ...storedJarIds(t, t.accountId, 'in')]
              : [ePaidFrom, ...storedJarIds(t, t.accountId, 'out')],
          )
          if (!ledger || jars.length === 0) return null
          if (eType === TransactionType.Income) {
            return (
              <div className="basis-full">
                <JarAllocationFields
                  jars={jars}
                  accountName={ledger.accountName}
                  currency={ledger.currency}
                  amount={eAmountMajor}
                  value={eJarAlloc}
                  onChange={setEJarAlloc}
                  idPrefix={`edit-${t.id}`}
                  compact
                />
              </div>
            )
          }
          if (!hasNonJarLine(t, eAccount || null)) return null
          return (
            <div className="basis-full">
              <PaidFromJarSelect
                id={`edit-${t.id}-paid-from`}
                compact
                jars={jars}
                accountName={ledger.accountName}
                currency={ledger.currency}
                value={ePaidFrom}
                onChange={setEPaidFrom}
              />
            </div>
          )
        })()}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" onClick={() => saveEdit(t)} disabled={savingId === t.id} aria-label="Save transaction" className={EDITOR_BUTTON}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cancelEditor(t, 'edit')} aria-label="Cancel edit" className={EDITOR_BUTTON}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  /** Marking money received as a refund: pick the purchase it came back from (rules 38/39). */
  function refundEditorFor(t: TransactionDto) {
    const name = t.payee || t.date
    return (
      <div data-entry className={`mt-1 mb-3 flex flex-wrap items-center gap-2 text-sm ${EDITOR_PANEL}`} onKeyDown={escapeCloses(t, 'refund')}>
        <span className="text-[13px] font-semibold text-slate-700">Refund of</span>
        <Select
          autoFocus
          value={refundPick}
          aria-label={`Purchase refunded by ${name}`}
          onChange={(e) => setRefundPick(e.target.value)}
          className={`${FIELD} max-w-full min-w-56`}
        >
          <option value="">Choose the purchase</option>
          {purchases.map((p) => (
            <option key={p.id} value={p.id}>
              {shortDate(p.date)} · {p.payee || 'Purchase'} · {formatMoney(fromAmount(p.amount), p.currency)}
            </option>
          ))}
        </Select>
        <span className="basis-full text-xs text-slate-500 min-[900px]:basis-auto">
          {purchases.find((p) => p.id === refundPick)?.isSplit
            ? 'That purchase is split across several lines: the refund is not counted as income, and you pick its category on the row afterwards.'
            : 'The refund moves to the purchase’s category and is not counted as income.'}
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" onClick={() => linkRefund(t.id, refundPick)} disabled={savingId === t.id || !refundPick} aria-label="Save refund link" className={EDITOR_BUTTON}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cancelEditor(t, 'refund')} aria-label="Cancel refund link" className={EDITOR_BUTTON}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  /** Splitting a row across budget lines, under its line. */
  function splitEditorFor(t: TransactionDto) {
    const isIncome = transactionTypeLabel(t.type) === 'Income'
    const splitOptions = t.type === TransactionType.Income ? incomeOptions : expenseSplitOptions
    const totalMinor = fromAmount(t.amount)
    const remainderMinor = totalMinor - sumMinor(splitRows.map((r) => parseMinor(r.amount) ?? 0))
    return (
      <div ref={setSplitPanel} data-entry className={`mt-1 mb-3 space-y-3 ${EDITOR_PANEL} p-3.5`} onKeyDown={escapeCloses(t, 'split')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* An h3: the editor sits under its day's h2. */}
          <h3 className="text-sm font-semibold text-slate-900">
            Split “{t.payee || t.date}” ({formatMoney(totalMinor, t.currency)})
          </h3>
          <SplitRemainderChip remainderMinor={remainderMinor} format={(m) => formatMoney(m, t.currency)} />
        </div>
        {splitOptions.length === 0 && (
          <p className="text-xs text-bad">Add some {isIncome ? 'income' : 'expense'} budget lines first.</p>
        )}
        <SplitLinesEditor rows={splitRows} options={splitOptions} members={members} onChangeRow={updateSplitRow} onRemoveRow={removeSplitRow} />
        {/* Rule 79: the slices on lines that are not jars draw from one named jar. */}
        {(() => {
          const ledger = ledgerOf(t.accountId)
          const jars = jarsForAnswer(ledger, [splitPaidFrom, ...storedJarIds(t, t.accountId, 'out')])
          const applies =
            t.type === TransactionType.Expense &&
            !!ledger &&
            jars.length > 0 &&
            splitRows.some((r) => !!r.budgetItemId && !isJarLineFor(r.budgetItemId, t.accountId))
          return applies && ledger ? (
            <PaidFromJarSelect
              id="split-paid-from"
              compact
              jars={jars}
              accountName={ledger.accountName}
              currency={ledger.currency}
              value={splitPaidFrom}
              onChange={setSplitPaidFrom}
            />
          ) : null
        })()}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={addSplitRow} className={EDITOR_BUTTON}>
            <Plus aria-hidden className="size-3.5" /> Add line
          </Button>
          {t.isSplit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => removeSplit(t.id)}
              disabled={savingId === t.id}
              aria-label="Remove split"
              className={`${EDITOR_BUTTON} text-bad! hover:bg-bad-bg!`}
            >
              Remove split
            </Button>
          )}
          <div className="flex-1" />
          <Button size="sm" onClick={() => saveSplit(t)} disabled={savingId === t.id || remainderMinor !== 0} aria-label="Save split" className={EDITOR_BUTTON}>
            Save split
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cancelEditor(t, 'split')} aria-label="Cancel split" className={EDITOR_BUTTON}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  // The rows busy saving or with something open: only the days that hold one re-render with the page.
  const activeIds = [savingId, assigningId, sheetFor, legId, editingId, refundingId, splittingId].filter((id): id is string => !!id)
  const dayState: TxDayState = {
    savingId,
    assigningId,
    sheetFor,
    editorsFor: (t) => {
      const refund = refundingId === t.id
      const split = splittingId === t.id
      if (legId !== t.id && editingId !== t.id && !refund && !split) return undefined
      return {
        legEditor: legId === t.id ? legEditorFor(t) : undefined,
        editForm: editingId === t.id ? editFormFor(t) : undefined,
        below:
          refund || split ? (
            <>
              {refund && refundEditorFor(t)}
              {split && splitEditorFor(t)}
            </>
          ) : undefined,
      }
    },
  }

  return (
    <AppShell active="transactions" title="Transactions" month actions={desktop ? addButton || undefined : undefined}>
      <KpiRow tiles={1}>
        <KpiTile
          hero
          label="Income"
          value={money(moneyInMinor)}
          valueLabel={`Income for ${monthLabel}: ${money(moneyInMinor)}`}
        />
        <KpiTile
          label="Spent"
          icon={<ArrowUpRight strokeWidth={1.8} />}
          iconColor="var(--color-clay)"
          hint={spentHint}
          value={money(moneyOutMinor)}
          valueLabel={`Spent in ${monthLabel}: ${money(moneyOutMinor)}`}
          strip
        />
      </KpiRow>

      {!desktop && addButton && <div className="flex justify-end">{addButton}</div>}

      {error && !showAdd && <ErrorBanner>{error}</ErrorBanner>}
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-slate-200/70 bg-surface px-4 py-3 text-sm text-slate-700 shadow-card"
        >
          <span className="flex items-start gap-2">
            <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full bg-warn" />
            <span>{notice}</span>
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-slate-500 transition hover:bg-surface-2 hover:text-slate-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Add transaction / transfer — a modal opened from the toolbar's + button. */}
      {showAdd && canEnterData && (
      <Modal
        title={editingTransfer ? 'Edit transfer' : mode === 'transfer' ? 'Record a transfer' : 'Add a transaction'}
        onClose={closeAddModal}
      >
        {accounts.length >= 2 && !editingTransfer && (
          <div className="mb-4">
            <SegmentedControl
              ariaLabel="Entry type"
              value={mode}
              onChange={(m) => {
                setMode(m)
                setError(null)
                resetAddSplit()
              }}
              options={[
                { value: 'transaction', label: 'Transaction' },
                { value: 'transfer', label: 'Transfer' },
              ]}
            />
          </div>
        )}
        {error && <div className="mb-3"><ErrorBanner>{error}</ErrorBanner></div>}
        {mode === 'transaction' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Type
              <Select
                value={type}
                aria-label="Transaction type"
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setType(next)
                  // Splits are an expense-only affordance in the add modal.
                  if (next !== TransactionType.Expense) resetAddSplit()
                  // The category select offers different lines per direction.
                  setAssignTo('')
                  setRefundOf('')
                  // The jar prompts belong to one direction each.
                  setAddJarAlloc({})
                  setAddPaidFrom(PAID_FROM_UNALLOCATED)
                }}
                className="w-full"
              >
                <option value={TransactionType.Expense}>Expense</option>
                <option value={TransactionType.Income}>Income</option>
                <option value={ADD_REFUND}>Refund</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Date
              <Input
                type="date"
                value={date}
                aria-label="Transaction date"
                onChange={(e) => setDate(e.target.value)}
                className="w-full text-slate-700"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            Payee
            <Input
              type="text"
              value={payee}
              placeholder="e.g. Tesco"
              aria-label="Transaction payee"
              onChange={(e) => setPayee(e.target.value)}
              className="w-full"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Amount
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={amount}
                placeholder="0.00"
                aria-label="Transaction amount"
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTransaction()
                }}
                className="w-full text-right tabular-nums"
              />
            </label>
            {accounts.length > 0 && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Account
                <Select
                  value={account}
                  aria-label="Transaction account"
                  onChange={(e) => {
                    setAccount(e.target.value)
                    // Another account has other jars — never carry a jar answer across.
                    setAddJarAlloc({})
                    setAddPaidFrom(PAID_FROM_UNALLOCATED)
                  }}
                  className="w-full"
                >
                  <option value="">No account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {/* Paid in another currency: the foreign figure is recorded for reference, and a
              suggestion may fill the Amount, which stays the budget-currency amount that counts. */}
          {features.multiCurrency && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={paidForeign}
                  onChange={(e) => {
                    if (e.target.checked) setPaidForeign(true)
                    else resetAddForeign()
                  }}
                  className="h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-brand-500"
                />
                Paid in another currency
              </label>
              {paidForeign && (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:bg-white/[0.03]">
                  <div className="grid grid-cols-[5.5rem_1fr_auto] items-end gap-2">
                    <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                      Currency
                      <Input
                        type="text"
                        value={fxCurrency}
                        placeholder="USD"
                        maxLength={3}
                        autoComplete="off"
                        aria-label="Currency paid in"
                        onChange={(e) => {
                          setFxCurrency(e.target.value.toUpperCase())
                          setFxSuggestion(null)
                        }}
                        className="w-full uppercase"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                      Amount paid
                      <Input
                        type="text"
                        inputMode="decimal"
                        {...selectOnFocusProps}
                        value={fxAmount}
                        placeholder="0.00"
                        aria-label="Amount paid in that currency"
                        onChange={(e) => {
                          setFxAmount(e.target.value)
                          setFxSuggestion(null)
                        }}
                        className="w-full text-right tabular-nums"
                      />
                    </label>
                    <Button variant="secondary" onClick={suggestAddAmount} disabled={fxSuggesting}>
                      {fxSuggesting ? 'Suggesting…' : 'Suggest'}
                    </Button>
                  </div>
                  <p role="status" className="text-xs text-slate-500">
                    {fxSuggestion
                      ? suggestionHint(fxSuggestion)
                      : `The Amount above is what counts, in ${budgetCurrency}. Suggest fills it in for you to check.`}
                  </p>
                </div>
              )}
            </div>
          )}
          {/* Rules 38/39: a refund names the purchase it comes back from. */}
          {addIsRefund && (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Refund of
              <Select
                value={refundOf}
                aria-label="Refund of"
                onChange={(e) => setRefundOf(e.target.value)}
                className="w-full"
              >
                <option value="">Choose the purchase</option>
                {purchases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {shortDate(p.date)} · {p.payee || 'Purchase'} · {formatMoney(fromAmount(p.amount), p.currency)}
                  </option>
                ))}
              </Select>
              {purchases.length === 0 && (
                <span className="font-normal text-slate-500">No purchases to refund yet.</span>
              )}
            </label>
          )}
          {/* Rule 78: income reaching a jar-backed account asks how much goes to each jar. */}
          {addIncomeJarsApply && addLedger && (
            <JarAllocationFields
              jars={addJars}
              accountName={addLedger.accountName}
              currency={addLedger.currency}
              amount={addAmountMajor}
              value={addJarAlloc}
              onChange={setAddJarAlloc}
              idPrefix="add"
              emptyNote={
                addIsRefund
                  ? 'Left empty, a refund of a payment from a completed jar, or of the payment a cycle was marked paid with, goes back into that jar; any other stays unallocated.'
                  : undefined
              }
            />
          )}
          {/* Category — hidden for income, per the design; a refund offers the expense/savings
              lines it may reduce. NOT a <label>: the split toggle button must not become the
              label's control (the InfoHint lesson). */}
          {addLineDirection === TransactionType.Expense && (
            <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              <div className="flex items-center justify-between">
                <span>Category</span>
                {!addIsRefund && expenseSplitOptions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (addSplit) resetAddSplit()
                      else setAddSplit(true)
                      setAddPaidFrom(PAID_FROM_UNALLOCATED)
                    }}
                    aria-pressed={addSplit}
                    className="rounded px-1 text-xs font-semibold text-brand-700 transition hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"
                  >
                    {addSplit ? "Don't split" : 'Split across categories'}
                  </button>
                )}
              </div>
              {addSplit ? (
                <div className="space-y-2 rounded-lg border border-slate-200/70 bg-surface-2 p-3 dark:bg-foreground/[0.03]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600">Split lines</span>
                    <SplitRemainderChip
                      remainderMinor={addRemainderMinor}
                      format={(m) => formatMoney(m, addCurrency)}
                    />
                  </div>
                  <SplitLinesEditor
                    rows={addRows}
                    options={expenseSplitOptions}
                    members={members}
                    onChangeRow={updateAddRow}
                    onRemoveRow={removeAddRow}
                  />
                  <button
                    type="button"
                    onClick={addAddRow}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-surface"
                  >
                    + Add line
                  </button>
                </div>
              ) : (
                <Select
                  value={assignTo}
                  aria-label="Assign transaction to"
                  onChange={(e) => {
                    setAssignTo(e.target.value)
                    setAddPaidFrom(PAID_FROM_UNALLOCATED)
                  }}
                  className="w-full"
                >
                  <option value="">
                    {addIsRefund
                      ? transactions.some((t) => t.id === refundOf && t.isSplit)
                        ? 'Choose a category (the purchase is split)'
                        : 'Same category as the purchase'
                      : 'Unassigned'}
                  </option>
                  {/* Income goes on income lines; an expense (or a refund, rule 38) on expense or savings lines. */}
                  {(addIsRefund ? expenseSplitOptions : buildItemOptions(month, addApiType)).map((g) => (
                    <optgroup key={g.category} label={g.category}>
                      {g.items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              )}
              {/* Rule 79: a payment from a jar-backed account on a line that is not a jar asks
                  which jar it comes from. A jar line draws from its jar; no line, from unallocated. */}
              {addPaidFromApplies && addLedger && (
                <PaidFromJarSelect
                  id="add-paid-from"
                  jars={addJars}
                  accountName={addLedger.accountName}
                  currency={addLedger.currency}
                  value={addPaidFrom}
                  onChange={setAddPaidFrom}
                />
              )}
            </div>
          )}
          {members.length >= 2 && !(addSplit && type === TransactionType.Expense) && (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Member
              <Select
                value={member}
                aria-label="Transaction member"
                onChange={(e) => setMember(e.target.value)}
                className="w-full"
              >
                <option value="">No member</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdd(false)
                resetAddSplit()
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => addTransaction()}
              disabled={adding || (addSplit && type === TransactionType.Expense && addRemainderMinor !== 0)}
              aria-label="Add transaction"
            >
              Add transaction
            </Button>
          </div>
        </div>
        ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Left the source account on
              <Input
                type="date"
                value={tDate}
                aria-label="Transfer date"
                disabled={departureLocked}
                onChange={(e) => setTDate(e.target.value)}
                className="w-full text-slate-700"
              />
              {departureLocked && <StatementLockHint />}
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Amount
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={tAmount}
                placeholder="0.00"
                aria-label="Transfer amount"
                // What arrives: fixed by the bank once a statement confirmed the receipt or the
                // return; with only the departure confirmed, the fee takes up the difference.
                disabled={amountLocked}
                onChange={(e) => {
                  setTAmount(e.target.value)
                  if (departureTotalMinor !== null) {
                    const typed = parseMinor(e.target.value)
                    setTFee(typed !== null && typed > 0 && typed < departureTotalMinor ? toEditString(departureTotalMinor - typed) : '')
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTransfer()
                }}
                className="w-full text-right tabular-nums"
              />
              {amountLocked && <StatementLockHint />}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              From
              <Select
                value={tFrom}
                aria-label="Transfer from account"
                disabled={departureLocked}
                onChange={(e) => {
                  setTFrom(e.target.value)
                  setTFromJar(PAID_FROM_UNALLOCATED)
                }}
                className="w-full"
              >
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              {departureLocked && <StatementLockHint />}
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              To
              <Select
                value={tTo}
                aria-label="Transfer to account"
                disabled={receiptLocked}
                onChange={(e) => {
                  setTTo(e.target.value)
                  setTJarAlloc({})
                }}
                className="w-full"
              >
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              {receiptLocked && <StatementLockHint />}
            </label>
          </div>
          {/* Rule 80: money leaving a jar-backed account may say which jar it comes from. */}
          {tFromLedger && tFromJars.length > 0 && (
            <PaidFromJarSelect
              id="transfer-from-jar"
              compact
              jars={tFromJars}
              accountName={tFromLedger.accountName}
              currency={tFromLedger.currency}
              value={tFromJar}
              onChange={setTFromJar}
            />
          )}
          {/* An optional fee: extra money leaving the source with the transfer, recorded as its
              own expense on the departure date, on the line picked here (or uncategorised). */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Fee (optional)
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={tFee}
                placeholder="0.00"
                aria-label="Transfer fee"
                disabled={departureLocked}
                onChange={(e) => setTFee(e.target.value)}
                className="w-full text-right tabular-nums"
              />
              {departureLocked &&
                (amountLocked || departureTotalMinor === null ? (
                  <StatementLockHint />
                ) : (
                  <span className="font-normal text-slate-500">
                    The bank took {formatPlain(departureTotalMinor)} in all; the fee is what the amount leaves of it.
                  </span>
                ))}
            </label>
            {tHasFee && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Fee category
                <Select
                  value={tFeeLine}
                  aria-label="Transfer fee category"
                  onChange={(e) => setTFeeLine(e.target.value)}
                  className="w-full"
                >
                  <option value="">Choose a line…</option>
                  {feeLineOptions.map((g) => (
                    <optgroup key={g.category} label={g.category}>
                      {g.items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {tHasFee && (
            <p className="text-xs text-slate-500">
              The fee leaves {accounts.find((a) => a.id === tFrom)?.name ?? 'the source account'} on top of the
              amount, as its own expense on the same day.
            </p>
          )}
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            Note
            <Input
              type="text"
              value={tPayee}
              placeholder="Transfer"
              aria-label="Transfer note"
              onChange={(e) => setTPayee(e.target.value)}
              className="w-full"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            Arrived in the destination account on (optional)
            <Input
              type="date"
              value={tReceived}
              aria-label="Transfer receipt date"
              // A returned transfer never arrived: clear the return date to record a receipt.
              disabled={receiptLocked || (returnApplies && !!tReturned)}
              onChange={(e) => setTReceived(e.target.value)}
              className="w-full text-slate-700"
            />
            {receiptLocked ? (
              <StatementLockHint />
            ) : (
              <span className="font-normal text-slate-400">
                Leave blank until the receiving bank shows it: the amount stays in transit and belongs to
                neither account until then.
              </span>
            )}
          </label>
          {/* Only a transfer that left and never arrived can have come back to its source. */}
          {returnApplies && (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Returned on (optional)
              <Input
                type="date"
                value={tReturned}
                aria-label="Transfer returned date"
                disabled={returnLocked}
                onChange={(e) => setTReturned(e.target.value)}
                className="w-full text-slate-700"
              />
              {returnLocked ? (
                <StatementLockHint />
              ) : (
                <span className="font-normal text-slate-400">
                  The date the bank sent the money back to {accounts.find((a) => a.id === tFrom)?.name ?? 'the source account'}.
                  {tFromJars.length > 0 && ' It goes back to the jar it left from.'}
                </span>
              )}
            </label>
          )}
          {/* Rule 78: money for a jar-backed account asks how it is divided; while it is in
              transit the answer is kept for the day it arrives (a returned transfer never does). */}
          {tToLedger && tToJars.length > 0 && !(returnApplies && tReturned) && (
            <>
              <JarAllocationFields
                jars={tToJars}
                accountName={tToLedger.accountName}
                currency={tToLedger.currency}
                amount={tAmountMajor}
                value={tJarAlloc}
                onChange={setTJarAlloc}
                idPrefix="transfer"
              />
              {!tReceived && (
                <p className="text-xs text-slate-500">
                  Until it arrives the money is in transit; the jars get their amounts on the day it reaches{' '}
                  {tToLedger.accountName}.
                </p>
              )}
            </>
          )}
          {!editingTransfer && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={tConfirmed}
                aria-label="Transfer completed confirmation"
                onChange={(e) => setTConfirmed(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              I’ve completed this transfer.
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={closeAddModal}>
              Cancel
            </Button>
            {editingTransfer ? (
              <Button onClick={() => submitTransfer()} disabled={transferring} aria-label="Save transfer">
                Save transfer
              </Button>
            ) : (
              <Button onClick={() => submitTransfer()} disabled={transferring} aria-label="Record transfer">
                Record transfer
              </Button>
            )}
          </div>
        </div>
        )}
      </Modal>
      )}

      {/* Cross-month confirm: budgeting a transaction to a line in a different month than its
          date is a deliberate choice (e.g. a purchase that cleared the following month). The
          same prompt serves assign, edit, split and add — Confirm re-runs the action
          acknowledged. */}
      {crossMonthPrompt && (
        <Modal title="Budget to a different month?" onClose={() => setCrossMonthPrompt(null)}>
          <p className="text-sm text-slate-600">{crossMonthPrompt.message}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCrossMonthPrompt(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={crossMonthPrompt.retry} disabled={savingId !== null || adding || transferring}>
              Budget it anyway
            </Button>
          </div>
        </Modal>
      )}

      {/* Rule 79's inline prompt: "+ Assign" put a payment from a jar-backed account on a line
          that is not a jar. Unallocated is the default; closing the prompt saves nothing. */}
      {paidFromPrompt &&
        (() => {
          const { transaction: pt, budgetItemId, value } = paidFromPrompt
          const ledger = ledgerOf(pt.accountId)
          const choose = (paidFromJarId: string | null) => {
            setPaidFromPrompt(null)
            assign(pt.id, budgetItemId, false, paidFromJarId)
          }
          return (
            <Modal title="Which jar does this come from?" onClose={() => setPaidFromPrompt(null)}>
              <p className="text-sm text-slate-600">
                {ledger?.accountName ?? pt.accountName ?? 'This account'} holds jars, and this budget line is not one of
                them. Say which jar pays for {pt.payee || 'this'}, or leave it to the account’s unallocated money.
              </p>
              <div className="mt-3">
                <PaidFromJarSelect
                  id="assign-paid-from"
                  jars={activeJars(ledger)}
                  accountName={ledger?.accountName ?? pt.accountName ?? ''}
                  currency={ledger?.currency ?? pt.currency}
                  value={value}
                  onChange={(next) => setPaidFromPrompt({ ...paidFromPrompt, value: next })}
                />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => choose(null)}>
                  Unallocated
                </Button>
                <Button size="sm" onClick={() => choose(value)} disabled={!value}>
                  Use this jar
                </Button>
              </div>
            </Modal>
          )
        })()}

      {/* Enter the amount in the budget currency for a row recorded in another currency. */}
      {convertingId &&
        (() => {
          const t = transactions.find((x) => x.id === convertingId)
          if (!t) return null
          return (
            <ConvertedAmountModal
              transaction={t}
              budgetCurrency={budgetCurrency}
              onClose={() => setConvertingId(null)}
              onConfirmed={(updated) => {
                setTransactions((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                setConvertingId(null)
                reloadLedgers()
                // A refund's confirmed figure now counts in its purchase's refunded total.
                if (updated.refundOfTransactionId) reloadTransactions()
              }}
            />
          )
        })()}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading &&
        (transactions.length === 0 ? (
          // A failed load has nothing to say "empty" about: the alert above says what happened.
          !loadFailed && (
            <EmptyState
              icon={<TransactionsIcon className="h-6 w-6" />}
              title="No transactions yet"
              description="Use + Add transaction to record one, or Import a bank statement."
            />
          )
        ) : (
          <section
            aria-label="Transactions"
            className={`dash-palette ${DASH_CARD} pt-[18px] pb-3 max-[699.98px]:px-4 max-[699.98px]:pt-3.5 max-[699.98px]:pb-1.5`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                variant="quiet"
                ariaLabel="Filter transactions"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  {
                    value: 'unassigned',
                    label: 'Unassigned',
                    badge: unassignedCount > 0 ? unassignedCount : undefined,
                    description: unassignedCount === 0 ? 'All assigned' : `${unassignedCount} to assign`,
                  },
                ]}
              />
              <div className="flex-1" />
              {query === null ? (
                <button
                  ref={searchButtonRef}
                  type="button"
                  aria-label="Search transactions"
                  onClick={() => setQuery('')}
                  className="grid size-10 shrink-0 place-items-center rounded-full text-slate-500 shadow-[inset_0_0_0_1px_var(--color-border)] transition hover:bg-surface-2 hover:text-slate-900 dark:hover:bg-foreground/7"
                >
                  <Search aria-hidden strokeWidth={1.8} className="size-[18px]" />
                </button>
              ) : (
                // The pill carries the focus ring (focus-within); the field inside drops its own outline.
                <div className="flex h-10 min-w-0 flex-1 basis-[220px] items-center gap-2 rounded-full bg-surface px-3.5 shadow-[inset_0_0_0_1px_var(--color-input)] focus-within:shadow-[inset_0_0_0_2px_var(--color-ring)] min-[700px]:max-w-[320px]">
                  <Search aria-hidden strokeWidth={1.8} className="size-4 shrink-0 text-slate-500" />
                  <input
                    type="search"
                    autoFocus
                    value={query}
                    aria-label="Search transactions"
                    placeholder="Payee, category or account"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        closeSearch()
                      }
                    }}
                    onBlur={(e) => {
                      // Left empty, it closes when focus moves on (not to its own ✕).
                      if (!e.target.value.trim() && !e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setQuery(null)
                    }}
                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline-none! [&::-webkit-search-cancel-button]:appearance-none"
                  />
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={closeSearch}
                    className="relative -mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-slate-500 transition after:absolute after:-inset-1.5 after:content-[''] hover:bg-surface-2 hover:text-slate-900 dark:hover:bg-foreground/7"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </div>
              )}
            </div>
            {/* What the search found, for screen readers (the list itself changes silently). */}
            <p aria-live="polite" className="sr-only">
              {searchText ? `${visible.length} ${visible.length === 1 ? 'transaction' : 'transactions'} found` : ''}
            </p>

            {visible.length === 0 ? (
              <p className="pt-7 pb-5 text-center text-sm text-slate-500">
                {filtered.length === 0
                  ? filter === 'unassigned'
                    ? 'Nothing left to assign.'
                    : 'No transactions yet.'
                  : `No match for “${searchText}”.`}
              </p>
            ) : (
              days.map((d) => (
                <TxDay
                  key={d.date}
                  date={d.date}
                  rows={d.rows}
                  phone={phone}
                  ctx={rowCtx}
                  state={activeIds.length > 0 && d.rows.some((t) => activeIds.includes(t.id)) ? dayState : null}
                />
              ))
            )}
          </section>
        ))}
    </AppShell>
  )
}
