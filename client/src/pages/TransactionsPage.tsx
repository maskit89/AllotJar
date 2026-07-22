import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, SegmentedControl, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { ImportIcon, TransactionsIcon } from '../components/icons'
import { useFeatures } from '../features/FeatureContext'
import { useMonth } from '../features/MonthContext'
import { useAuth } from '../auth/AuthContext'
import axios from 'axios'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, BudgetMonthDto, HouseholdMemberDto, TransactionDto } from '../types'
import { TransactionType } from '../types'
import { formatMoney, fromAmount, parseMinor, sumMinor, toAmount } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { monthYear, shortDate } from '../lib/dates'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import { buildItemOptions, transactionTypeLabel } from '../lib/transactions'
import { SplitLinesEditor, SplitRemainderChip, type SplitRowDraft } from '../components/SplitLinesEditor'

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

  // Transfer form state (move money between two of the user's own accounts).
  const [tDate, setTDate] = useState(today)
  const [tAmount, setTAmount] = useState('')
  const [tFrom, setTFrom] = useState('')
  const [tTo, setTTo] = useState('')
  const [tPayee, setTPayee] = useState('')
  const [transferring, setTransferring] = useState(false)

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
    async (id: string, budgetItemId: string | null, acknowledgeCrossMonth = false) => {
      setSavingId(id)
      setError(null)
      try {
        const body = acknowledgeCrossMonth ? { budgetItemId, acknowledgeCrossMonth: true } : { budgetItemId }
        const { data } = await api.put<TransactionDto>(`/transactions/${id}/assignment`, body)
        setTransactions((prev) => prev.map((t) => (t.id === id ? data : t)))
        setCrossMonthPrompt(null)
      } catch (err) {
        // A cross-month assignment isn't a failure — it's a confirmable choice (a purchase dated
        // last month that you want budgeted to this month's line). The server flags it under the
        // `crossMonth` key; prompt, then re-send acknowledged.
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => assign(id, budgetItemId, true) })
        } else {
          setError('Could not save that assignment.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [],
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
      })
      setTransactions((prev) => [data, ...prev])
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
      setShowAdd(false)
      setCrossMonthPrompt(null)
    } catch (err) {
      // A backdated entry put on this month's line is the same confirmable cross-month choice.
      const crossMonth = crossMonthError(err)
      if (crossMonth && !acknowledgeCrossMonth) {
        setCrossMonthPrompt({ message: crossMonth, retry: () => addTransaction(true) })
      } else {
        setError('Could not add that transaction.')
      }
    } finally {
      setAdding(false)
    }
  }, [date, payee, amount, type, assignTo, account, member, addSplit, addRows, resetAddSplit])

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
    setTransferring(true)
    setError(null)
    try {
      const { data } = await api.post<TransactionDto>('/transactions/transfer', {
        date: tDate,
        amount: toAmount(minor),
        fromAccountId: tFrom,
        toAccountId: tTo,
        payee: tPayee || null,
      })
      setTransactions((prev) => [data, ...prev])
      track(EVENTS.transferCreated)
      setTAmount('')
      setTPayee('')
      setShowAdd(false)
    } catch {
      setError('Could not record that transfer.')
    } finally {
      setTransferring(false)
    }
  }, [tDate, tAmount, tFrom, tTo, tPayee])

  const removeTransaction = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    try {
      await api.delete(`/transactions/${id}`)
      setTransactions((prev) => prev.filter((t) => t.id !== id))
      track(EVENTS.transactionDeleted)
    } catch {
      setError('Could not delete that transaction.')
    } finally {
      setSavingId(null)
    }
  }, [])

  function startEdit(t: TransactionDto) {
    setSplittingId(null)
    setEditingId(t.id)
    setEDate(t.date)
    setEPayee(t.payee)
    setEAmount(String(t.amount))
    setEType(t.type)
    setEAccount(t.accountId ?? '')
    setEMember(t.memberId ?? '')
  }

  const saveEdit = useCallback(
    async (id: string, acknowledgeCrossMonth = false) => {
      const minor = parseMinor(eAmount)
      if (minor === null || minor <= 0) {
        setError('Enter a valid amount greater than zero.')
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
        })
        setTransactions((prev) => prev.map((t) => (t.id === id ? data : t)))
        track(EVENTS.transactionEdited)
        setEditingId(null)
        setCrossMonthPrompt(null)
      } catch (err) {
        // Moving an assigned/split transaction into another month keeps it budgeted to the
        // original month's line — a confirmable choice, not a failure.
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => saveEdit(id, true) })
        } else {
          setError('Could not save that change.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [eDate, ePayee, eAmount, eType, eAccount, eMember],
  )

  function startSplit(t: TransactionDto) {
    setEditingId(null)
    setSplittingId(t.id)
    if (t.isSplit && t.splits.length > 0) {
      setSplitRows(
        t.splits.map((s) => ({
          budgetItemId: s.budgetItemId ?? '',
          amount: String(s.amount),
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
        })
        setTransactions((prev) => prev.map((x) => (x.id === t.id ? data : x)))
        cancelSplit()
        setCrossMonthPrompt(null)
      } catch (err) {
        // Splitting an older transaction across this month's lines is the same confirmable
        // cross-month choice as a whole assignment.
        const crossMonth = crossMonthError(err)
        if (crossMonth && !acknowledgeCrossMonth) {
          setCrossMonthPrompt({ message: crossMonth, retry: () => saveSplit(t, true) })
        } else {
          setError('Could not save that split.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [splitRows],
  )

  const optionGroups = buildItemOptions(month)
  // Split rows only ever target expense/savings lines (the add modal offers splits for expenses).
  const expenseSplitOptions = buildItemOptions(month, TransactionType.Expense)
  const addRemainderMinor = (parseMinor(amount) ?? 0) - sumMinor(addRows.map((r) => parseMinor(r.amount) ?? 0))
  const addCurrency = month?.baseCurrency ?? 'EUR'

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
                    onChange={(e) => setAccount(e.target.value)}
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
            {/* Category — hidden for income, per the design. NOT a <label>: the split toggle
                button must not become the label's control (the InfoHint lesson). */}
            {type === TransactionType.Expense && (
              <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                <div className="flex items-center justify-between">
                  <span>Category</span>
                  {expenseSplitOptions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => (addSplit ? resetAddSplit() : setAddSplit(true))}
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
                    onChange={(e) => setAssignTo(e.target.value)}
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
                Date
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
                  onChange={(e) => setTFrom(e.target.value)}
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
                  onChange={(e) => setTTo(e.target.value)}
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
                                  onChange={(e) => setEAccount(e.target.value)}
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
                              <div className="ml-auto flex gap-1">
                                <Button size="sm" onClick={() => saveEdit(t.id)} disabled={savingId === t.id} aria-label="Save transaction">
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
                            </td>
                            <td className="px-4 py-3.5">
                              {isTransfer ? (
                                <Badge tone="brand">Transfer</Badge>
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
                                    assign(t.id, e.target.value || null)
                                    setAssigningId(null)
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
