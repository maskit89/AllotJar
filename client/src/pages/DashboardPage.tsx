import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import { useAuth } from '../auth/AuthContext'
import { AppShell } from '../components/AppShell'
import type {
  BudgetMonthDto,
  BudgetMonthSummaryDto,
  BudgetTemplateDto,
  JarDto,
} from '../types'
import {
  billAlerts,
  billsSummary,
  categoryActual,
  categoryPlanned,
  fromDto,
  findItem,
  isSavings,
  isIncome,
  monthPlanned,
  remainingToBudget,
  totalIncome,
  withCategoryName,
  withItemBill,
  withItemName,
  withItemPaid,
  withItemPlanned,
  withNewCategory,
  withNewItem,
  withoutCategory,
  withoutItem,
  withReorderedExpenseCategories,
  withReorderedItems,
  type MonthVM,
} from '../budgetModel'
import { currencyNoun, formatMoney, fromAmount, sumMinor, toAmount, type Minor } from '../lib/money'
import { jarStatusChip } from '../lib/jarStatus'
import { Hero, BalancedBadge } from '../components/Hero'
import { Badge, Card } from '../components/ui'
import { Jar } from '../components/Jar'
import { hueForIndex } from '../lib/categoryColors'
import { CategoryAccordion } from '../components/CategoryAccordion'
import { SavingsGroup } from '../components/SavingsGroup'
import { IncomeGroup } from '../components/IncomeGroup'
import { useMonth } from '../features/MonthContext'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function DashboardPage({ today = new Date() }: { today?: Date } = {}) {
  // Building/editing the budget (groups, lines, months) needs Admin+ (canWrite).
  const { canWrite } = useAuth()
  // The viewed month comes from the app-wide top bar (MonthContext).
  const { year, month: monthNum } = useMonth()
  const [month, setMonth] = useState<MonthVM | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryIsSavings, setNewCategoryIsSavings] = useState(false)
  const [addingGroup, setAddingGroup] = useState(false)
  const [months, setMonths] = useState<BudgetMonthSummaryDto[]>([])
  const [templates, setTemplates] = useState<BudgetTemplateDto[]>([])
  // The "Your jars" shelf — the household's jars, with goal progress.
  const [jars, setJars] = useState<JarDto[]>([])

  // Load the viewed month whenever it changes; a 404 means "no budget yet".
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    // Clear the previous month before fetching, so its Hero/jars/lines can never
    // render for a beat under the newly-selected month's label on a slow link.
    setMonth(null)
    api
      .get<BudgetMonthDto>(`/budget/${year}/${monthNum}`)
      .then(({ data }) => {
        if (!cancelled) setMonth(fromDto(data))
      })
      .catch((err) => {
        if (cancelled) return
        setMonth(null)
        if (err?.response?.status === 404) setNotFound(true)
        else setError('Could not load your budget. Is the API running?')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [year, monthNum])

  const refreshMonths = useCallback(() => {
    api
      .get<BudgetMonthSummaryDto[]>('/budget/months')
      .then(({ data }) => setMonths(data))
      .catch(() => {})
  }, [])

  useEffect(() => refreshMonths(), [refreshMonths])

  // The quick-start templates are a static catalogue — load them once.
  useEffect(() => {
    api
      .get<BudgetTemplateDto[]>('/budget/templates')
      .then(({ data }) => setTemplates(data))
      .catch(() => {})
  }, [])

  // The sinking-fund jars for the "Your jars" shelf — load once. Guarded so a
  // non-array (or a failed fetch) leaves the shelf empty rather than throwing.
  useEffect(() => {
    api
      .get<JarDto[]>('/jars')
      .then(({ data }) => setJars(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // The most recent month strictly before the viewed one — what "copy" actually
  // copies (which may not be literally last month, if a month was skipped).
  const prevBudget = useMemo(
    () =>
      months
        .filter((m) => m.year < year || (m.year === year && m.month < monthNum))
        .sort((a, b) => b.year - a.year || b.month - a.month)[0] ?? null,
    [months, year, monthNum],
  )

  // Create the viewed month — copying the previous month's plan, or blank.
  const createMonth = useCallback(
    async (copyFromPrevious: boolean) => {
      setCreating(true)
      setError(null)
      try {
        const { data } = await api.post<BudgetMonthDto>('/budget', {
          year,
          month: monthNum,
          copyFromPrevious,
        })
        setMonth(fromDto(data))
        setNotFound(false)
        refreshMonths()
        track(EVENTS.budgetMonthCreated, { source: copyFromPrevious ? 'copy' : 'blank' })
      } catch {
        setError('Could not create that budget.')
      } finally {
        setCreating(false)
      }
    },
    [year, monthNum, refreshMonths],
  )

  // Create the viewed month from a quick-start template.
  const createFromTemplate = useCallback(
    async (templateKey: string) => {
      setCreating(true)
      setError(null)
      try {
        const { data } = await api.post<BudgetMonthDto>('/budget', {
          year,
          month: monthNum,
          copyFromPrevious: false,
          templateKey,
        })
        setMonth(fromDto(data))
        setNotFound(false)
        refreshMonths()
        track(EVENTS.budgetMonthCreated, { source: 'template' })
      } catch {
        setError('Could not create that budget.')
      } finally {
        setCreating(false)
      }
    },
    [year, monthNum, refreshMonths],
  )

  // Optimistic commit: apply the edit locally and recompute the banner instantly
  // (exact integer math), then persist. The server stores precisely what we send,
  // so success keeps the optimistic state; a failure rolls back and explains why.
  const commitItem = useCallback(
    async (itemId: string, plannedMinor: Minor) => {
      if (!month) return

      const snapshot = month // captured synchronously for a clean rollback
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemPlanned(month, itemId, plannedMinor)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}`, { plannedAmount: toAmount(plannedMinor) })
        track(EVENTS.budgetItemEdited, { context: 'planned' })
      } catch {
        setMonth(snapshot) // roll back to the pre-edit state
        setError('Could not save that change — reverted to the previous value.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month],
  )

  // Mark a line as a bill due on a day of the month (or clear it with null).
  const setBill = useCallback(
    async (itemId: string, dueDay: number | null) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemBill(month, itemId, dueDay)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}/bill`, { dueDay })
      } catch {
        setMonth(snapshot)
        setError('Could not update that bill — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month],
  )

  // Toggle a bill line's paid status for this month.
  const setPaid = useCallback(
    async (itemId: string, isPaid: boolean) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemPaid(month, itemId, isPaid)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}/paid`, { isPaid })
      } catch {
        setMonth(snapshot)
        setError('Could not update that bill — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month],
  )

  // Rename a line. The update endpoint takes the planned amount too, so we send
  // the line's current planned value alongside the new name.
  const renameItem = useCallback(
    async (itemId: string, name: string) => {
      if (!month) return
      const current = findItem(month, itemId)
      if (!current) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemName(month, itemId, name)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}`, {
          plannedAmount: toAmount(current.plannedMinor),
          name,
        })
      } catch {
        setMonth(snapshot)
        setError('Could not rename that line — reverted to the previous name.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month],
  )

  // Add a line to a category. We show a temp row instantly, then reconcile from
  // the server response to pick up the real id and display order.
  const addItem = useCallback(
    async (categoryId: string, name: string) => {
      if (!month) return

      const snapshot = month
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setError(null)
      setMonth(
        withNewItem(month, categoryId, {
          id: tempId,
          name,
          displayOrder: Number.MAX_SAFE_INTEGER,
          plannedMinor: 0,
          actualMinor: 0,
          savingsAvailableMinor: null,
          dueDay: null,
          isPaid: false,
        }),
      )

      try {
        const { data } = await api.post<BudgetMonthDto>(
          `/budget/categories/${categoryId}/items`,
          { name, plannedAmount: 0 },
        )
        setMonth(fromDto(data)) // reconcile temp row -> real server row
      } catch {
        setMonth(snapshot)
        setError('Could not add that line — reverted.')
      }
    },
    [month],
  )

  // Delete a line. Optimistically remove it, then reconcile from the response.
  const deleteItem = useCallback(
    async (itemId: string) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withoutItem(month, itemId)) // optimistic

      try {
        const { data } = await api.delete<BudgetMonthDto>(`/budget/items/${itemId}`)
        setMonth(fromDto(data))
      } catch {
        setMonth(snapshot)
        setError('Could not delete that line — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month],
  )

  // Add an expense or fund category group. Temp group shown instantly, then reconciled.
  const addCategory = useCallback(
    async (name: string, asSavings: boolean) => {
      if (!month) return

      const snapshot = month
      const tempId = `temp-cat-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setError(null)
      setMonth(
        withNewCategory(month, {
          id: tempId,
          name,
          kind: asSavings ? 'savings' : 'expense',
          displayOrder: Number.MAX_SAFE_INTEGER,
          items: [],
        }),
      )

      try {
        const { data } = await api.post<BudgetMonthDto>('/budget/categories', {
          budgetMonthId: month.id,
          name,
          isSavings: asSavings,
        })
        setMonth(fromDto(data)) // reconcile temp group -> real server group
      } catch {
        setMonth(snapshot)
        setError(`Could not add that ${asSavings ? 'savings group' : 'group'} — reverted.`)
      }
    },
    [month],
  )

  const renameCategory = useCallback(
    async (categoryId: string, name: string) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withCategoryName(month, categoryId, name)) // optimistic

      try {
        await api.put(`/budget/categories/${categoryId}`, { name })
      } catch {
        setMonth(snapshot)
        setError('Could not rename that group — reverted to the previous name.')
      }
    },
    [month],
  )

  const deleteCategory = useCallback(
    async (categoryId: string) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withoutCategory(month, categoryId)) // optimistic

      try {
        const { data } = await api.delete<BudgetMonthDto>(`/budget/categories/${categoryId}`)
        setMonth(fromDto(data))
      } catch {
        setMonth(snapshot)
        setError('Could not delete that group — reverted.')
      }
    },
    [month],
  )

  // Move an expense group up (-1) or down (+1) among the expense groups.
  const moveCategory = useCallback(
    async (categoryId: string, direction: -1 | 1) => {
      if (!month) return

      const expense = month.categories.filter((c) => c.kind === 'expense')
      const idx = expense.findIndex((c) => c.id === categoryId)
      const swap = idx + direction
      if (idx < 0 || swap < 0 || swap >= expense.length) return

      const reordered = [...expense]
      ;[reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]]
      const orderedIds = reordered.map((c) => c.id)

      const snapshot = month
      setError(null)
      setMonth(withReorderedExpenseCategories(month, orderedIds)) // optimistic

      try {
        const { data } = await api.put<BudgetMonthDto>('/budget/categories/order', {
          budgetMonthId: month.id,
          orderedCategoryIds: orderedIds,
        })
        setMonth(fromDto(data))
      } catch {
        setMonth(snapshot)
        setError('Could not reorder the groups — reverted.')
      }
    },
    [month],
  )

  // Reorder the lines within a category (CategoryAccordion computes the new order).
  const reorderItems = useCallback(
    async (categoryId: string, orderedItemIds: string[]) => {
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withReorderedItems(month, categoryId, orderedItemIds)) // optimistic

      try {
        const { data } = await api.put<BudgetMonthDto>(
          `/budget/categories/${categoryId}/items/order`,
          { orderedItemIds },
        )
        setMonth(fromDto(data))
      } catch {
        setMonth(snapshot)
        setError('Could not reorder the lines — reverted.')
      }
    },
    [month],
  )

  function submitNewCategory() {
    const trimmed = newCategoryName.trim()
    if (trimmed === '') return
    addCategory(trimmed, newCategoryIsSavings)
    setNewCategoryName('')
    setAddingGroup(false)
  }

  return (
    <AppShell active="budget" title="Budget">
        {loading && <p className="text-slate-500">Loading your budget…</p>}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {notFound && !loading && !canWrite && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-surface px-6 py-12 text-center shadow-card">
            <p className="text-slate-600">
              No budget for {MONTH_NAMES[monthNum - 1]} {year} yet.
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Ask an admin or the owner to set this month up.
            </p>
          </div>
        )}

        {notFound && !loading && canWrite && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-surface px-6 py-12 text-center shadow-card">
            <p className="text-slate-600">
              No budget for {MONTH_NAMES[monthNum - 1]} {year} yet.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              {prevBudget && (
                <button
                  type="button"
                  onClick={() => createMonth(true)}
                  disabled={creating}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Copy {MONTH_NAMES[prevBudget.month - 1]} {prevBudget.year}
                </button>
              )}
              <button
                type="button"
                onClick={() => createMonth(false)}
                disabled={creating}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Start a blank budget
              </button>
            </div>

            {jars.length > 0 && (
              <p className="mt-3 text-xs text-slate-400">
                Your {jars.length} existing {jars.length === 1 ? 'jar is' : 'jars are'} added to any new
                budget automatically, so it will have a few more lines than a template lists.
              </p>
            )}

            {templates.length > 0 && (
              <div className="mt-8 border-t border-slate-100 pt-6">
                <p className="text-sm font-medium text-slate-500">Or start from a template</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {templates.map((t) => {
                    const lineCount = t.groups.reduce((n, g) => n + g.lines.length, 0)
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => createFromTemplate(t.key)}
                        disabled={creating}
                        aria-label={`Start from the ${t.name} template`}
                        className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-surface p-4 text-left transition hover:border-brand-500 hover:bg-brand-50/40 hover:shadow-card disabled:opacity-50"
                      >
                        <span className="font-semibold text-slate-800">{t.name}</span>
                        <span className="text-xs text-slate-500">{t.description}</span>
                        <span className="mt-1 text-xs text-slate-500">
                          {t.groups.length} groups · {lineCount} lines
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {month && (() => {
          const incomeMinor = totalIncome(month)
          const allottedMinor = monthPlanned(month)
          const remainingMinor = remainingToBudget(month)
          const balanced = remainingMinor === 0
          const over = remainingMinor < 0
          const totalSavedMinor = jars.reduce((s, f) => s + fromAmount(f.currentBalance), 0)
          // The jars shelf shows all-time (today's) balances, which only line up with
          // the month-scoped savings lines on the current month — so it's shown there only.
          const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === monthNum
          return (
          <>
            <Hero
              data-tour="remaining-banner"
              eyebrow="Remaining to budget"
              amount={formatMoney(remainingMinor, month.currency)}
              amountLabel={`Remaining to budget: ${formatMoney(remainingMinor, month.currency)}`}
              tiles={[
                { label: 'Income', value: formatMoney(incomeMinor, month.currency) },
                { label: 'Allotted', value: formatMoney(allottedMinor, month.currency) },
              ]}
              footnote={
                balanced ? (
                  <BalancedBadge>Every {currencyNoun(month.currency)} has a job</BalancedBadge>
                ) : (
                  <span
                    className={`inline-flex items-center rounded-full px-[15px] py-2 text-[13.5px] font-medium ${
                      over ? 'bg-rose-500/25 text-rose-50 ring-1 ring-rose-200/40' : 'bg-black/[0.18]'
                    }`}
                  >
                    {over
                      ? `${formatMoney(-remainingMinor, month.currency)} over-budgeted — trim a line`
                      : `${formatMoney(remainingMinor, month.currency)} still to assign`}
                  </span>
                )
              }
            />

            {(() => {
              const bills = billsSummary(month)
              if (bills.total === 0) return null
              const allPaid = bills.paid === bills.total
              const alerts = billAlerts(month, today)
              const tone = alerts.overdue > 0
                ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
                : allPaid
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
              return (
                <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-sm ${tone}`}>
                  <span className="font-medium">
                    📅 Bills: {bills.paid}/{bills.total} paid
                    {alerts.overdue > 0 && (
                      <span className="ml-2 font-semibold">· {alerts.overdue} overdue</span>
                    )}
                    {alerts.overdue === 0 && alerts.dueSoon > 0 && (
                      <span className="ml-2">· {alerts.dueSoon} due soon</span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {allPaid
                      ? 'All bills paid 🎉'
                      : `${formatMoney(bills.unpaidMinor, month.currency)} left to pay`}
                  </span>
                </div>
              )
            })()}

            {/* "Your jars" shelf — the jars drawn as jars, the signature metaphor.
                Shown on the current month only: it's today's all-time balance, which
                would contradict a past/future month's savings lines on the same screen. */}
            {jars.length > 0 && isCurrentMonth && (
              <Card className="p-6">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your jars</h2>
                  <span className="text-sm tabular-nums text-slate-500">
                    {formatMoney(totalSavedMinor, month.currency)} saved
                  </span>
                </div>
                <div className="mt-[22px] grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(116px,1fr))]">
                  {jars.map((f, i) => {
                    const avail = fromAmount(f.currentBalance)
                    const target = fromAmount(f.targetAmount)
                    const pct = target > 0 ? (avail / target) * 100 : 0
                    const monthly = fromAmount(f.requiredMonthlyContribution)
                    const chip = jarStatusChip(f.status)
                    return (
                      <div key={f.id} className="flex flex-col items-center gap-3">
                        <Jar
                          hue={hueForIndex(i)}
                          pct={pct}
                          size="shelf"
                          label={`${f.name}: ${Math.round(Math.max(0, Math.min(100, pct)))}% of goal`}
                        />
                        <div className="text-center">
                          <div className="text-[13px] font-semibold text-slate-900">{f.name}</div>
                          <div className="text-[13.5px] font-bold tabular-nums text-slate-900">
                            {formatMoney(avail, month.currency)}
                          </div>
                          {/* One status-aware line: an attention/funded chip wins, else the
                              monthly set-aside — so the shelf never contradicts the Jars page. */}
                          {chip ? (
                            <div className="mt-1 flex justify-center">
                              <Badge tone={chip.tone}>{chip.label}</Badge>
                            </div>
                          ) : (
                            monthly > 0 && (
                              <div className="mt-px text-[11.5px] font-semibold tabular-nums text-brand-700 dark:text-brand-200">
                                +{formatMoney(monthly, month.currency)}/mo
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}

            <div className="space-y-3">
              {/* Income groups always render first. */}
              {month.categories.filter(isIncome).map((category) => (
                <IncomeGroup
                  key={category.id}
                  category={category}
                  currency={month.currency}
                  savingItemId={savingItemId}
                  onRenameItem={renameItem}
                  onCommitPlanned={commitItem}
                  onDeleteItem={deleteItem}
                  onAddItem={addItem}
                />
              ))}
              {/* "Everyday spending" panel — all expense groups in one card. */}
              {(() => {
                const expense = month.categories.filter((c) => c.kind === 'expense')
                if (expense.length === 0) return null
                const spent = sumMinor(expense.map(categoryActual))
                const planned = sumMinor(expense.map(categoryPlanned))
                return (
                  <Card className="px-6 py-[22px]">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <h2 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">Everyday spending</h2>
                      <div className="text-[13px] tabular-nums text-slate-700">
                        {formatMoney(spent, month.currency)}{' '}
                        <span className="text-slate-500">of {formatMoney(planned, month.currency)}</span>
                      </div>
                    </div>
                    {expense.map((category, i, arr) => (
                      <CategoryAccordion
                        key={category.id}
                        category={category}
                        currency={month.currency}
                        savingItemId={savingItemId}
                        monthYear={month.year}
                        monthNumber={month.month}
                        today={today}
                        isFirst={i === 0}
                        isLast={i === arr.length - 1}
                        hue={hueForIndex(i)}
                        onCommitItem={commitItem}
                        onSetBill={setBill}
                        onSetPaid={setPaid}
                        onRenameItem={renameItem}
                        onDeleteItem={deleteItem}
                        onAddItem={addItem}
                        onRenameCategory={renameCategory}
                        onDeleteCategory={deleteCategory}
                        onMove={moveCategory}
                        onReorderItems={reorderItems}
                      />
                    ))}
                  </Card>
                )
              })()}

              {/* Jars render below expenses; their balances roll over. */}
              {month.categories.filter(isSavings).map((category) => (
                <SavingsGroup
                  key={category.id}
                  category={category}
                  currency={month.currency}
                  savingItemId={savingItemId}
                  onCommitItem={commitItem}
                  onRenameItem={renameItem}
                  onDeleteItem={deleteItem}
                  onAddItem={addItem}
                  onRenameCategory={renameCategory}
                  onDeleteCategory={deleteCategory}
                />
              ))}

              {/* Add a new expense or fund group — a quiet reveal to match the clean panel. */}
              {canWrite &&
                (addingGroup ? (
                  <div className="flex items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-surface/60 px-4 py-3">
                    <input
                      type="text"
                      autoFocus
                      value={newCategoryName}
                      placeholder={
                        newCategoryIsSavings
                          ? 'Add a savings group (e.g. Travel, Big purchases)…'
                          : 'Add a category group (e.g. Subscriptions, Insurance)…'
                      }
                      aria-label="New category group name"
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitNewCategory()
                        if (e.key === 'Escape') {
                          setNewCategoryName('')
                          setAddingGroup(false)
                        }
                      }}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                    <select
                      value={newCategoryIsSavings ? 'savings' : 'expense'}
                      aria-label="New group kind"
                      onChange={(e) => setNewCategoryIsSavings(e.target.value === 'savings')}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="expense">Expense</option>
                      <option value="savings">Savings</option>
                    </select>
                    <button
                      type="button"
                      onClick={submitNewCategory}
                      aria-label="Add category group"
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewCategoryName('')
                        setAddingGroup(false)
                      }}
                      aria-label="Cancel adding group"
                      className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingGroup(true)}
                    aria-label="Add a group"
                    className="rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-500 transition hover:text-brand-700"
                  >
                    + Add group
                  </button>
                ))}
            </div>
          </>
          )
        })()}
    </AppShell>
  )
}
