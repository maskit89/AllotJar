import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Check, ChevronRight, CircleAlert, TriangleAlert, Wallet } from 'lucide-react'
import { api } from '../lib/api'
import { editConflict, serverErrors } from '../lib/serverErrors'
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
  fromDto,
  findItem,
  isBalanced,
  isIncome,
  itemVersionIn,
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
  withVersions,
  type ItemVM,
  type MonthVM,
} from '../budgetModel'
import { currencyNoun, currencySymbol, formatMoney, sumMinor, toAmount, type Minor } from '../lib/money'
import { Button } from '../components/ui'
import { Skeleton } from '../components/ui/skeleton'
import { InfoHint } from '../components/InfoHint'
import { HeroBar, KpiRow, KpiTile } from '../components/KpiTile'
import { StatusChip } from '../components/StatusChip'
import { BudgetCard } from '../components/budget/BudgetCard'
import { JarsCard } from '../components/budget/JarsCard'
import { CARD_TITLE, DASH_CARD } from '../components/budget/card'
import { JarFormModal } from '../components/JarFormModal'
import { monthIso } from '../lib/jarForm'
import { formatDate, todayIso } from '../lib/dates'
import { useMediaQuery } from '../lib/useMediaQuery'
import { RemoveJarLineModal } from '../components/jars/RemoveJarLineModal'
import { useMonth } from '../features/MonthContext'
import { useHousehold } from '../features/HouseholdContext'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** One line's writes in progress (D11): see `saveLine` in the page. */
interface LineWrites {
  /** Settles when the line's latest write has its answer; the next write starts after it. */
  tail: Promise<unknown>
  /** Writes of the line waiting or in flight, this one included. */
  waiting: number
  /** Writes of the line sent since it last had none waiting. */
  sent: number
  /** The version the line's next write sends: the latest answer's, or the one loaded. */
  version: string | null
}

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
  // The Savings group the form was opened from, where the new jar's line goes (jar setup plan, PR 4);
  // null from the checklist, which puts it in the first Savings group.
  const [jarGroupId, setJarGroupId] = useState<string | null>(null)
  const openJarForm = useCallback((groupId: string | null) => {
    setJarGroupId(groupId)
    setJarFormOpen(true)
  }, [])
  // W04 (rule 60): the jar line whose "Skip this month" or "Archive jar" was chosen, and which.
  const [removingJarLine, setRemovingJarLine] = useState<{ item: ItemVM; intent: 'skip' | 'archive' } | null>(null)
  // Phones (the mock-ups' 700px breakpoint): no ⋯ per line; a line opens its actions in a sheet.
  const phone = useMediaQuery('(max-width: 699.98px)')
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

  // One line's writes go one after another (D11, #308 review P2-2). Every write moves the line's
  // version, so a second edit made while the first is still saving would otherwise send the
  // version the first is replacing, and the server would refuse the user's own correction as
  // someone else's change. Instead it waits for the first answer and sends the version that
  // answer returned. The line stays editable meanwhile, and its saving dot stays until the last
  // answer. `send` makes the request with the version to send; `failed` words a refusal that
  // is not a conflict. Resolves true once saved.
  const lineWrites = useRef(new Map<string, LineWrites>())
  const saveLine = useCallback(
    (
      itemId: string,
      snapshot: MonthVM,
      onMonth: () => boolean,
      send: (version: string | null) => Promise<{ data: BudgetMonthDto }>,
      failed: (err: unknown) => string,
    ): Promise<boolean> => {
      let writes = lineWrites.current.get(itemId)
      if (!writes) {
        writes = { tail: Promise.resolve(), waiting: 0, sent: 0, version: findItem(snapshot, itemId)?.version ?? null }
        lineWrites.current.set(itemId, writes)
      }
      const line = writes
      line.waiting++
      setSavingItemId(itemId)
      const run = line.tail
        .then(async () => {
          const followsAnother = line.sent++ > 0
          try {
            const { data } = await send(line.version)
            const version = itemVersionIn(data, itemId)
            if (version !== undefined) line.version = version
            if (onMonth()) setMonth((m) => (m ? withVersions(m, data) : m))
            return true
          } catch (err) {
            // A later edit of this line is waiting: it carries what the user typed last and
            // settles the line, so nothing is rolled back or reported for this one.
            if (line.waiting > 1) return false
            const conflict = editConflict(err)
            if (onMonth()) {
              setMonth(snapshot) // roll back to the state before this edit
              // Someone else changed the line first: show what they saved. After an earlier write
              // of this line the snapshot need not be what the server holds either.
              if (conflict || followsAnother) void refreshMonth()
            }
            setError(conflict ?? failed(err))
            return false
          }
        })
        .finally(() => {
          line.waiting--
          if (line.waiting === 0) {
            lineWrites.current.delete(itemId)
            setSavingItemId((saving) => (saving === itemId ? null : saving))
          }
        })
      line.tail = run.catch(() => false)
      return run
    },
    [refreshMonth],
  )

  // Optimistic commit: apply the edit locally and recompute the banner instantly
  // (exact integer math), then persist. The server stores precisely what we send,
  // so success keeps the optimistic state; a failure rolls back and explains why.
  const commitItem = useCallback(
    async (itemId: string, plannedMinor: Minor) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month // captured synchronously for a clean rollback
      const jarLine = !!findItem(month, itemId)?.savingsId
      setError(null)
      setMonth(withItemPlanned(month, itemId, plannedMinor)) // optimistic

      const saved = await saveLine(
        itemId,
        snapshot,
        onMonth,
        // The line's version goes with the save (D11): the one its previous write answered with.
        (version) => api.put<BudgetMonthDto>(`/budget/items/${itemId}`, { plannedAmount: toAmount(plannedMinor), version }),
        // A refusal says why (an archived jar's line plans nothing, D18).
        (err) => serverErrors(err) ?? 'Could not save that change — reverted to the previous value.',
      )
      if (!saved) return
      track(EVENTS.budgetItemEdited, { context: 'planned' })
      // A jar line's planned amount is the plan the shelf shows for the month (rule 14), and
      // typing one un-skips the month: re-read the shelf so it never goes stale (J6).
      if (jarLine) refreshJars()
    },
    [month, refreshJars, saveLine, stillOn],
  )

  // Attribute an income line to the household member who earns it (or clear with null).
  const setItemMember = useCallback(
    async (itemId: string, memberId: string | null) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withItemMember(month, itemId, memberId)) // optimistic
      await saveLine(
        itemId,
        snapshot,
        onMonth,
        () => api.put<BudgetMonthDto>(`/budget/items/${itemId}/member`, { memberId }),
        () => 'Could not update who earns that income — reverted.',
      )
    },
    [month, saveLine, stillOn],
  )

  // Mark a line as a bill due on a day of the month (or clear it with null).
  const setBill = useCallback(
    async (itemId: string, dueDay: number | null) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withItemBill(month, itemId, dueDay)) // optimistic
      await saveLine(
        itemId,
        snapshot,
        onMonth,
        () => api.put<BudgetMonthDto>(`/budget/items/${itemId}/bill`, { dueDay }),
        () => 'Could not update that bill — reverted.',
      )
    },
    [month, saveLine, stillOn],
  )

  // Toggle a bill line's paid status for this month.
  const setPaid = useCallback(
    async (itemId: string, isPaid: boolean) => {
      const onMonth = stillOn()
      if (!month) return

      const snapshot = month
      setError(null)
      setMonth(withItemPaid(month, itemId, isPaid)) // optimistic
      await saveLine(
        itemId,
        snapshot,
        onMonth,
        () => api.put<BudgetMonthDto>(`/budget/items/${itemId}/paid`, { isPaid }),
        () => 'Could not update that bill — reverted.',
      )
    },
    [month, saveLine, stillOn],
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
      setMonth(withItemName(month, itemId, name)) // optimistic
      await saveLine(
        itemId,
        snapshot,
        onMonth,
        (version) => api.put<BudgetMonthDto>(`/budget/items/${itemId}`, { plannedAmount: toAmount(current.plannedMinor), name, version }),
        () => 'Could not rename that line — reverted to the previous name.',
      )
    },
    [month, saveLine, stillOn],
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
        const { data } = await api.put<BudgetMonthDto>(`/budget/categories/${categoryId}`, {
          name,
          version: month.categories.find((c) => c.id === categoryId)?.version ?? null,
        })
        if (onMonth()) setMonth((m) => (m ? withVersions(m, data) : m))
      } catch (err) {
        if (onMonth()) setMonth(snapshot)
        const conflict = editConflict(err)
        if (conflict) {
          setError(conflict)
          if (onMonth()) void refreshMonth()
        } else {
          setError('Could not rename that group — reverted to the previous name.')
        }
      }
    },
    [month, refreshMonth, stillOn],
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
    const steps: { id: string; label: string; done: boolean; action: ReactNode }[] = [
      {
        id: 'accounts',
        label: 'Add your accounts with their opening balances',
        done: hasAccounts,
        action: (
          <Link
            to="/accounts"
            className="inline-flex h-8 items-center rounded-lg px-2 text-sm font-semibold text-brand-700 hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"
          >
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
            className="h-8"
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
          <span className="flex items-center gap-1.5">
            {!hasAccounts && (
              <InfoHint label="Why a jar needs an account" align="end" buttonClassName={HINT_BUTTON}>
                Add an account first — a jar’s money is held in an account.
              </InfoHint>
            )}
            <Button
              size="sm"
              variant="secondary"
              aria-label="Add a jar from an account"
              className="h-8"
              disabled={!hasAccounts}
              onClick={() => openJarForm(null)}
            >
              Add jar
            </Button>
          </span>
        ),
      },
    ]
    return steps
  }, [accounts.length, month, jars.length, openJarForm])

  // Only a jar still planning gets a line in a new month: not an archived jar or a completed goal
  // (rules 27, 55).
  const planningJars = jars.filter((j) => !j.isArchived && !j.completedOn).length

  return (
    <AppShell active="budget" title="Dashboard" month>
        {loading && <DashboardSkeleton />}

        {error && (
          <div
            role="alert"
            className="flex min-h-11 items-center gap-2.5 rounded-[10px] bg-bad-bg px-3.5 py-2 text-sm font-semibold text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-bad)_16%,transparent)]"
          >
            <CircleAlert aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0">{error}</span>
          </div>
        )}

        {/* First-run checklist (rule 81): accounts first, then the month, then a jar from an
            account. Shown until every step is done; state comes from data already loaded. */}
        {canWrite && !loading && accountsLoaded && jarsLoaded && checklist && (
          <section aria-labelledby="setup-heading" className={DASH_CARD}>
            <div className="flex min-h-8 items-center gap-1.5">
              <h2 id="setup-heading" className={CARD_TITLE}>
                Set up your budget
              </h2>
              <InfoHint label="About setting up" buttonClassName={HINT_BUTTON}>
                Three steps, in order — your money lives in accounts, your plan in the month, and your savings in jars held in
                those accounts.
              </InfoHint>
            </div>
            <ol className="mt-2">
              {checklist.map((step) => (
                <li key={step.id} className="flex min-h-12 items-center gap-3 py-1.5 not-first:border-t not-first:border-line">
                  <span
                    aria-hidden
                    className={`grid size-5 shrink-0 place-items-center rounded-full ${
                      step.done ? 'bg-brand-600 text-white' : 'border border-slate-300 text-transparent'
                    }`}
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <span className={`min-w-0 flex-1 text-sm font-medium ${step.done ? 'text-slate-500 line-through' : 'text-slate-900'}`}>
                    {step.label}
                  </span>
                  <span className="sr-only">{step.done ? '(done)' : '(to do)'}</span>
                  {!step.done && <span className="shrink-0">{step.action}</span>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* No budget for the month yet: one card in place of the KPI row and the cards. */}
        {notFound && !loading && (
          <section
            id={canWrite ? 'create-month' : undefined}
            aria-labelledby="empty-month-heading"
            className={`${DASH_CARD} py-10! text-center min-[700px]:py-12!`}
          >
            <h2 id="empty-month-heading" className={CARD_TITLE}>
              No budget for {MONTH_NAMES[monthNum - 1]} {year} yet.
            </h2>
            {!canWrite ? (
              <p className="mt-1 text-sm text-slate-500">Ask an admin or the owner to set this month up.</p>
            ) : (
              <>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {prevBudget && (
                    <Button onClick={() => createMonth(true)} disabled={creating}>
                      Copy {MONTH_NAMES[prevBudget.month - 1]} {prevBudget.year}
                    </Button>
                  )}
                  <Button
                    id="start-blank-budget"
                    variant={prevBudget ? 'secondary' : 'primary'}
                    onClick={() => createMonth(false)}
                    disabled={creating}
                  >
                    Start a blank budget
                  </Button>
                </div>
                {planningJars > 0 && (
                  <p className="mx-auto mt-3 max-w-md text-[13px] text-slate-500">
                    Your {planningJars} existing {planningJars === 1 ? 'jar is' : 'jars are'} added to any new budget
                    automatically, so it will have a few more lines than a template lists.
                  </p>
                )}
                {templates.length > 0 && (
                  <div className="mt-8 border-t border-line pt-6">
                    <p className="text-[13px] font-medium text-slate-500">Or start from a template</p>
                    <div className="mt-3 grid gap-3 text-left sm:grid-cols-3">
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
                            <span className="text-sm font-semibold text-slate-900">{t.name}</span>
                            <span className="text-[13px] text-slate-500">{t.description}</span>
                            <span className="mt-1 text-xs font-semibold text-slate-500 tabular-nums">
                              {t.groups.length} groups · {lineCount} lines
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {month && (() => {
          const incomeMinor = totalIncome(month)
          const allottedMinor = monthPlanned(month)
          const remainingMinor = remainingToBudget(month)
          const money = (minor: Minor) => formatMoney(minor, month.currency)
          // A month with no income and nothing planned has Remaining €0, but it
          // isn't balanced — it's empty. Prompt for income instead of celebrating.
          const empty = incomeMinor === 0 && allottedMinor === 0
          const balanced = isBalanced(month)
          const over = remainingMinor < 0
          const noun = currencyNoun(month.currency)
          const receivedMinor = sumMinor(month.categories.filter(isIncome).map(categoryActual))
          const allReceived = incomeMinor > 0 && receivedMinor >= incomeMinor
          const bills = billsSummary(month)
          const alerts = billAlerts(month, today)
          const allPaid = bills.total > 0 && bills.paid === bills.total
          const billChip =
            alerts.overdue > 0 ? (
              <StatusChip tone="bad">{alerts.overdue} overdue</StatusChip>
            ) : alerts.dueSoon > 0 ? (
              <StatusChip tone="warn">{alerts.dueSoon} due soon</StatusChip>
            ) : null
          const paidCount = `${bills.paid}/${bills.total} paid`
          // W05 (rule 48): the shelf is the viewed month's view of the jars — a past month's
          // balances as of its last day (the server dates them), a month that has not begun
          // today's — so it always agrees with the Savings lines beside it. Say which.
          const shelfAsOf = isPastMonth && jars[0]
            ? `as of ${formatDate(jars[0].balanceAsOf)}`
            : isFutureMonth
              ? 'balances as of today'
              : null
          const showJars = jars.length > 0 || jarsFailed
          const fx = month.fxPendingCount
          return (
          <>
            <KpiRow tiles={bills.total > 0 ? 2 : 1}>
              <KpiTile
                hero
                data-tour="remaining-banner"
                label="Remaining to budget"
                hint={`Income not given a job yet. Allot it in the budget below until this reaches ${money(0)}.`}
                value={money(remainingMinor)}
                valueLabel={`Remaining to budget: ${money(remainingMinor)}`}
                extra={<HeroBar pct={incomeMinor > 0 ? (allottedMinor / incomeMinor) * 100 : 0} />}
                sub={
                  balanced ? (
                    <span className="inline-flex items-center gap-2 font-semibold text-white">
                      <span aria-hidden className="grid size-[17px] shrink-0 place-items-center rounded-full bg-gold text-[#1c1407]">
                        <Check className="size-[11px]" strokeWidth={3.2} />
                      </span>
                      Every {noun} has a job
                    </span>
                  ) : empty ? (
                    `Plan your income, then give every ${noun} a job`
                  ) : over ? (
                    // The gold number above already says by how much (never the same fact twice).
                    <>
                      <span>{money(allottedMinor)} allotted</span>
                      <StatusChip tone="bad">Over-budgeted — trim a line</StatusChip>
                    </>
                  ) : (
                    `${money(allottedMinor)} allotted`
                  )
                }
              />
              <KpiTile
                label="Income"
                icon={<Wallet strokeWidth={1.8} />}
                hue="emerald"
                value={money(incomeMinor)}
                strip={bills.total === 0}
                subTone={allReceived ? 'ok' : 'muted'}
                sub={
                  allReceived ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Check aria-hidden className="size-3.5" strokeWidth={2.4} />
                      All received
                    </span>
                  ) : (
                    `${money(receivedMinor)} received`
                  )
                }
              />
              {bills.total > 0 && (
                <KpiTile
                  label="Bills left"
                  icon={<CalendarDays strokeWidth={1.8} />}
                  hue="indigo"
                  value={money(bills.unpaidMinor)}
                  // The chip is the tile's one line, as in the mock-up; beside it the paid count
                  // is read out only. With nothing overdue or due soon the count shows instead.
                  extra={
                    billChip && (
                      <>
                        {billChip}
                        <span className="sr-only">{paidCount}</span>
                      </>
                    )
                  }
                  subTone={allPaid ? 'ok' : 'muted'}
                  sub={
                    !billChip && (
                      <span data-tone={allPaid ? 'ok' : undefined} className="inline-flex items-center gap-1.5 tabular-nums">
                        {allPaid && <Check aria-hidden className="size-3.5" strokeWidth={2.4} />}
                        {paidCount}
                      </span>
                    )
                  }
                />
              )}
            </KpiRow>

            {/* Rows in another currency still waiting for their amount in the budget currency are
                EXCLUDED from every actual on this page (the app never converts on its own), so
                say so rather than presenting incomplete totals as final. */}
            {fx > 0 && (
              <div
                role="status"
                className="flex min-h-11 items-center gap-2 rounded-[10px] bg-warn-bg py-1 pr-0.5 pl-3 text-[13px] font-semibold text-warn shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warn)_16%,transparent)] min-[700px]:gap-2.5 min-[700px]:py-1.5 min-[700px]:pr-1.5 min-[700px]:pl-3.5 min-[700px]:text-sm"
              >
                <TriangleAlert aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {fx} payment{fx === 1 ? '' : 's'}
                  {/* A phone keeps the strip to one line: the link says which amount is missing. */}
                  <span className="max-[699.98px]:hidden"> in another currency</span> {fx === 1 ? 'isn’t' : 'aren’t'} counted
                  yet
                </span>
                <Link
                  to="/transactions"
                  className="relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg pr-1.5 pl-2 font-[650] whitespace-nowrap transition after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] hover:bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] min-[700px]:pr-2 min-[700px]:pl-2.5"
                >
                  Add {currencySymbol(month.currency)} amount{fx === 1 ? '' : 's'}
                  <ChevronRight aria-hidden className="size-4" />
                </Link>
              </div>
            )}

            {/* The jars first in the page (a phone reads them before the budget); from 940px
                wide they stand in the right-hand column, which stays in view (sticky).
                `dash-palette` (index.css): the cards' category hues follow the approved palette. */}
            <div className="dash-palette @container">
              <div className="grid gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] @min-[940px]:items-start">
                {showJars && (
                  <JarsCard
                    jars={jars}
                    failed={jarsFailed}
                    currency={month.currency}
                    asOf={shelfAsOf}
                    className="@min-[940px]:sticky @min-[940px]:top-[92px] @min-[940px]:col-start-2 @min-[940px]:row-start-1"
                  />
                )}
                <div className={`min-w-0 ${showJars ? '@min-[940px]:col-start-1 @min-[940px]:row-start-1' : '@min-[940px]:col-span-2'}`}>
                  <BudgetCard
                    month={month}
                    today={today}
                    phone={phone}
                    savingItemId={savingItemId}
                    isShared={isShared}
                    members={householdMembers}
                    jars={jarsLoaded && !jarsFailed ? jars : null}
                    jarOrder={jars}
                    isPastMonth={isPastMonth}
                    onCommitItem={commitItem}
                    onSetItemMember={setItemMember}
                    onSetBill={setBill}
                    onSetPaid={setPaid}
                    onRenameItem={renameItem}
                    onAddItem={addItem}
                    onDeleteItem={deleteItem}
                    onRestoreJarLine={restoreJarLine}
                    onRemoveJarLine={(item, intent) => setRemovingJarLine({ item, intent })}
                    onAddJar={openJarForm}
                    onAddCategory={addCategory}
                    onRenameCategory={renameCategory}
                    onDeleteCategory={deleteCategory}
                    onMoveCategory={moveCategory}
                    onReorderItems={reorderItems}
                  />
                </div>
              </div>
            </div>
          </>
          )
        })()}

        {/* Rule 60: skip this month's contribution or archive the jar. Mounted only while open. */}
        {removingJarLine && month && canWrite && (
          <RemoveJarLineModal
            item={removingJarLine.item}
            intent={removingJarLine.intent}
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
            savingsCategoryId={jarGroupId ?? undefined}
            accounts={accounts}
            currency={month?.currency ?? budgetCurrency}
            onClose={() => setJarFormOpen(false)}
            onSaved={onJarCreated}
          />
        )}
    </AppShell>
  )
}

/** The quiet (i) button beside a card title or a line of text. */
const HINT_BUTTON =
  "relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"

/**
 * While the month loads: the page's shape in placeholders (the KPI row, the jars and the budget),
 * hidden from assistive tech, which hears "Loading your budget…" instead.
 */
function DashboardSkeleton() {
  return (
    <>
      <p className="sr-only">Loading your budget…</p>
      <div aria-hidden className="flex flex-col gap-4 min-[700px]:gap-6">
        {/* The KPI row's own grid (KpiRow, two tiles), so the hero keeps its width when the month lands. */}
        <div className="@container">
          <div className="grid grid-cols-2 gap-3 @min-[640px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)_minmax(0,1fr)] @min-[640px]:gap-6 @min-[1100px]:grid-cols-[calc((100%-24px)*1.55/2.55)_minmax(0,1fr)_minmax(0,1fr)]">
            <Skeleton className="col-span-2 h-[132px] rounded-2xl @min-[640px]:col-span-1 @min-[640px]:h-[150px]" />
            <Skeleton className="h-[104px] rounded-2xl @min-[640px]:h-[150px]" />
            <Skeleton className="h-[104px] rounded-2xl @min-[640px]:h-[150px]" />
          </div>
        </div>
        <Skeleton className="h-[420px] rounded-2xl" />
      </div>
    </>
  )
}
