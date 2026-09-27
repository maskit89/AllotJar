import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, SegmentedControl, Select } from '../components/ui'
import { FxPendingTag } from '../components/FxPendingTag'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { ImportIcon, TransactionsIcon } from '../components/icons'
import { useFeatures } from '../features/FeatureContext'
import { useMonth } from '../features/MonthContext'
import { useAuth } from '../auth/AuthContext'
import axios from 'axios'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type {
  AccountDto,
  BudgetMonthDto,
  ConfirmTransferLegsRequest,
  CreateTransferRequest,
  HouseholdMemberDto,
  TransactionDto,
} from '../types'
import { TransactionType } from '../types'
import { formatMoney, formatPlain, fromAmount, parseMinor, sumMinor, toAmount, toEditString } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, monthYear, shortDate } from '../lib/dates'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import { buildItemOptions, jarLinesOf, transactionTypeLabel } from '../lib/transactions'
import { SplitLinesEditor, SplitRemainderChip, type SplitRowDraft } from '../components/SplitLinesEditor'
import { JarAllocationFields } from '../components/jars/JarAllocationFields'
import { PAID_FROM_UNALLOCATED, PaidFromJarSelect } from '../components/jars/PaidFromJarSelect'
import { activeJars, incomingAllocationsOf, paidFromJarOf, useJarLedgers } from '../lib/jarLedgers'
import { fromJarAllocations, toJarAllocations } from '../lib/jarAllocationFields'
import { serverErrors } from '../lib/serverErrors'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * When an assigned transaction is budgeted to a line in a *different* month than its own date
 * (e.g. a 31 Jan purchase budgeted to a February line), returns a compact "Feb 2026"-style label
 * for that line's month so the register can show a "Budgeted to <month>" tag. Returns null when
 * the transaction is unassigned, the line's month wasn't loaded, or the months already match.
 */
function budgetedToLabel(t: TransactionDto): string | null {
  if (!t.budgetItemId || t.budgetItemYear == null || t.budgetItemMonth == null) return null
  const txYear = Number(t.date.slice(0, 4))
  const txMonth = Number(t.date.slice(5, 7))
  if (t.budgetItemYear === txYear && t.budgetItemMonth === txMonth) return null
  return monthYear(`${t.budgetItemYear}-${String(t.budgetItemMonth).padStart(2, '0')}-01`)
}

function blankSplitRows(): SplitRowDraft[] {
  return [
    { budgetItemId: '', amount: '', memberId: '' },
    { budgetItemId: '', amount: '', memberId: '' },
  ]
}

/**
 * The server's cross-month rejection message, if that is what this error is. Every attribution
 * write (assign, edit, split, add) can report it under the `crossMonth` key; the caller then
 * offers to re-send the same request acknowledged instead of showing a generic failure.
 */
function crossMonthError(err: unknown): string | undefined {
  const messages = axios.isAxiosError(err)
    ? (err.response?.data as { errors?: Record<string, string[]> } | undefined)?.errors?.crossMonth
    : undefined
  if (!messages) return undefined
  return messages[0] ?? 'This transaction is dated in a different month than that budget line.'
}

/**
 * The register's compact description of a stored jar split (rules 78/79): "→ Holiday 300.00,
 * Car 200.00" for money put into jars, "from Holiday" for money drawn from one jar (with the
 * amounts when it came from several). Empty when the leg follows the default.
 */
function jarSplitLabels(t: TransactionDto): string[] {
  const postings = (t.jarAllocations ?? []).filter((a) => a.jarId)
  const name = (a: { jarName: string | null }) => a.jarName ?? 'a jar'
  const withAmount = (a: { jarName: string | null; amount: number }) =>
    `${name(a)} ${formatPlain(fromAmount(Math.abs(a.amount)))}`
  const out = postings.filter((a) => a.amount < 0)
  const into = postings.filter((a) => a.amount > 0)
  const labels: string[] = []
  if (out.length === 1) labels.push(`from ${name(out[0])}`)
  else if (out.length > 1) labels.push(`from ${out.map(withAmount).join(', ')}`)
  if (into.length > 0) labels.push(`→ ${into.map(withAmount).join(', ')}`)
  return labels
}

export function TransactionsPage() {
  const features = useFeatures()
  // Recording/editing transactions is day-to-day entry (Limited+); importing needs Admin+.
  const { canEnterData, canWrite } = useAuth()
  const [transactions, setTransactions] = useState<TransactionDto[]>([])
  const [month, setMonth] = useState<BudgetMonthDto | null>(null)
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [members, setMembers] = useState<HouseholdMemberDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
  const [date, setDate] = useState(today)
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [type, setType] = useState<number>(TransactionType.Expense)
  const [assignTo, setAssignTo] = useState('')
  const [account, setAccount] = useState('')
  const [member, setMember] = useState('')
  const [adding, setAdding] = useState(false)
  // Add-modal split mode: the expense is divided across 2+ budget lines at creation.
  const [addSplit, setAddSplit] = useState(false)
  const [addRows, setAddRows] = useState<SplitRowDraft[]>(blankSplitRows)

  // Transfer form state (a completed bank transfer between two of the user's own accounts).
  // tDate is the departure the user confirms; tReceived is optional — left blank, the money is
  // shown in transit until the receipt is confirmed on the register (rule 71).
  const [tDate, setTDate] = useState(today)
  const [tReceived, setTReceived] = useState('')
  const [tConfirmed, setTConfirmed] = useState(false)
  const [tAmount, setTAmount] = useState('')
  const [tFrom, setTFrom] = useState('')
  const [tTo, setTTo] = useState('')
  const [tPayee, setTPayee] = useState('')
  const [transferring, setTransferring] = useState(false)

  // Inline leg confirmation on a transfer row: the receipt date for an in-transit transfer, or
  // the departure date for a receipt held for review.
  const [legId, setLegId] = useState<string | null>(null)
  const [legDate, setLegDate] = useState(today)

  // Register filter — All or just Unassigned (the design's toolbar segmented control).
  const [filter, setFilter] = useState<'all' | 'unassigned'>('all')

  // Which row is showing its inline category picker (the redesign's "+ Assign").
  const [assigningId, setAssigningId] = useState<string | null>(null)

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
  const { ledgers, reload: reloadLedgers } = useJarLedgers()
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

  // Which of the add modal's prompts apply, from its current answers.
  const addLedger = ledgerOf(account)
  const addJars = activeJars(addLedger)
  const addSplitting = addSplit && type === TransactionType.Expense
  const addIncomeJarsApply = addJars.length > 0 && type === TransactionType.Income
  const addPaidFromApplies =
    addJars.length > 0 &&
    type === TransactionType.Expense &&
    (addSplitting
      ? addRows.some((r) => !!r.budgetItemId && !isJarLineFor(r.budgetItemId, account))
      : !!assignTo && !isJarLineFor(assignTo, account))
  const tFromLedger = ledgerOf(tFrom)
  const tFromJars = activeJars(tFromLedger)
  const tToLedger = ledgerOf(tTo)
  const tToJars = activeJars(tToLedger)

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
      .catch(() => !cancelled && setError('Could not load transactions.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const assign = useCallback(
    async (id: string, budgetItemId: string | null, acknowledgeCrossMonth = false, paidFromJarId?: string | null) => {
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
        setTransactions((prev) => prev.map((t) => (t.id === id ? data : t)))
        setCrossMonthPrompt(null)
        reloadLedgers()
      } catch (err) {
        // A cross-month assignment isn't a failure — it's a confirmable choice (a purchase dated
        // last month that you want budgeted to this month's line). The server flags it under the
        // `crossMonth` key; prompt, then re-send acknowledged (with the same jar answer).
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => assign(id, budgetItemId, true, paidFromJarId) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that assignment.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [reloadLedgers],
  )

  // Add-modal split-row helpers (mirror updateSplitRow/addSplitRow/removeSplitRow for the register editor).
  const resetAddSplit = useCallback(() => {
    setAddSplit(false)
    setAddRows(blankSplitRows())
  }, [])
  const updateAddRow = useCallback((index: number, patch: Partial<SplitRowDraft>) => {
    setAddRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }, [])
  const addAddRow = useCallback(() => {
    setAddRows((rows) => [...rows, { budgetItemId: '', amount: '', memberId: '' }])
  }, [])
  const removeAddRow = useCallback((index: number) => {
    setAddRows((rows) => (rows.length > 2 ? rows.filter((_, i) => i !== index) : rows))
  }, [])

  const addTransaction = useCallback(async (acknowledgeCrossMonth = false) => {
    const minor = parseMinor(amount)
    if (minor === null || minor <= 0) {
      setError('Enter a valid amount greater than zero.')
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
        type,
        // A split transaction carries no whole-transaction category/member — the slices do.
        budgetItemId: splitting ? null : assignTo || null,
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
      })
      setTransactions((prev) => [data, ...prev])
      reloadLedgers()
      track(EVENTS.transactionAdded, {
        line_type: type === TransactionType.Income ? 'income' : 'expense',
        ...(splitting ? { split: true } : {}),
      })
      setPayee('')
      setAmount('')
      // Reset the category back to its Unassigned default too — otherwise a later "unassigned" add
      // silently inherits the previous line and the server-side auto-categorizer never runs.
      setAssignTo('')
      resetAddSplit()
      resetAddJarPrompts()
      setShowAdd(false)
      setCrossMonthPrompt(null)
    } catch (err) {
      // A backdated entry put on this month's line is the same confirmable cross-month choice.
      const crossMonth = crossMonthError(err)
      if (crossMonth && !acknowledgeCrossMonth) {
        setCrossMonthPrompt({ message: crossMonth, retry: () => addTransaction(true) })
      } else {
        // Rule 74 refusals ("Savings would be -50.00 EUR on …") and jar validation show verbatim.
        setError(serverErrors(err) ?? 'Could not add that transaction.')
      }
    } finally {
      setAdding(false)
    }
  }, [
    date, payee, amount, type, assignTo, account, member, addSplit, addRows, resetAddSplit,
    addIncomeJarsApply, addJarAlloc, addPaidFromApplies, addPaidFrom, resetAddJarPrompts, reloadLedgers,
  ])

  const addTransfer = useCallback(async () => {
    const minor = parseMinor(tAmount)
    if (minor === null || minor <= 0) {
      setError('Enter a valid transfer amount greater than zero.')
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
    if (tReceived && tReceived < tDate) {
      setError('The receipt date can’t be before the departure date.')
      return
    }
    if (!tConfirmed) {
      setError('Confirm that you’ve completed this transfer before recording it.')
      return
    }
    setTransferring(true)
    setError(null)
    try {
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
      if (tToJars.length > 0 && tReceived) {
        const rows = toJarAllocations(tJarAlloc)
        if (rows.length > 0) body.jarAllocations = rows
      }
      const { data } = await api.post<TransactionDto>('/transactions/transfer', body)
      setTransactions((prev) => [data, ...prev])
      reloadLedgers()
      track(EVENTS.transferCreated)
      setTAmount('')
      setTPayee('')
      setTReceived('')
      setTConfirmed(false)
      resetAddJarPrompts()
      setShowAdd(false)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not record that transfer.')
    } finally {
      setTransferring(false)
    }
  }, [tDate, tReceived, tConfirmed, tAmount, tFrom, tTo, tPayee, tFromJars, tFromJar, tToJars, tJarAlloc, resetAddJarPrompts, reloadLedgers])

  /** Confirm the bank leg a transfer is still missing (never rewrites a confirmed one). */
  const confirmLeg = useCallback(
    async (t: TransactionDto) => {
      if (!legDate) return
      const body: ConfirmTransferLegsRequest = {}
      if (t.transferStatus === 'PendingReview') {
        body.departedOn = legDate
        // Rule 80: the departure from a jar-backed account may name the jar it left.
        if (jarsOf(t.accountId).length > 0) body.fromJarId = legFromJar || null
      } else {
        body.receivedOn = legDate
        // Rule 78: the receipt into a jar-backed account says how it is divided among its jars.
        const rows = jarsOf(t.transferAccountId).length > 0 ? toJarAllocations(legJarAlloc) : []
        if (rows.length > 0) body.jarAllocations = rows
      }
      setSavingId(t.id)
      setError(null)
      try {
        const { data } = await api.put<TransactionDto>(`/transactions/${t.id}/transfer-legs`, body)
        setTransactions((prev) => prev.map((x) => (x.id === t.id ? data : x)))
        setLegId(null)
        reloadLedgers()
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not confirm that transfer.')
      } finally {
        setSavingId(null)
      }
    },
    [legDate, legFromJar, legJarAlloc, jarsOf, reloadLedgers],
  )

  const removeTransaction = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    try {
      await api.delete(`/transactions/${id}`)
      setTransactions((prev) => prev.filter((t) => t.id !== id))
      reloadLedgers()
      track(EVENTS.transactionDeleted)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not delete that transaction.')
    } finally {
      setSavingId(null)
    }
  }, [reloadLedgers])

  function startEdit(t: TransactionDto) {
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
  }

  const saveEdit = useCallback(
    async (t: TransactionDto, acknowledgeCrossMonth = false) => {
      const minor = parseMinor(eAmount)
      if (minor === null || minor <= 0) {
        setError('Enter a valid amount greater than zero.')
        return
      }
      const id = t.id
      const backsJars = jarsOf(eAccount).length > 0
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
          ...(backsJars && eType === TransactionType.Expense
            ? { paidFromJarId: hasNonJarLine(t, eAccount || null) ? ePaidFrom || null : null }
            : {}),
        })
        setTransactions((prev) => prev.map((x) => (x.id === id ? data : x)))
        reloadLedgers()
        track(EVENTS.transactionEdited)
        setEditingId(null)
        setCrossMonthPrompt(null)
      } catch (err) {
        // Moving an assigned/split transaction into another month keeps it budgeted to the
        // original month's line — a confirmable choice, not a failure.
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => saveEdit(t, true) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that change.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [eDate, ePayee, eAmount, eType, eAccount, eMember, eJarAlloc, ePaidFrom, jarsOf, hasNonJarLine, reloadLedgers],
  )

  function startSplit(t: TransactionDto) {
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
      setSplitRows([
        { budgetItemId: t.budgetItemId ?? '', amount: '', memberId: t.memberId ?? '' },
        { budgetItemId: '', amount: '', memberId: '' },
      ])
    }
  }

  function cancelSplit() {
    setSplittingId(null)
    setSplitRows([])
  }

  const removeSplit = useCallback(
    async (id: string) => {
      await assign(id, null) // clearing the assignment drops the split server-side
      cancelSplit()
    },
    [assign],
  )

  function updateSplitRow(
    index: number,
    patch: Partial<{ budgetItemId: string; amount: string; memberId: string }>,
  ) {
    setSplitRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addSplitRow() {
    setSplitRows((rows) => [...rows, { budgetItemId: '', amount: '', memberId: '' }])
  }

  function removeSplitRow(index: number) {
    setSplitRows((rows) => (rows.length > 2 ? rows.filter((_, i) => i !== index) : rows))
  }

  const saveSplit = useCallback(
    async (t: TransactionDto, acknowledgeCrossMonth = false) => {
      const parsed = splitRows.map((r) => ({
        budgetItemId: r.budgetItemId,
        memberId: r.memberId,
        minor: parseMinor(r.amount),
      }))
      if (parsed.length < 2 || parsed.some((a) => !a.budgetItemId || a.minor === null || a.minor <= 0)) {
        setError('Give every split line a category and an amount greater than zero.')
        return
      }
      const allocatedMinor = sumMinor(parsed.map((a) => a.minor as number))
      if (allocatedMinor !== fromAmount(t.amount)) {
        setError('The split lines must add up to the transaction total.')
        return
      }
      // Rule 79: the slices on lines that are not jars draw from the named jar (null = unallocated).
      const paidFromApplies =
        t.type === TransactionType.Expense &&
        jarsOf(t.accountId).length > 0 &&
        parsed.some((a) => !isJarLineFor(a.budgetItemId, t.accountId))
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
        })
        setTransactions((prev) => prev.map((x) => (x.id === t.id ? data : x)))
        cancelSplit()
        setCrossMonthPrompt(null)
        reloadLedgers()
      } catch (err) {
        // Splitting an older transaction across this month's lines is the same confirmable
        // cross-month choice as a whole assignment.
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => saveSplit(t, true) })
        } else {
          setError(serverErrors(err) ?? 'Could not save that split.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [splitRows, splitPaidFrom, jarsOf, isJarLineFor, reloadLedgers],
  )

  const optionGroups = buildItemOptions(month)
  // Split rows only ever target expense/savings lines (the add modal offers splits for expenses).
  const expenseSplitOptions = buildItemOptions(month, TransactionType.Expense)
  const addRemainderMinor = (parseMinor(amount) ?? 0) - sumMinor(addRows.map((r) => parseMinor(r.amount) ?? 0))
  const addCurrency = month?.baseCurrency ?? 'EUR'
  // The prompts' "stays unallocated" line needs the arriving amount in major units (null while unparsable).
  const addMinor = parseMinor(amount)
  const addAmountMajor = addMinor === null ? null : toAmount(addMinor)
  const tMinor = parseMinor(tAmount)
  const tAmountMajor = tMinor === null ? null : toAmount(tMinor)
  const eMinor = parseMinor(eAmount)
  const eAmountMajor = eMinor === null ? null : toAmount(eMinor)

  // Map each budget line to its category's hue, so an assigned transaction's pill
  // carries the same colour dot as its group on the Budget screen. Income lines
  // read as the brand green; expense/fund groups cycle the five-hue palette.
  const itemHue = useMemo(() => {
    const map: Record<string, CategoryHue | 'income'> = {}
    if (!month) return map
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const hue: CategoryHue | 'income' =
        c.kind === 'Income' ? 'income' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) map[it.id] = hue
    }
    return map
  }, [month])

  // Hero totals — derived (never stored), like the budget's read-time actuals.
  const moneyInMinor = useMemo(
    () => sumMinor(transactions.filter((t) => t.type === TransactionType.Income).map((t) => fromAmount(t.amount))),
    [transactions],
  )
  const moneyOutMinor = useMemo(
    () => sumMinor(transactions.filter((t) => t.type === TransactionType.Expense).map((t) => fromAmount(t.amount))),
    [transactions],
  )
  const unassignedCount = useMemo(
    () =>
      transactions.filter(
        (t) => t.type !== TransactionType.Transfer && !t.isSplit && t.budgetItemId === null,
      ).length,
    [transactions],
  )
  const { label: monthLabel } = useMonth()
  const currency = month?.baseCurrency ?? 'EUR'

  // Budget lines that are bills (have a due day) — so an assigned transaction can
  // show the "Bill" tag, like the design's Vodafone → Internet row.
  const billItemIds = useMemo(() => {
    const set = new Set<string>()
    month?.categories.forEach((c) => c.items.forEach((i) => i.dueDay != null && set.add(i.id)))
    return set
  }, [month])

  // Pill colours for a category's hue (or income / unknown). The dot carries the
  // colour (>=3:1); the pill text stays --ink (text-slate-900) per the contrast rule.
  type HueKey = CategoryHue | 'income' | undefined
  const dotColor = (h: HueKey) =>
    h === undefined ? 'var(--color-slate-400)' : h === 'income' ? 'var(--color-brand-600)' : hueColor(h)
  const tintColor = (h: HueKey) =>
    h === undefined
      ? 'var(--color-slate-100)'
      : h === 'income'
        ? 'color-mix(in srgb, var(--color-brand-600) 14%, transparent)'
        : hueTint(h)

  const visible = useMemo(() => {
    if (filter === 'all') return transactions
    // "Unassigned": external (non-transfer) transactions not yet given a budget line.
    return transactions.filter(
      (t) => t.type !== TransactionType.Transfer && !t.isSplit && t.budgetItemId === null,
    )
  }, [transactions, filter])

  return (
    <AppShell active="transactions" title="Transactions">
        <Hero
          eyebrow={`Money in · ${monthLabel}`}
          amount={`+${formatMoney(moneyInMinor, currency)}`}
          amountLabel={`Money in for ${monthLabel}: ${formatMoney(moneyInMinor, currency)}`}
          tiles={[
            { label: 'Money out', value: formatMoney(moneyOutMinor, currency) },
            {
              label: 'Unassigned',
              value: unassignedCount === 0 ? 'All assigned' : `${unassignedCount} to assign`,
            },
          ]}
        />

        {error && !showAdd && <ErrorBanner>{error}</ErrorBanner>}

        {/* Add transaction / transfer — a modal opened from the toolbar's + button. */}
        {showAdd && canEnterData && (
        <Modal
          title={mode === 'transfer' ? 'Record a transfer' : 'Add a transaction'}
          onClose={() => {
            setShowAdd(false)
            resetAddSplit()
          }}
        >
          {accounts.length >= 2 && (
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
                    if (next === TransactionType.Income) resetAddSplit()
                    // The jar prompts belong to one direction each.
                    setAddJarAlloc({})
                    setAddPaidFrom(PAID_FROM_UNALLOCATED)
                  }}
                  className="w-full"
                >
                  <option value={TransactionType.Expense}>Expense</option>
                  <option value={TransactionType.Income}>Income</option>
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
              />
            )}
            {/* Category — hidden for income, per the design. NOT a <label>: the split toggle
                button must not become the label's control (the InfoHint lesson). */}
            {type === TransactionType.Expense && (
              <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                <div className="flex items-center justify-between">
                  <span>Category</span>
                  {expenseSplitOptions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (addSplit) resetAddSplit()
                        else setAddSplit(true)
                        setAddPaidFrom(PAID_FROM_UNALLOCATED)
                      }}
                      aria-pressed={addSplit}
                      className="rounded px-1 text-xs font-semibold text-violet-600 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-500/10"
                    >
                      {addSplit ? "Don't split" : 'Split across categories'}
                    </button>
                  )}
                </div>
                {addSplit ? (
                  <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-500/30 dark:bg-violet-500/5">
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
                      aria-label="Add split line"
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
                    <option value="">Unassigned</option>
                    {optionGroups.map((g) => (
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
                  onChange={(e) => setTDate(e.target.value)}
                  className="w-full text-slate-700"
                />
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
                  onChange={(e) => setTAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addTransfer()
                  }}
                  className="w-full text-right tabular-nums"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                From
                <Select
                  value={tFrom}
                  aria-label="Transfer from account"
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
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                To
                <Select
                  value={tTo}
                  aria-label="Transfer to account"
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
                onChange={(e) => setTReceived(e.target.value)}
                className="w-full text-slate-700"
              />
              <span className="font-normal text-slate-400">
                Leave blank until the receiving bank shows it: the amount stays in transit and belongs to
                neither account until then.
              </span>
            </label>
            {/* Rule 78: a receipt already dated into a jar-backed account asks how it is divided. */}
            {tToLedger && tToJars.length > 0 && tReceived && (
              <JarAllocationFields
                jars={tToJars}
                accountName={tToLedger.accountName}
                currency={tToLedger.currency}
                amount={tAmountMajor}
                value={tJarAlloc}
                onChange={setTJarAlloc}
                idPrefix="transfer"
              />
            )}
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
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button onClick={addTransfer} disabled={transferring} aria-label="Record transfer">
                Record transfer
              </Button>
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
              <Button size="sm" onClick={crossMonthPrompt.retry} disabled={savingId !== null || adding}>
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

        {loading && <p className="text-slate-500">Loading…</p>}

        {!loading && (
          <>
            {/* Toolbar: All/Unassigned filter + count (left), Add transaction (right). */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <SegmentedControl
                  ariaLabel="Filter transactions"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'unassigned', label: 'Unassigned' },
                  ]}
                />
                <span className="text-sm text-slate-500">{transactions.length} transactions</span>
              </div>
              <div className="flex items-center gap-2">
                {features.camtImport && canWrite && (
                  <Link
                    to="/import"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-surface px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    <ImportIcon className="h-4 w-4" />
                    Import
                  </Link>
                )}
                {canEnterData && (
                  <Button
                    onClick={() => {
                      setMode('transaction')
                      setError(null)
                      // Close the register's inline split editor — the modal's split rows share
                      // its aria-labels, and two mounted editors would collide.
                      cancelSplit()
                      resetAddSplit()
                      resetAddJarPrompts()
                      setShowAdd(true)
                    }}
                    aria-label="Add transaction"
                  >
                    <span aria-hidden className="text-base leading-none">+</span> Add transaction
                  </Button>
                )}
              </div>
            </div>

            {transactions.length === 0 ? (
              <EmptyState
                icon={<TransactionsIcon className="h-6 w-6" />}
                title="No transactions yet"
                description="Use + Add transaction to record one, or Import a bank statement."
              />
            ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] table-fixed text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-[0.05em] text-slate-500">
                    <th className="w-[84px] px-4 py-3 font-bold">Date</th>
                    <th className="px-4 py-3 font-bold">Payee</th>
                    <th className="w-[184px] px-4 py-3 font-bold">Category</th>
                    <th className="w-[148px] px-4 py-3 font-bold">Account</th>
                    <th className="w-[128px] px-4 py-3 text-right font-bold">Amount</th>
                    <th className="w-[80px] px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                        {filter === 'unassigned' ? 'Nothing left to assign.' : 'No transactions yet.'}
                      </td>
                    </tr>
                  )}
                  {visible.map((t) => {
                    const isIncome = transactionTypeLabel(t.type) === 'Income'
                    const isTransfer = t.type === TransactionType.Transfer
                    const editing = editingId === t.id
                    const splitting = splittingId === t.id
                    const splitOptions = buildItemOptions(month, t.type)
                    const totalMinor = fromAmount(t.amount)
                    const allocatedMinor = sumMinor(splitRows.map((r) => parseMinor(r.amount) ?? 0))
                    const remainderMinor = totalMinor - allocatedMinor
                    return (
                      <Fragment key={t.id}>
                      <tr className="group hover:bg-slate-50">
                        {editing ? (
                          <td colSpan={6} className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="date"
                                value={eDate}
                                aria-label="Edit date"
                                onChange={(e) => setEDate(e.target.value)}
                                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                              />
                              <input
                                type="text"
                                value={ePayee}
                                aria-label="Edit payee"
                                onChange={(e) => setEPayee(e.target.value)}
                                className="min-w-32 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                              />
                              <input
                                type="text"
                                inputMode="decimal"
                                {...selectOnFocusProps}
                                value={eAmount}
                                aria-label="Edit amount"
                                onChange={(e) => setEAmount(e.target.value)}
                                className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-sm tabular-nums"
                              />
                              <select
                                value={eType}
                                aria-label="Edit type"
                                onChange={(e) => setEType(Number(e.target.value))}
                                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                              >
                                <option value={TransactionType.Expense}>Expense</option>
                                <option value={TransactionType.Income}>Income</option>
                              </select>
                              {accounts.length > 0 && (
                                <select
                                  value={eAccount}
                                  aria-label="Edit account"
                                  onChange={(e) => {
                                    setEAccount(e.target.value)
                                    // Another account has other jars — start its answers from the default.
                                    setEJarAlloc({})
                                    setEPaidFrom(PAID_FROM_UNALLOCATED)
                                  }}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600"
                                >
                                  <option value="">No account</option>
                                  {accounts.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {members.length >= 2 && (
                                <select
                                  value={eMember}
                                  aria-label="Edit member"
                                  onChange={(e) => setEMember(e.target.value)}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600"
                                >
                                  <option value="">No member</option>
                                  {members.map((m) => (
                                    <option key={m.id} value={m.id}>
                                      {m.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {/* The jar prompts, pre-filled from the stored split (rules 78/79). */}
                              {(() => {
                                const ledger = ledgerOf(eAccount)
                                const jars = activeJars(ledger)
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
                              <div className="ml-auto flex gap-1">
                                <Button size="sm" onClick={() => saveEdit(t)} disabled={savingId === t.id} aria-label="Save transaction">
                                  Save
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} aria-label="Cancel edit">
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td className="whitespace-nowrap px-4 py-3.5 tabular-nums text-slate-500">
                              {shortDate(t.date)}
                            </td>
                            <td className="px-4 py-3.5">
                              <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-900">
                                <span className="truncate">{t.payee || (isTransfer ? 'Transfer' : '—')}</span>
                                {!isTransfer && t.budgetItemId && billItemIds.has(t.budgetItemId) && (
                                  <span className="shrink-0 rounded-[5px] border border-slate-200 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.05em] text-slate-500">
                                    Bill
                                  </span>
                                )}
                                {/* Budgeted to a line in a different month than the transaction's date. */}
                                {!isTransfer && (() => {
                                  const label = budgetedToLabel(t)
                                  return label ? (
                                    <span
                                      title={`Budgeted to a ${label} line, not this transaction's own month`}
                                      className="shrink-0 rounded-[5px] border border-amber-200 bg-amber-50 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
                                    >
                                      Budgeted to {label}
                                    </span>
                                  ) : null
                                })()}
                              </span>
                              {/* A stored jar split (rules 78/79): where this money went, or came from. */}
                              {(() => {
                                const labels = jarSplitLabels(t)
                                return labels.length > 0 ? (
                                  <span className="mt-1 flex flex-wrap gap-1">
                                    {labels.map((label) => (
                                      <Badge key={label} tone="neutral" className="max-w-full" title={`Jars: ${label}`}>
                                        <span className="truncate">{label}</span>
                                      </Badge>
                                    ))}
                                  </span>
                                ) : null
                              })()}
                            </td>
                            <td className="px-4 py-3.5">
                              {isTransfer ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge tone="brand">Transfer</Badge>
                                  {t.transferStatus === 'InTransit' && (
                                    <span
                                      title={`Left ${t.accountName ?? 'the source'} on ${formatDate(t.departedOn ?? t.date)}; receipt not yet confirmed`}
                                      className="rounded-[5px] border border-sky-200 bg-sky-50 px-1.5 py-px text-[9.5px] font-semibold text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300"
                                    >
                                      In transit
                                    </span>
                                  )}
                                  {t.transferStatus === 'PendingReview' && (
                                    <span
                                      title={`Received by ${t.transferAccountName ?? 'the destination'} on ${formatDate(t.receivedOn ?? t.date)}; departure date unknown — nothing is posted until it is supplied`}
                                      className="rounded-[5px] border border-amber-200 bg-amber-50 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
                                    >
                                      Pending review
                                    </span>
                                  )}
                                  {canEnterData && t.transferStatus && t.transferStatus !== 'Completed' && legId !== t.id && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setLegId(t.id)
                                        setLegDate(t.transferStatus === 'PendingReview' ? t.receivedOn ?? today() : t.departedOn ?? today())
                                        setLegJarAlloc({})
                                        setLegFromJar(PAID_FROM_UNALLOCATED)
                                      }}
                                      aria-label={`${t.transferStatus === 'PendingReview' ? 'Add departure date' : 'Confirm receipt'}: ${t.payee || t.date}`}
                                      className="text-[11px] font-semibold text-brand-700 hover:underline dark:text-brand-200"
                                    >
                                      {t.transferStatus === 'PendingReview' ? 'Add departure date' : 'Confirm receipt'}
                                    </button>
                                  )}
                                  {legId === t.id && (
                                    <span className="flex items-center gap-1">
                                      <input
                                        type="date"
                                        value={legDate}
                                        aria-label={t.transferStatus === 'PendingReview' ? 'Departure date' : 'Receipt date'}
                                        onChange={(e) => setLegDate(e.target.value)}
                                        className="rounded-md border border-slate-300 px-1.5 py-0.5 text-xs"
                                      />
                                      <Button size="sm" onClick={() => confirmLeg(t)} disabled={savingId === t.id} aria-label="Save transfer leg">
                                        Save
                                      </Button>
                                      <Button size="sm" variant="ghost" onClick={() => setLegId(null)} aria-label="Cancel transfer leg">
                                        Cancel
                                      </Button>
                                    </span>
                                  )}
                                </div>
                              ) : t.isSplit ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge tone="violet">Split</Badge>
                                  <span className="text-xs text-slate-500">
                                    {t.splits
                                      .map(
                                        (s) =>
                                          `${s.budgetItemName ?? 'Unassigned'}${
                                            s.memberName ? ` (${s.memberName})` : ''
                                          } ${formatMoney(fromAmount(s.amount), t.currency)}`,
                                      )
                                      .join(' · ')}
                                  </span>
                                </div>
                              ) : assigningId === t.id && canEnterData ? (
                                <select
                                  autoFocus
                                  value={t.budgetItemId ?? ''}
                                  disabled={savingId === t.id}
                                  aria-label={`Assign ${t.payee || 'transaction'}`}
                                  onChange={(e) => {
                                    const next = e.target.value || null
                                    setAssigningId(null)
                                    // Rule 79: a payment from a jar-backed account put on a line that is
                                    // not a jar asks which jar it comes from first; a jar line draws from
                                    // its own jar and clearing the line draws from unallocated — no prompt.
                                    if (
                                      next &&
                                      t.type === TransactionType.Expense &&
                                      jarsOf(t.accountId).length > 0 &&
                                      !isJarLineFor(next, t.accountId)
                                    ) {
                                      setPaidFromPrompt({ transaction: t, budgetItemId: next, value: PAID_FROM_UNALLOCATED })
                                    } else {
                                      assign(t.id, next)
                                    }
                                  }}
                                  onBlur={() => setAssigningId(null)}
                                  className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                                >
                                  <option value="">Unassigned</option>
                                  {optionGroups.map((g) => (
                                    <optgroup key={g.category} label={g.category}>
                                      {g.items.map((i) => (
                                        <option key={i.id} value={i.id}>
                                          {i.name}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                              ) : t.budgetItemId ? (
                                // Assigned — a tint pill with a category colour dot (text stays --ink).
                                (() => {
                                  const hue = itemHue[t.budgetItemId]
                                  const pill = (
                                    <>
                                      <span
                                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                                        style={{ background: dotColor(hue) }}
                                        aria-hidden
                                      />
                                      <span className="truncate">{t.budgetItemName}</span>
                                    </>
                                  )
                                  return canEnterData ? (
                                    <button
                                      type="button"
                                      onClick={() => setAssigningId(t.id)}
                                      aria-label={`Reassign ${t.payee || 'transaction'}`}
                                      className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-[12.5px] font-semibold text-slate-900"
                                      style={{ background: tintColor(hue) }}
                                    >
                                      {pill}
                                    </button>
                                  ) : (
                                    <span
                                      className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-[12.5px] font-semibold text-slate-900"
                                      style={{ background: tintColor(hue) }}
                                    >
                                      {pill}
                                    </span>
                                  )
                                })()
                              ) : canEnterData ? (
                                <button
                                  type="button"
                                  onClick={() => setAssigningId(t.id)}
                                  aria-label={`Assign ${t.payee || 'transaction'}`}
                                  className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-slate-400 px-3 py-1 text-[12.5px] font-semibold text-slate-500 transition hover:border-brand-600 hover:text-brand-700"
                                >
                                  + Assign
                                </button>
                              ) : (
                                <span className="text-sm text-slate-600">Unassigned</span>
                              )}
                            </td>
                            <td className="truncate px-4 py-3.5 text-sm text-slate-500">
                              {isTransfer
                                ? `${t.accountName ?? '—'} → ${t.transferAccountName ?? '—'}`
                                : t.accountName ?? '—'}
                            </td>
                            <td
                              className={`whitespace-nowrap px-4 py-3.5 text-right font-semibold tabular-nums ${
                                isTransfer
                                  ? 'text-slate-500'
                                  : isIncome
                                    ? 'text-brand-700 dark:text-brand-200'
                                    : 'text-slate-900'
                              }`}
                            >
                              {t.fxPending && <FxPendingTag />}
                              {isTransfer ? '' : isIncome ? '+' : '−'}
                              {formatMoney(fromAmount(t.amount), t.currency)}
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              {canEnterData && (
                              // Always visible (not hover-revealed): the tester never found the
                              // split action, and touch devices have no hover at all.
                              <div className="flex justify-end gap-1">
                                {!isTransfer && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => startEdit(t)}
                                      aria-label={`Edit transaction: ${t.payee || t.date}`}
                                      title="Edit transaction"
                                      className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                    >
                                      ✎
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => startSplit(t)}
                                      aria-label={`Split transaction: ${t.payee || t.date}`}
                                      title="Split across budget lines"
                                      className="rounded-md px-2 py-1 text-slate-500 hover:bg-violet-50 hover:text-violet-600"
                                    >
                                      ⑂
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeTransaction(t.id)}
                                  disabled={savingId === t.id}
                                  aria-label={`Delete transaction: ${t.payee || t.date}`}
                                  title="Delete transaction"
                                  className="rounded-md px-2 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                                >
                                  ✕
                                </button>
                              </div>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                      {/* The jar question of the leg being confirmed (rules 78/80), under its row so
                          the fields have room: a receipt into a jar-backed account asks how it is
                          divided; a departure from one may name the jar it left. */}
                      {legId === t.id &&
                        (() => {
                          const pending = t.transferStatus === 'PendingReview'
                          const ledger = ledgerOf(pending ? t.accountId : t.transferAccountId)
                          const jars = activeJars(ledger)
                          if (!ledger || jars.length === 0) return null
                          return (
                            <tr className="bg-sky-50/40 dark:bg-sky-400/5">
                              <td colSpan={6} className="px-4 py-3">
                                {pending ? (
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
                                )}
                              </td>
                            </tr>
                          )
                        })()}
                      {splitting && (
                        <tr className="bg-violet-50/40">
                          <td colSpan={6} className="px-4 py-4">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <h4 className="text-sm font-semibold text-slate-700">
                                  Split “{t.payee || t.date}” ({formatMoney(totalMinor, t.currency)})
                                </h4>
                                <SplitRemainderChip
                                  remainderMinor={remainderMinor}
                                  format={(m) => formatMoney(m, t.currency)}
                                />
                              </div>

                              {splitOptions.length === 0 && (
                                <p className="text-xs text-rose-600">
                                  Add some {isIncome ? 'income' : 'expense'} budget lines first.
                                </p>
                              )}

                              <SplitLinesEditor
                                rows={splitRows}
                                options={splitOptions}
                                members={members}
                                onChangeRow={updateSplitRow}
                                onRemoveRow={removeSplitRow}
                              />

                              {/* Rule 79: the slices on lines that are not jars draw from one named jar. */}
                              {(() => {
                                const ledger = ledgerOf(t.accountId)
                                const jars = activeJars(ledger)
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

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={addSplitRow}
                                  aria-label="Add split line"
                                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-surface"
                                >
                                  + Add line
                                </button>
                                {t.isSplit && (
                                  <button
                                    type="button"
                                    onClick={() => removeSplit(t.id)}
                                    disabled={savingId === t.id}
                                    aria-label="Remove split"
                                    className="rounded-md px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                                  >
                                    Remove split
                                  </button>
                                )}
                                <div className="flex-1" />
                                <button
                                  type="button"
                                  onClick={() => saveSplit(t)}
                                  disabled={savingId === t.id || remainderMinor !== 0}
                                  aria-label="Save split"
                                  className="rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                                >
                                  Save split
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelSplit}
                                  aria-label="Cancel split"
                                  className="rounded-md px-3 py-1 text-xs text-slate-500 hover:bg-slate-100"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </Card>
            )}
          </>
        )}
    </AppShell>
  )
}
