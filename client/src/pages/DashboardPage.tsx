import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { serverErrors } from '../lib/serverErrors'
import { EVENTS, track } from '../analytics'
import { useAuth } from '../auth/AuthContext'
import { AppShell } from '../components/AppShell'
import type {
  AccountDto,
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
  isBalanced,
  isSavings,
  isIncome,
  monthPlanned,
  remainingToBudget,
  totalIncome,
  withCategoryName,
  withItemBill,
  withItemMember,
  withItemName,
  withItemPaid,
  withItemPlanned,
  withNewCategory,
  withNewItem,
  withoutCategory,
  withoutItem,
  withReorderedExpenseCategories,
  withReorderedItems,
  type ItemVM,
  type MonthVM,
} from '../budgetModel'
import { currencyNoun, formatMoney, fromAmount, sumMinor, toAmount, type Minor } from '../lib/money'
import { jarStatusChip } from '../lib/jarStatus'
import { Hero, BalancedBadge } from '../components/Hero'
import { Badge, Button, Card } from '../components/ui'
import { Jar } from '../components/Jar'
import { JarFormModal } from '../components/JarFormModal'
import { CheckIcon } from '../components/icons'
import { hueForIndex } from '../lib/categoryColors'
import { monthIso } from '../lib/jarForm'
import { formatDate, todayIso } from '../lib/dates'
import { CategoryAccordion } from '../components/CategoryAccordion'
import { SavingsGroup } from '../components/SavingsGroup'
import { RemoveJarLineModal } from '../components/jars/RemoveJarLineModal'
import { IncomeGroup } from '../components/IncomeGroup'
import { useMonth } from '../features/MonthContext'
import { useHousehold } from '../features/HouseholdContext'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function DashboardPage({ today = new Date() }: { today?: Date } = {}) {
  // Building/editing the budget (groups, lines, months) needs Admin+ (canWrite).
  const { canWrite, budgetCurrency } = useAuth()
  // Who earns each income line — shown only once the household is shared.
  const { isShared, members: householdMembers } = useHousehold()
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
  // Whether the shelf has been read for the viewed month: the first-run checklist (rule 81)
  // must not read "add a jar" to a household with jars while that read is in flight, nor
  // after it failed (the shelf then says it could not be read instead).
  const [jarsLoaded, setJarsLoaded] = useState(false)
  const [jarsFailed, setJarsFailed] = useState(false)
  // The household's accounts: a jar needs one (rule 73), and the first-run checklist
  // (rule 81) starts with them.
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  // The shared jar form (rule 73), opened from a Savings group or the checklist.
  const [jarFormOpen, setJarFormOpen] = useState(false)
  // W04 (rule 60): the jar line whose ✕ was clicked — skip this month or archive the jar.
  const [removingJarLine, setRemovingJarLine] = useState<ItemVM | null>(null)
  // A past month's contributions are history (rule 60): nothing in it can be skipped. The server
  // dates months in UTC, so the screen does too.
  const viewKey = `${year}-${String(monthNum).padStart(2, '0')}`
  const todayKey = todayIso(today).slice(0, 7)
  const isPastMonth = viewKey < todayKey
  // A month that has not begun: the jars shelf shows today's balances with nothing contributed yet.
  const isFutureMonth = viewKey > todayKey

  // The month on screen, for answers that return after an await: a handler's answer belongs to
  // the month it was made on, so one that lands after the user changed month (a create, a
  // re-read, a save or its rollback) never paints that month's grid under the new month's label.
  const viewedMonth = useRef(`${year}-${monthNum}`)
  useLayoutEffect(() => {
    viewedMonth.current = `${year}-${monthNum}`
  }, [year, monthNum])
  const isViewed = useCallback((y: number, m: number) => viewedMonth.current === `${y}-${m}`, [])
  // Called when a handler starts: the returned check is true while the month it started on is
  // still the one viewed.
  const stillOn = useCallback(() => {
    const started = viewedMonth.current
    return () => viewedMonth.current === started
  }, [])

  // Load the viewed month whenever it changes; a 404 means "no budget yet".
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    // Clear the previous month before fetching, so its Hero/jars/lines can never
    // render for a beat under the newly-selected month's label on a slow link. The jars
    // shelf is the month's view too (rule 48): cleared here, it cannot show the previous
    // month's balances under the new month's grid while its own read is in flight.
    setMonth(null)
    setJars([])
    setJarsLoaded(false)
    setJarsFailed(false)
    // The skip-or-archive dialog belongs to the month it was opened on: it closes with it, so
    // it can never reopen holding the old month's line under the new month's title.
    setRemovingJarLine(null)
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

  // Re-read the viewed month in place (no loading flash): after a jar is created the
  // server plants its contribution line, which only a fresh GET can show.
  const refreshMonth = useCallback(async () => {
    try {
      const { data } = await api.get<BudgetMonthDto>(`/budget/${year}/${monthNum}`)
      if (!isViewed(year, monthNum)) return
      setMonth(fromDto(data))
      setNotFound(false)
    } catch (err) {
      if (isViewed(year, monthNum) && (err as { response?: { status?: number } })?.response?.status === 404) setNotFound(true)
    }
  }, [year, monthNum, isViewed])

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

  // The jars for the "Your jars" shelf, read for the viewed month (W05, rule 48): a past
  // month's balances as of its last day and its own plan, the current or a later month as of
  // today. Re-read whenever the month changes and after anything that moves a jar's figures.
  // Guarded so a non-array leaves the shelf empty rather than throwing; a failed read says so
  // rather than passing for "no jars". Only the latest read lands, so a slow answer for the
  // previous month can never overwrite the month now viewed. A refresh asked for by a handler
  // whose month is no longer viewed (a save that returns after the user changed month) reads
  // nothing: the viewed month's own read is already on its way.
  const jarsRead = useRef(0)
  const refreshJars = useCallback(() => {
    if (viewedMonth.current !== `${year}-${monthNum}`) return
    const read = ++jarsRead.current
    api
      .get<JarDto[]>('/jars', { params: { year, month: monthNum } })
      .then(({ data }) => {
        if (read !== jarsRead.current) return
        setJars(Array.isArray(data) ? data : [])
        setJarsFailed(false)
        setJarsLoaded(true)
      })
      .catch(() => {
        if (read === jarsRead.current) setJarsFailed(true)
      })
  }, [year, monthNum])

  useEffect(() => refreshJars(), [refreshJars])

  // The accounts a jar can be held in, and the checklist's first step.
  useEffect(() => {
    let cancelled = false
    api
      .get<AccountDto[]>('/accounts')
      .then(({ data }) => !cancelled && setAccounts(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => !cancelled && setAccountsLoaded(true))
    return () => {
      cancelled = true
    }
  }, [])

  // A jar created here (from a Savings group or the checklist) plants its line in the
  // month server-side: re-read the month so it appears, and refresh the shelf.
  const onJarCreated = useCallback(() => {
    setJarFormOpen(false)
    void refreshMonth()
    refreshJars()
  }, [refreshMonth, refreshJars])

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
        refreshMonths()
        if (isViewed(year, monthNum)) {
          setMonth(fromDto(data))
          setNotFound(false)
        }
        refreshJars() // the month's seeded contribution lines are the shelf's plan (rule 14)
        track(EVENTS.budgetMonthCreated, { source: copyFromPrevious ? 'copy' : 'blank' })
      } catch {
        setError('Could not create that budget.')
      } finally {
        setCreating(false)
      }
    },
    [year, monthNum, refreshMonths, refreshJars, isViewed],
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
        refreshMonths()
        if (isViewed(year, monthNum)) {
          setMonth(fromDto(data))
          setNotFound(false)
        }
        refreshJars()
        track(EVENTS.budgetMonthCreated, { source: 'template' })
      } catch {
        setError('Could not create that budget.')
      } finally {
        setCreating(false)
      }
    },
    [year, monthNum, refreshMonths, refreshJars, isViewed],
  )

  // Optimistic commit: apply the edit locally and recompute the banner instantly
  // (exact integer math), then persist. The server stores precisely what we send,
  // so success keeps the optimistic state; a failure rolls back and explains why.
  const commitItem = useCallback(
    async (itemId: string, plannedMinor: Minor) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month // captured synchronously for a clean rollback
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemPlanned(month, itemId, plannedMinor)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}`, { plannedAmount: toAmount(plannedMinor) })
        track(EVENTS.budgetItemEdited, { context: 'planned' })
        // A jar line's planned amount is the plan the shelf shows for the month (rule 14), and
        // typing one un-skips the month: re-read the shelf so it never goes stale (J6).
        if (findItem(month, itemId)?.savingsId) refreshJars()
      } catch {
        if (onMonth()) setMonth(snapshot) // roll back to the pre-edit state
        setError('Could not save that change — reverted to the previous value.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, refreshJars, stillOn],
  )

  // Attribute an income line to the household member who earns it (or clear with null).
  const setItemMember = useCallback(
    async (itemId: string, memberId: string | null) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemMember(month, itemId, memberId)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}/member`, { memberId })
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not update who earns that income — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, stillOn],
  )

  // Mark a line as a bill due on a day of the month (or clear it with null).
  const setBill = useCallback(
    async (itemId: string, dueDay: number | null) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemBill(month, itemId, dueDay)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}/bill`, { dueDay })
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not update that bill — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, stillOn],
  )

  // Toggle a bill line's paid status for this month.
  const setPaid = useCallback(
    async (itemId: string, isPaid: boolean) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withItemPaid(month, itemId, isPaid)) // optimistic

      try {
        await api.put(`/budget/items/${itemId}/paid`, { isPaid })
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not update that bill — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, stillOn],
  )

  // Rename a line. The update endpoint takes the planned amount too, so we send
  // the line's current planned value alongside the new name.
  const renameItem = useCallback(
    async (itemId: string, name: string) => {
      const onMonth = stillOn()
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
        if (onMonth()) setMonth(snapshot)
        setError('Could not rename that line — reverted to the previous name.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, stillOn],
  )

  // Add a line to a category. We show a temp row instantly, then reconcile from
  // the server response to pick up the real id and display order.
  const addItem = useCallback(
    async (categoryId: string, name: string) => {
      const onMonth = stillOn()
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
          refundedMinor: 0,
          memberId: null,
          savingsAvailableMinor: null,
          savingsId: null,
          isSkipped: false,
          dueDay: null,
          isPaid: false,
        }),
      )

      try {
        const { data } = await api.post<BudgetMonthDto>(
          `/budget/categories/${categoryId}/items`,
          { name, plannedAmount: 0 },
        )
        if (onMonth()) setMonth(fromDto(data)) // reconcile temp row -> real server row
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not add that line — reverted.')
      }
    },
    [month, stillOn],
  )

  // Delete a line. Optimistically remove it, then reconcile from the response.
  const deleteItem = useCallback(
    async (itemId: string) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setSavingItemId(itemId)
      setMonth(withoutItem(month, itemId)) // optimistic

      try {
        const { data } = await api.delete<BudgetMonthDto>(`/budget/items/${itemId}`)
        if (onMonth()) setMonth(fromDto(data))
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not delete that line — reverted.')
      } finally {
        setSavingItemId(null)
      }
    },
    [month, stillOn],
  )

  // Rule 60: a skipped jar contribution is planned again; the server replants the later
  // months and returns the month, and the jars shelf re-reads its figures.
  const restoreJarLine = useCallback(
    async (itemId: string) => {
      const onMonth = stillOn()
      setError(null)
      setSavingItemId(itemId)
      try {
        const { data } = await api.put<BudgetMonthDto>(`/budget/items/${itemId}/skip`, { skipped: false })
        if (onMonth()) setMonth(fromDto(data))
        refreshJars()
      } catch {
        setError('Could not plan that contribution again.')
      } finally {
        setSavingItemId(null)
      }
    },
    [refreshJars, stillOn],
  )

  // The skip-or-archive choice ended: skipping returns the month; archiving needs a re-read.
  const onJarLineSkipped = useCallback(
    (data: BudgetMonthDto) => {
      setRemovingJarLine(null)
      if (isViewed(data.year, data.month)) setMonth(fromDto(data))
      refreshJars()
    },
    [refreshJars, isViewed],
  )
  const onJarArchivedFromLine = useCallback(() => {
    setRemovingJarLine(null)
    void refreshMonth()
    refreshJars()
  }, [refreshMonth, refreshJars])

  // Add an expense or fund category group. Temp group shown instantly, then reconciled.
  const addCategory = useCallback(
    async (name: string, asSavings: boolean) => {
      const onMonth = stillOn()
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
          excludeFromAllocation: false,
          items: [],
        }),
      )

      try {
        const { data } = await api.post<BudgetMonthDto>('/budget/categories', {
          budgetMonthId: month.id,
          name,
          isSavings: asSavings,
        })
        if (onMonth()) setMonth(fromDto(data)) // reconcile temp group -> real server group
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError(`Could not add that ${asSavings ? 'savings group' : 'group'} — reverted.`)
      }
    },
    [month, stillOn],
  )

  const renameCategory = useCallback(
    async (categoryId: string, name: string) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withCategoryName(month, categoryId, name)) // optimistic

      try {
        await api.put(`/budget/categories/${categoryId}`, { name })
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not rename that group — reverted to the previous name.')
      }
    },
    [month, stillOn],
  )

  const deleteCategory = useCallback(
    async (categoryId: string) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withoutCategory(month, categoryId)) // optimistic

      try {
        const { data } = await api.delete<BudgetMonthDto>(`/budget/categories/${categoryId}`)
        if (onMonth()) setMonth(fromDto(data))
      } catch (err) {
        if (onMonth()) setMonth(snapshot)
        setError(serverErrors(err) ?? 'Could not delete that group — reverted.')
      }
    },
    [month, stillOn],
  )

  // Move an expense group up (-1) or down (+1) among the expense groups.
  const moveCategory = useCallback(
    async (categoryId: string, direction: -1 | 1) => {
      const onMonth = stillOn()
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
        if (onMonth()) setMonth(fromDto(data))
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not reorder the groups — reverted.')
      }
    },
    [month, stillOn],
  )

  // Reorder the lines within a category (CategoryAccordion computes the new order).
  const reorderItems = useCallback(
    async (categoryId: string, orderedItemIds: string[]) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withReorderedItems(month, categoryId, orderedItemIds)) // optimistic

      try {
        const { data } = await api.put<BudgetMonthDto>(
          `/budget/categories/${categoryId}/items/order`,
          { orderedItemIds },
        )
        if (onMonth()) setMonth(fromDto(data))
      } catch {
        if (onMonth()) setMonth(snapshot)
        setError('Could not reorder the lines — reverted.')
      }
    },
    [month, stillOn],
  )

  // The checklist's steps and their done state, or null once all three are done.
  const checklist = useMemo(() => {
    const hasAccounts = accounts.length > 0
    const hasMonth = month !== null
    const hasJars = jars.length > 0
    if (hasAccounts && hasMonth && hasJars) return null
    return [
      {
        id: 'accounts',
        label: 'Add your accounts with their opening balances',
        done: hasAccounts,
        action: (
          <Link to="/accounts" className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-200">
            Go to accounts
          </Link>
        ),
      },
      {
        id: 'month',
        label: "Create this month's budget",
        done: hasMonth,
        action: (
          <Button
            size="sm"
            variant="secondary"
            aria-label="Create this month's budget"
            onClick={() => {
              const target = document.getElementById('start-blank-budget') ?? document.getElementById('create-month')
              target?.scrollIntoView?.({ block: 'center' })
              ;(target as HTMLElement | null)?.focus?.()
            }}
          >
            Create budget
          </Button>
        ),
      },
      {
        id: 'jar',
        label: 'Add a jar from an account',
        done: hasJars,
        action: (
          <Button
            size="sm"
            variant="secondary"
            aria-label="Add a jar from an account"
            disabled={!hasAccounts}
            title={hasAccounts ? undefined : 'Add an account first — a jar’s money is held in an account'}
            onClick={() => setJarFormOpen(true)}
          >
            Add jar
          </Button>
        ),
      },
    ]
  }, [accounts.length, month, jars.length])

  function submitNewCategory() {
    const trimmed = newCategoryName.trim()
    if (trimmed === '') return
    addCategory(trimmed, newCategoryIsSavings)
    setNewCategoryName('')
    setAddingGroup(false)
  }

  return (
    <AppShell active="budget" title="Dashboard">
        {loading && <p className="text-slate-500">Loading your budget…</p>}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {/* First-run checklist (rule 81): accounts first, then the month, then a jar from an
            account. Shown until every step is done; state comes from data already loaded. */}
        {canWrite && !loading && accountsLoaded && jarsLoaded && checklist && (
          <Card as="section" aria-labelledby="setup-heading" className="p-5">
            <h2 id="setup-heading" className="text-base font-bold tracking-[-0.01em] text-slate-900">Set up your budget</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Three steps, in order — your money lives in accounts, your plan in the month, and your savings in jars held in those accounts.
            </p>
            <ol className="mt-3 space-y-2">
              {checklist.map((step) => (
                <li key={step.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      step.done ? 'bg-brand-600 text-white' : 'border border-slate-300 text-transparent'
                    }`}
                  >
                    <CheckIcon className="h-3 w-3" />
                  </span>
                  <span className={step.done ? 'text-slate-500 line-through' : 'text-slate-800'}>{step.label}</span>
                  <span className="sr-only">{step.done ? '(done)' : '(to do)'}</span>
                  {!step.done && step.action}
                </li>
              ))}
            </ol>
          </Card>
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
          <div id="create-month" className="rounded-2xl border border-dashed border-slate-300 bg-surface px-6 py-12 text-center shadow-card">
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
                id="start-blank-budget"
                onClick={() => createMonth(false)}
                disabled={creating}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Start a blank budget
              </button>
            </div>

            {(() => {
              // Only a jar still planning gets a line: not an archived jar or a completed goal (rules 27, 55).
              const planning = jars.filter((j) => !j.isArchived && !j.completedOn).length
              return (
                planning > 0 && (
                  <p className="mt-3 text-xs text-slate-400">
                    Your {planning} existing {planning === 1 ? 'jar is' : 'jars are'} added to any new
                    budget automatically, so it will have a few more lines than a template lists.
                  </p>
                )
              )
            })()}

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
          // A month with no income and nothing planned has Remaining €0, but it
          // isn't balanced — it's empty. Prompt for income instead of celebrating.
          const empty = incomeMinor === 0 && allottedMinor === 0
          const balanced = isBalanced(month)
          const over = remainingMinor < 0
          // Only jars whose balance is known count; an unavailable one reads as such (rule 67).
          const totalSavedMinor = jars.reduce((s, f) => s + (f.currentBalance === null ? 0 : fromAmount(f.currentBalance)), 0)
          // W05 (rule 48): the shelf is the viewed month's view of the jars — a past month's
          // balances as of its last day (the server dates them), a month that has not begun
          // today's — so it always agrees with the Savings lines beside it. Say which.
          const shelfAsOf = isPastMonth && jars[0]
            ? `as of ${formatDate(jars[0].balanceAsOf)}`
            : isFutureMonth
              ? 'balances as of today'
              : null
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
                    {empty
                      ? `Plan your income, then give every ${currencyNoun(month.currency)} a job`
                      : over
                        ? `${formatMoney(-remainingMinor, month.currency)} over-budgeted — trim a line`
                        : `${formatMoney(remainingMinor, month.currency)} still to assign`}
                  </span>
                )
              }
            />

            {/* Rows in another currency still waiting for their amount in the budget currency are
                EXCLUDED from every actual on this page (the app never converts on its own), so
                say so rather than presenting incomplete totals as final. */}
            {month.fxPendingCount > 0 && (
              <div
                role="status"
                className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <span className="font-medium">
                  {month.fxPendingCount} transaction{month.fxPendingCount === 1 ? '' : 's'} in another currency{' '}
                  {month.fxPendingCount === 1 ? 'is' : 'are'} waiting for {month.fxPendingCount === 1 ? 'its' : 'their'}{' '}
                  amount in {budgetCurrency}
                </span>{' '}
                and {month.fxPendingCount === 1 ? 'isn’t' : 'aren’t'} counted until it’s entered.{' '}
                <Link to="/transactions" className="font-semibold underline underline-offset-2">
                  Enter {month.fxPendingCount === 1 ? 'it' : 'them'} on Transactions
                </Link>
              </div>
            )}

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

            {/* "Your jars" shelf — the jars drawn as jars, the signature metaphor. It follows
                the viewed month (rule 48): balances at a past month's end, this month's plan
                and what went in, so it never contradicts the savings lines on the same screen. */}
            {jarsFailed && (
              <p role="status" className="text-sm text-slate-500">
                Could not load your jars for this month. Change month or reload to try again.
              </p>
            )}
            {jars.length > 0 && (
              <Card className="p-6">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your jars</h2>
                  <span className="text-sm tabular-nums text-slate-500">
                    {formatMoney(totalSavedMinor, month.currency)} saved
                    {shelfAsOf && (
                      <>
                        {' '}
                        <span className="ml-1 text-xs font-normal text-slate-400">{shelfAsOf}</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-[22px] grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(116px,1fr))]">
                  {jars.map((f, i) => {
                    const avail = f.currentBalance === null ? null : fromAmount(f.currentBalance)
                    const target = fromAmount(f.targetAmount)
                    const pct = target > 0 && avail !== null ? (avail / target) * 100 : 0
                    const monthly = fromAmount(f.plannedThisMonth)
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
                          <div className={`text-[13.5px] font-bold tabular-nums ${avail === null ? 'text-slate-500' : 'text-slate-900'}`}>
                            {avail === null ? 'Not available' : formatMoney(avail, month.currency)}
                          </div>
                          {/* One status-aware line: an attention/funded chip wins, else this
                              month's plan — so the shelf never contradicts the Jars page. */}
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
                  members={householdMembers}
                  showMemberPicker={isShared}
                  onSetItemMember={setItemMember}
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
                  jars={jarsLoaded && !jarsFailed ? jars : null}
                  onCommitItem={isPastMonth ? undefined : commitItem}
                  onRenameItem={renameItem}
                  onRemoveJarLine={isPastMonth ? undefined : (item) => setRemovingJarLine(item)}
                  onRestoreJarLine={isPastMonth ? undefined : restoreJarLine}
                  onAddJar={() => setJarFormOpen(true)}
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

        {/* Rule 60: skip this month's contribution or archive the jar. Mounted only while open. */}
        {removingJarLine && month && canWrite && (
          <RemoveJarLineModal
            item={removingJarLine}
            month={monthIso(year, monthNum)}
            currency={month.currency}
            onClose={() => setRemovingJarLine(null)}
            onSkipped={onJarLineSkipped}
            onArchived={onJarArchivedFromLine}
          />
        )}

        {/* The one jar form (rule 73), also used by the Jars page. Mounted only while open. */}
        {jarFormOpen && canWrite && (
          <JarFormModal
            jar={null}
            accounts={accounts}
            currency={month?.currency ?? budgetCurrency}
            onClose={() => setJarFormOpen(false)}
            onSaved={onJarCreated}
          />
        )}
    </AppShell>
  )
}
