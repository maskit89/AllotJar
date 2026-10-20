import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  CreditCard,
  House,
  Plus,
  Receipt,
  SlidersHorizontal,
  Split,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, EmptyState, ErrorBanner, SegmentedControl } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { InfoHint } from '../components/InfoHint'
import { MemberAvatar } from '../components/MemberAvatar'
import { ActionSheet, RowMenu, type RowAction } from '../components/RowActions'
import { CARD_TITLE, DASH_CARD, TITLE_HINT } from '../components/budget/card'
import { FILL_CHIP, TxTile } from '../components/transactions/TxParts'
import { Modal } from '../components/Modal'
import { AllocationIcon, JarNavIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { useMonth } from '../features/MonthContext'
import { api } from '../lib/api'
import { useMediaQuery } from '../lib/useMediaQuery'
import { bucketCount, EVENTS, track } from '../analytics'
import type {
  AccountDto,
  AllocationProfileDto,
  AllocationResultDto,
  AllocationStepDto,
  BudgetMonthDto,
  HouseholdMemberDto,
  MemberAllocationDto,
} from '../types'
import { AccountType, AllocationRuleType, SplitMethod } from '../types'
import {
  currencySymbol,
  formatMoney,
  fromAmount,
  parseMinor,
  sumMinor,
  toAmount,
  toEditString,
  tooPrecise,
  TOO_MANY_DECIMALS,
} from '../lib/money'
import { categoryPlanned, fromDto, remainingToBudget, totalIncome, type MonthVM } from '../budgetModel'
import { accountOptionLabel, formatNames, savingsFirst } from '../lib/accountOptions'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { activeJars, useJarLedgers } from '../lib/jarLedgers'
import { toJarAllocations } from '../lib/jarAllocationFields'
import { editConflict, serverErrors } from '../lib/serverErrors'
import { JarAllocationFields } from '../components/jars/JarAllocationFields'
import { PRIVATE_ACCOUNT } from '../lib/accountHolders'
import { todayIso } from '../lib/dates'
import { hueColor, memberHue } from '../lib/categoryColors'

/** The source picker's value for a source its holder has made private (P53: its id is never sent). */
const PRIVATE_SOURCE = 'private'

function sourceChoice(p: AllocationProfileDto | null | undefined): string {
  return p?.sourcePrivate ? PRIVATE_SOURCE : (p?.sourceAccountId ?? '')
}

interface RuleSpec {
  order: number
  type: number
  split: number
  fixedAmountPerMember: number
}

/** Friendly, design-matching names for each allocation step. */
const STEP_LABEL: Record<number, string> = {
  [AllocationRuleType.FundEnvelopes]: 'Cover shared costs',
  [AllocationRuleType.FundJars]: 'Fund the jars',
  [AllocationRuleType.FixedPerMember]: 'Pocket money',
  [AllocationRuleType.SplitRemainderToMembers]: 'Split remainder to savings',
}

/** Each step's icon and colour (the approved palette): its row's tile and its slice of the income bar. */
const STEP_LOOK: Record<number, { Icon: LucideIcon | typeof JarNavIcon; color: string }> = {
  [AllocationRuleType.FundEnvelopes]: { Icon: House, color: hueColor('indigo') },
  [AllocationRuleType.FundJars]: { Icon: JarNavIcon, color: hueColor('teal') },
  [AllocationRuleType.FixedPerMember]: { Icon: Wallet, color: 'var(--color-clay)' },
  [AllocationRuleType.SplitRemainderToMembers]: { Icon: Coins, color: 'var(--color-sky)' },
}
const STEP_FALLBACK = { Icon: Coins, color: 'var(--color-steel)' }

/** An account's type icon in the Link account picker (as on the Accounts page). */
const TYPE_ICON: Record<number, LucideIcon> = {
  [AccountType.Current]: CreditCard,
  [AccountType.Savings]: Coins,
  [AccountType.Cash]: Wallet,
  [AccountType.CreditCard]: CreditCard,
  [AccountType.Other]: Banknote,
}

function standardRules(costSplit: number, pocketAmount: number, savingsSplit: number): RuleSpec[] {
  return [
    { order: 0, type: AllocationRuleType.FundEnvelopes, split: costSplit, fixedAmountPerMember: 0 },
    { order: 1, type: AllocationRuleType.FundJars, split: costSplit, fixedAmountPerMember: 0 },
    { order: 2, type: AllocationRuleType.FixedPerMember, split: SplitMethod.Equal, fixedAmountPerMember: pocketAmount },
    { order: 3, type: AllocationRuleType.SplitRemainderToMembers, split: savingsSplit, fixedAmountPerMember: 0 },
  ]
}

// ---- The page's strips: one short line per state, its sentence behind the (i), its action at the right ----

type StripTone = 'ok' | 'warn' | 'bad' | 'soft'

const STRIP_TONE: Record<StripTone, string> = {
  ok: 'bg-ok-bg text-ok [--k:var(--color-ok)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--k)_16%,transparent)]',
  warn: 'bg-warn-bg text-warn [--k:var(--color-warn)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--k)_16%,transparent)]',
  bad: 'bg-bad-bg text-bad [--k:var(--color-bad)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--k)_16%,transparent)]',
  // The quiet note: grey, no icon, a little lighter.
  soft: 'bg-surface-2 font-medium text-slate-500 [--k:var(--color-slate-500)] shadow-[inset_0_0_0_1px_var(--color-line)]',
}

/** The (i) inside a strip or a row's sub-line: it takes the line's colour (a 22px target, the icon at 15px). */
const LINE_HINT =
  "relative -my-1 inline-grid size-[22px] shrink-0 place-items-center rounded-full opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] hover:opacity-100"

/** A strip's action: a quiet text button with a chevron (a 44px target on a phone). */
const STRIP_ACTION =
  "relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg pr-2 pl-2.5 font-[650] whitespace-nowrap transition after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-[color-mix(in_srgb,var(--k)_10%,transparent)] disabled:opacity-50 max-[699.98px]:pr-1.5 max-[699.98px]:pl-2"

/** One state of the page (the mock-ups' strip): its icon, the short line, an (i) with the full sentence, the action. */
function Strip({
  id,
  tone,
  role,
  hint,
  hintLabel,
  action,
  children,
}: {
  /** What the strip is (`data-strip`), for the tests and the state scripts. */
  id: string
  tone: StripTone
  /**
   * Today's role, where the strip had one; none otherwise. A note names the whole strip; a status
   * (a live region) is the short line alone, so opening the (i) beside it isn't announced again.
   */
  role?: 'status' | 'note'
  hint?: ReactNode
  hintLabel?: string
  action?: ReactNode
  children: ReactNode
}) {
  const Icon = tone === 'ok' ? Check : tone === 'soft' ? null : TriangleAlert
  return (
    <div
      role={role === 'note' ? role : undefined}
      data-strip={id}
      data-tone={tone}
      className={`flex min-h-11 items-center gap-2.5 rounded-[10px] py-1.5 pr-1.5 pl-3.5 text-sm font-semibold max-[699.98px]:flex-wrap max-[699.98px]:gap-x-2 max-[699.98px]:gap-y-0 max-[699.98px]:pt-2 max-[699.98px]:pr-1 max-[699.98px]:pl-3 max-[699.98px]:text-[13px] ${
        action ? 'max-[699.98px]:pb-1' : 'max-[699.98px]:pb-2'
      } ${STRIP_TONE[tone]}`}
    >
      {Icon && <Icon aria-hidden strokeWidth={2} className="size-4 shrink-0" />}
      {/* On a phone the line takes the row and its action goes under it, aligned with the words. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 max-[699.98px]:basis-[calc(100%-32px)]">
        <span role={role === 'status' ? role : undefined} className="min-w-0">
          {children}
        </span>
        {hint && (
          <InfoHint fixed label={hintLabel ?? 'About this'} buttonClassName={LINE_HINT}>
            {hint}
          </InfoHint>
        )}
      </span>
      {action && <span className={`flex shrink-0 ${Icon ? 'max-[699.98px]:ml-4' : ''}`}>{action}</span>}
    </div>
  )
}

/** A strip's action button: the visible words, an optional fuller name, a chevron. */
function StripAction({
  label,
  ariaLabel,
  onClick,
  disabled,
}: {
  label: string
  ariaLabel?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={STRIP_ACTION}>
      {label}
      <ChevronRight aria-hidden strokeWidth={2} className="size-3.5" />
    </button>
  )
}

/** The page's one primary action (the Transactions page's Add transaction look). */
const PRIMARY_BUTTON =
  'h-[38px] gap-[7px] rounded-[10px] px-4 shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:bg-primary dark:hover:bg-brand-600'

/** The Steps card's quiet Settings button (the mock-ups' small outline button; 40px on a phone). */
const OUTLINE_SM =
  'h-8 gap-1.5 rounded-[10px] border-slate-200 px-3 py-0 text-[13px] text-slate-900 shadow-[var(--shadow-frame)] max-[699.98px]:h-10 dark:hover:bg-foreground/7'

/** A dialog field's label (13px, muted). */
const FIELD_LABEL = 'flex min-h-[22px] items-center gap-1 text-[13px] font-semibold whitespace-nowrap text-slate-500'

/** A field label's (i): a 22px target, the icon at 15px, in the label's colour. */
const FIELD_HINT = LINE_HINT

export function AllocationPage() {
  // Editing the allocation profile needs Admin+; running an allocation is day-to-day (Limited+).
  const { canWrite, canEnterData, budgetCurrency } = useAuth()
  const { isShared, loading: householdLoading, members: householdMembers } = useHousehold()
  const navigate = useNavigate()
  const CURRENCY = budgetCurrency
  const money = useCallback((minor: number) => formatMoney(minor, CURRENCY), [CURRENCY])
  // The top bar has room for Allocate from 900px (AppShell's own breakpoint); below it the button
  // sits under the KPI row, as in the mock-up. Phones pick a savings account in a bottom sheet.
  const desktop = useMediaQuery('(min-width: 900px)')
  const phone = useMediaQuery('(max-width: 699.98px)')
  const stepsId = useId()
  const savingsId = useId()
  const pocketId = useId()
  // The app-wide selected month (rule 29): the allocation reads the same month and figures as
  // the Dashboard, and moves with the top bar's month navigator.
  const { year, month, label: monthLabel } = useMonth()
  const period = useMemo(() => ({ year, month }), [year, month])
  const [profile, setProfile] = useState<AllocationProfileDto | null>(null)
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [preview, setPreview] = useState<AllocationResultDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState<number | null>(null)
  const [retained, setRetained] = useState(0)
  // The viewed month's budget (integer-minor VM) — the other half of the reconciliation.
  const [monthVM, setMonthVM] = useState<MonthVM | null>(null)
  const [syncedMsg, setSyncedMsg] = useState<string | null>(null)
  // Inline savings-link (a person's row) + the allocate-with-stranded-shares confirm.
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [showCommitConfirm, setShowCommitConfirm] = useState(false)
  // Rule 78 for the commit: each member whose savings account backs jars says how their
  // transfer is divided among those jars (member id → jar id → typed amount; empty = unallocated).
  const { ledgers } = useJarLedgers()
  const [allocJar, setAllocJar] = useState<Record<string, Record<string, string>>>({})

  // Setup/edit form (in a modal).
  const [showSettings, setShowSettings] = useState(false)
  // Where focus goes when the control that opened the settings is gone after a save (the no-source
  // strip's action, the empty state's Set up): the page's next step, else the Settings button.
  const refocusAfterSave = useRef(false)
  useEffect(() => {
    if (showSettings || !refocusAfterSave.current) return
    refocusAfterSave.current = false
    // The dialog has given focus back to its opener as it closed; if that is gone, focus is on
    // the page itself.
    if (document.activeElement && document.activeElement !== document.body) return
    const next = ['allocate', 'settings']
      .map((k) => document.querySelector<HTMLButtonElement>(`[data-refocus="${k}"]`))
      .find((b) => b && !b.disabled)
    next?.focus()
  }, [showSettings])
  const [sourceAccountId, setSourceAccountId] = useState('')
  const [pocket, setPocket] = useState('')
  const [split, setSplit] = useState<number>(SplitMethod.Equal)
  const [savingsSplit, setSavingsSplit] = useState<number>(SplitMethod.BalanceTilt)
  const [lean, setLean] = useState('25')

  // The month on screen now. A handler keeps the month it started on; an answer that lands after
  // the user moved to another month belongs to that month and is dropped, never painted under
  // the new month's heading (CL-P2-2, as on the Dashboard).
  const viewedMonth = useRef(`${year}-${month}`)
  useEffect(() => {
    viewedMonth.current = `${year}-${month}`
  }, [year, month])
  const isViewed = useCallback((y: number, m: number) => viewedMonth.current === `${y}-${m}`, [])

  const loadPreview = useCallback(async (year: number, month: number) => {
    try {
      const { data } = await api.get<AllocationResultDto>(`/allocation/preview/${year}/${month}`)
      if (!isViewed(year, month)) return
      setPreview(data)
    } catch {
      if (isViewed(year, month)) setError('Could not compute the allocation preview.')
    }
  }, [isViewed])

  // Reloads whenever the selected month changes: the preview and the budget it reconciles
  // against are both that month's.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<AllocationProfileDto | null>('/allocation/profile').catch(() => ({ data: null })),
      api.get<AccountDto[]>('/accounts').catch(() => ({ data: [] })),
      // The selected month's budget (a 404 = no budget yet → null), the other half of the
      // reconciliation strip and the source of the "no income yet" strip.
      api.get<BudgetMonthDto>(`/budget/${year}/${month}`).catch(() => null),
    ])
      .then(async ([prof, acc, budget]) => {
        if (cancelled) return
        // `|| null` (not `?? null`) so a falsy body — a 204's '' or an empty string — normalises
        // to null too; otherwise `''` survives and openSettings throws on `''?.rules.find`.
        const p = prof?.data || null
        setProfile(p)
        setAccounts(Array.isArray(acc?.data) ? acc.data : [])
        // A strip about another month's commit/sync would be stale under this month's figures.
        setCommitted(null)
        setSyncedMsg(null)
        // Keep the budget itself: the reconciliation strip compares its remaining-to-budget
        // with the engine's promised outputs.
        setMonthVM(Array.isArray(budget?.data?.categories) ? fromDto(budget.data) : null)
        if (p) {
          setSourceAccountId(sourceChoice(p))
          const pocketRule = p.rules.find((r) => r.type === AllocationRuleType.FixedPerMember)
          setPocket(pocketRule ? toEditString(fromAmount(pocketRule.fixedAmountPerMember)) : '')
          const fundRule = p.rules.find((r) => r.type === AllocationRuleType.FundEnvelopes)
          setSplit(fundRule?.split ?? SplitMethod.Equal)
          const savingsRule = p.rules.find((r) => r.type === AllocationRuleType.SplitRemainderToMembers)
          setSavingsSplit(savingsRule?.split ?? SplitMethod.BalanceTilt)
          setLean(String(p.balanceLeanPercent ?? 25))
          await loadPreview(year, month)
        }
      })
      .catch(() => !cancelled && setError('Could not load the allocation setup.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [year, month, loadPreview])

  /** The settings form as a saved profile describes it. */
  const fillForm = useCallback((p: AllocationProfileDto | null) => {
    setSourceAccountId(sourceChoice(p))
    const pocketRule = p?.rules.find((r) => r.type === AllocationRuleType.FixedPerMember)
    setPocket(pocketRule ? toEditString(fromAmount(pocketRule.fixedAmountPerMember)) : '')
    const fundRule = p?.rules.find((r) => r.type === AllocationRuleType.FundEnvelopes)
    setSplit(fundRule?.split ?? SplitMethod.Equal)
    const savingsRule = p?.rules.find((r) => r.type === AllocationRuleType.SplitRemainderToMembers)
    setSavingsSplit(savingsRule?.split ?? SplitMethod.BalanceTilt)
    setLean(String(p?.balanceLeanPercent ?? 25))
  }, [])

  const saveProfile = useCallback(async () => {
    const pocketAmount = pocket.trim() === '' ? 0 : parseMinor(pocket)
    if (pocketAmount === null) {
      setError('Enter a valid pocket-money amount.')
      return
    }
    // A typed amount is whole cents (D1); the saved one goes back as it is.
    const savedPocket = profile?.rules.find((r) => r.type === AllocationRuleType.FixedPerMember)
    if (tooPrecise(pocket, savedPocket ? fromAmount(savedPocket.fixedAmountPerMember) : null)) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    const leanValue = lean.trim() === '' ? 25 : Number.parseInt(lean, 10)
    if (Number.isNaN(leanValue) || leanValue < 0 || leanValue > 100) {
      setError('Balance lean must be a whole number between 0 and 100.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { data } = await api.put<AllocationProfileDto>('/allocation/profile', {
        id: profile?.id ?? null,
        name: profile?.name ?? 'Household allocation',
        // The server keeps a private source it was sent no id for.
        sourceAccountId: sourceAccountId === PRIVATE_SOURCE ? null : sourceAccountId || null,
        balanceLeanPercent: leanValue,
        rules: standardRules(split, toAmount(pocketAmount as number), savingsSplit),
        // The version the settings were loaded from: a save over someone else's change is refused (D11).
        version: profile?.version ?? null,
      })
      setProfile(data)
      // A prior "Allocated" strip is now stale (the numbers just changed) — clear it.
      setCommitted(null)
      track(EVENTS.allocationPreviewed, { split })
      await loadPreview(period.year, period.month)
      refocusAfterSave.current = true
      setShowSettings(false)
    } catch (err) {
      const conflict = editConflict(err)
      if (conflict) {
        // Someone else saved the profile first: refill the open settings with what they saved.
        const fresh = await api.get<AllocationProfileDto | null>('/allocation/profile').then(({ data }) => data || null, () => null)
        if (fresh) {
          setProfile(fresh)
          fillForm(fresh)
        }
        setError(conflict)
      } else {
        setError(serverErrors(err) ?? 'Could not save the allocation profile.')
      }
    } finally {
      setBusy(false)
    }
  }, [pocket, lean, split, savingsSplit, sourceAccountId, profile, period, loadPreview, fillForm])

  // One click materializes the profile's pocket money as flagged budget lines (server-side,
  // idempotent) — the flag combination that lets the budget zero out WITHOUT the engine
  // double-deducting. Explicit only; the strip re-offers it when things drift.
  const syncPocketLines = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { data } = await api.post<BudgetMonthDto>(`/allocation/pocket-lines/${period.year}/${period.month}`, {})
      if (!isViewed(period.year, period.month)) return
      setMonthVM(fromDto(data))
      // The envelopes (and possibly a healed double-count) just changed — stale strip off,
      // fresh preview in.
      setCommitted(null)
      await loadPreview(period.year, period.month)
      if (!isViewed(period.year, period.month)) return
      setSyncedMsg(`Pocket money added to ${new Date(period.year, period.month - 1, 1).toLocaleDateString(undefined, { month: 'long' })}’s budget.`)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not add the pocket-money lines to the budget.')
    } finally {
      setBusy(false)
    }
  }, [period, loadPreview, isViewed])

  // Link a savings account to a member straight from their row. The PUT is a full echo, so the
  // member's saved record is read first: the preview's `netIncome` is the month's BUDGET figure
  // (rule 28) and must never be written into the saved default income.
  const linkSavings = useCallback(
    async (m: MemberAllocationDto, accountId: string) => {
      if (!accountId) return
      setLinkingId(m.memberId)
      setError(null)
      try {
        const { data: list } = await api.get<HouseholdMemberDto[]>('/members')
        const current = Array.isArray(list) ? list.find((x) => x.id === m.memberId) : undefined
        if (!current) throw new Error('member not found')
        await api.put(`/members/${m.memberId}`, {
          name: current.name,
          netMonthlyIncome: current.netMonthlyIncome,
          personalSavingsAccountId: accountId,
          version: current.version ?? null,
        })
        // The balance-tilt figures change once the link lands; a prior strip is stale.
        setCommitted(null)
        await loadPreview(period.year, period.month)
      } catch (err) {
        setError(editConflict(err) ?? serverErrors(err) ?? `Could not link a savings account for ${m.name}.`)
      } finally {
        setLinkingId(null)
      }
    },
    [period, loadPreview],
  )

  // The commit records bank transfers the user says they have made (rules 7/29): the date the
  // money left the source account is required, and receipt stays unconfirmed (in transit).
  const [commitDate, setCommitDate] = useState(todayIso)
  const [commitConfirmed, setCommitConfirmed] = useState(false)
  // The dialog's date: a "Sent today" pill that opens the date field in its place.
  const [editingDate, setEditingDate] = useState(false)
  const focusDatePill = useRef(false)
  // The Allocate dialog's message sits at the top of its scrolling middle: shown, it is scrolled
  // into view, wherever the middle was (the jar fields below may have scrolled it away).
  const commitErrorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (showCommitConfirm && error) commitErrorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [showCommitConfirm, error])

  const commit = useCallback(async () => {
    if (!commitConfirmed || !commitDate) {
      setError('Confirm that you’ve completed these transfers, and the date the money left the source account.')
      return
    }
    // Every member's jar answer, flattened; sent only when someone named a jar.
    const jarAllocations = Object.entries(allocJar).flatMap(([memberId, value]) =>
      toJarAllocations(value).map((row) => ({ memberId, ...row })),
    )
    setBusy(true)
    setError(null)
    setCommitted(null)
    try {
      const { data } = await api.post<AllocationResultDto>(`/allocation/commit/${period.year}/${period.month}`, {
        departedOn: commitDate,
        receivedOn: null,
        confirmedCompleted: true,
        ...(jarAllocations.length > 0 ? { jarAllocations } : {}),
      })
      setCommitConfirmed(false)
      setAllocJar({})
      track(EVENTS.allocationCommitted, { count_bucket: bucketCount(data.transfersCreated) })
      // The commit's preview and strip are its own month's.
      if (!isViewed(period.year, period.month)) return
      setPreview(data)
      setCommitted(data.transfersCreated)
      setRetained(data.transfersRetained ?? 0)
    } catch (err) {
      // Rule 74 refusals and jar validation messages show verbatim.
      setError(
        serverErrors(err) ??
          'Could not record the allocation. Check the source account and members’ savings accounts are set.',
      )
    } finally {
      setBusy(false)
    }
  }, [period, commitDate, commitConfirmed, allocJar, isViewed])

  // Re-seed the settings form from the saved profile (defaults when there's none). Called when the
  // modal opens (clean start) and closes (Cancel/backdrop discards unsaved edits, so a later Save
  // can't quietly commit a value the user thought they'd cancelled).
  const syncFormFromProfile = useCallback(() => {
    setError(null)
    fillForm(profile)
  }, [profile, fillForm])

  const openSettings = useCallback(() => {
    syncFormFromProfile()
    setShowSettings(true)
  }, [syncFormFromProfile])
  const closeSettings = useCallback(() => {
    syncFormFromProfile()
    setShowSettings(false)
  }, [syncFormFromProfile])
  const closeCommit = useCallback(() => {
    setEditingDate(false)
    setShowCommitConfirm(false)
  }, [])

  const monthName = useMemo(
    // undefined locale = the visitor's browser locale (e.g. "June" / "Juni").
    () => new Date(period.year, period.month - 1, 1).toLocaleDateString(undefined, { month: 'long' }),
    [period],
  )
  // Rule 28: the pool is the month's budgeted income and nothing else, so an empty pool means
  // the budget has no income lines (or there is no budget yet) — never a missing default.
  const noIncomeInBudget =
    !!preview && fromAmount(preview.pool) === 0 && (monthVM === null || totalIncome(monthVM) === 0)

  // The KPI figures. The pool splits into shared spending (costs + jars + pocket money) and
  // savings, so those two tiles reconcile exactly to the pooled income; the Steps card breaks
  // spending down further.
  const stepTotal = (type: number) =>
    fromAmount(preview?.steps.find((s) => s.type === type)?.total ?? 0)
  const sharedSpendingMinor =
    stepTotal(AllocationRuleType.FundEnvelopes) +
    stepTotal(AllocationRuleType.FundJars) +
    stepTotal(AllocationRuleType.FixedPerMember)
  const toSavingsMinor = stepTotal(AllocationRuleType.SplitRemainderToMembers)

  // What will actually transfer on commit vs. what's stranded because a member has no savings
  // account (a positive share with nowhere to go stays in the source account).
  const members = useMemo(() => preview?.members ?? [], [preview])
  const strandedMembers = members.filter((m) => !m.savingsAccountId && !m.savingsPrivate && m.residual > 0)
  const strandedMinor = fromAmount(strandedMembers.reduce((sum, m) => sum + m.residual, 0))
  const strandedNames = formatNames(strandedMembers.map((m) => m.name))
  const strandedHasHave = strandedMembers.length === 1 ? 'has' : 'have'
  const nothingToSave = !!preview && toSavingsMinor <= 0
  const hasSource = !!profile?.sourceAccountId || profile?.sourcePrivate === true
  // The members whose transfer lands in a jar-backed savings account: the commit asks how each
  // is divided among that account's jars (rule 78).
  const jarMembers = members.flatMap((m) => {
    if (m.residual <= 0 || !m.savingsAccountId) return []
    const ledger = ledgers.find((l) => l.accountId === m.savingsAccountId)
    const jars = activeJars(ledger)
    return ledger && jars.length > 0 ? [{ member: m, ledger, jars }] : []
  })
  const sourceAccountName = accounts.find((a) => a.id === profile?.sourceAccountId)?.name
  /** Where the shared costs are paid from, in a short line ("Stays in Joint", "Joint → Alex Pot"). */
  const sourceShort = sourceAccountName ?? (profile?.sourcePrivate ? PRIVATE_ACCOUNT : 'the source account')
  /** A person's savings account by name; the account list may not hold it (another login's private one). */
  const savingsName = (m: MemberAllocationDto) =>
    accounts.find((a) => a.id === m.savingsAccountId)?.name ?? 'Savings account'

  // The link picker's offerings: savings accounts first, and a one-click suggestion when exactly
  // ONE unlinked savings account's name contains the member's (offer-only — nothing is ever
  // linked without a click).
  const accountsForLinking = useMemo(() => savingsFirst(accounts), [accounts])
  const savingsAccounts = useMemo(() => accounts.filter((a) => a.type === AccountType.Savings), [accounts])
  const linkedAccountIds = useMemo(
    () => new Set(members.map((m) => m.savingsAccountId).filter(Boolean)),
    [members],
  )
  const suggestionFor = useCallback(
    (m: MemberAllocationDto): AccountDto | null => {
      const candidates = savingsAccounts.filter(
        (a) => !linkedAccountIds.has(a.id) && a.name.toLowerCase().includes(m.name.toLowerCase()),
      )
      return candidates.length === 1 ? candidates[0] : null
    },
    [savingsAccounts, linkedAccountIds],
  )

  // --- Budget ↔ engine reconciliation (issue: pocket money promised by the engine but
  // absent from the budget makes "zero" impossible on one side or the other) -------------
  const pocketStepMinor = stepTotal(AllocationRuleType.FixedPerMember)
  const positiveSavingsMinor = Math.max(toSavingsMinor, 0)
  // Planned total of allocation-OUTPUT categories already materialized in the budget.
  const flaggedPlannedMinor = monthVM
    ? sumMinor(monthVM.categories.filter((c) => c.excludeFromAllocation).map(categoryPlanned))
    : 0
  // Engine promises not yet represented as budget lines.
  const unrepresentedMinor = pocketStepMinor + positiveSavingsMinor - flaggedPlannedMinor
  const budgetRemainingMinor = monthVM ? remainingToBudget(monthVM) : null
  const budgetIncomeMinor = monthVM ? totalIncome(monthVM) : null
  const poolMinor = fromAmount(preview?.pool ?? 0)
  // A category named like the sync's target but UNFLAGGED while a pocket rule exists means
  // pocket money is deducted twice (once as an envelope, once as the rule).
  const doubleCounted =
    !!monthVM &&
    pocketStepMinor > 0 &&
    monthVM.categories.some(
      (c) => c.kind === 'expense' && !c.excludeFromAllocation && c.name.trim().toLowerCase() === 'pocket money',
    )
  // Scoped to the tester's scenario: fire when pocket money exists, or when a positive
  // surplus is unrepresented in an otherwise balanced budget.
  const showReconcile =
    !!monthVM &&
    !!preview &&
    unrepresentedMinor > 0 &&
    (pocketStepMinor > 0 || (positiveSavingsMinor > 0 && budgetRemainingMinor === 0))
  // Only meaningful once the budget actually plans income — an empty/new month would
  // otherwise nag about a €0.00 mismatch.
  const incomeMismatch =
    !!monthVM && !!preview && budgetIncomeMinor !== null && budgetIncomeMinor > 0 && budgetIncomeMinor !== poolMinor

  // The household's order gives each person their colour, the same as on the People page (the
  // preview's order when the household hasn't loaded).
  const hueOf = (m: MemberAllocationDto, i: number) => {
    const at = householdMembers.findIndex((p) => p.id === m.memberId)
    return memberHue(at >= 0 ? at : i)
  }

  // Allocation only makes sense once the budget is shared. A solo user who reaches
  // this route directly gets a friendly nudge to add members rather than an empty engine.
  if (!householdLoading && !isShared) {
    return (
      <AppShell active="allocation" title="Allocation">
        <EmptyState
          icon={<AllocationIcon className="h-6 w-6" />}
          title="Add people first"
          description="Allocation pools everyone’s income and divides the surplus into each person’s savings, so it needs the people you share money with. Add them to set this up."
        >
          <Button onClick={() => navigate('/people')}>Add people</Button>
        </EmptyState>
      </AppShell>
    )
  }

  const ready = !loading && !!profile && !!preview

  // The page's one primary action: in the top bar on a desktop, a pill under the KPI row below 900px.
  // Its name keeps the month the pill beside it shows.
  const allocateButton =
    ready && canEnterData ? (
      <Button
        onClick={() => {
          setError(null)
          setShowCommitConfirm(true)
        }}
        data-refocus="allocate"
        disabled={busy || !hasSource}
        aria-label={`Allocate ${monthName}`}
        className={PRIMARY_BUTTON}
      >
        <Split aria-hidden strokeWidth={1.8} className="size-4" />
        Allocate
      </Button>
    ) : null

  // ---- The strips (today's warnings and notes, one short line each) ----
  const strips: ReactNode[] = []
  if (ready && preview) {
    if (committed !== null) {
      const full =
        (committed === 0 && retained > 0
          ? `Allocated ${monthName} — the ${retained} recorded transfer${retained === 1 ? '' : 's'} ${retained === 1 ? 'is' : 'are'} unchanged; nothing new was recorded.`
          : committed === 0
            ? toSavingsMinor < 0
              ? `Allocated ${monthName} — nothing was transferred because shared spending overshoots the pooled income.`
              : `Allocated ${monthName} — no savings transfers were needed this month.`
            : `Allocated ${monthName} — ${committed} savings transfer${committed === 1 ? '' : 's'} recorded as in transit; confirm each receipt on the Transactions page. Re-running Allocate keeps unchanged transfers, never doubles up.`) +
        (strandedMinor > 0
          ? ` ${money(strandedMinor)} stayed in ${sourceAccountName ?? 'the source account'} for ${strandedNames} (no savings account linked).`
          : '')
      const line =
        committed === 0 && retained > 0
          ? `Allocated ${monthName} · ${retained} transfer${retained === 1 ? '' : 's'} unchanged`
          : committed === 0
            ? toSavingsMinor < 0
              ? `Allocated ${monthName} · nothing transferred`
              : `Allocated ${monthName} · no transfers needed`
            : `Allocated ${monthName} · ${committed} transfer${committed === 1 ? '' : 's'} in transit`
      strips.push(
        <Strip key="committed" id="committed" tone="ok" role="status" hint={full} hintLabel="About the allocation">
          {line}
        </Strip>,
      )
    }
    if (syncedMsg) {
      strips.push(
        <Strip key="synced" id="synced" tone="ok" role="status">
          {syncedMsg}
        </Strip>,
      )
    }
    if (!hasSource) {
      strips.push(
        <Strip
          key="no-source"
          id="no-source"
          tone="warn"
          hint={`Set the account to pay shared costs from in Settings before you can allocate ${monthName}.`}
          hintLabel="About the account to pay from"
          action={
            canWrite && (
              <StripAction label="Settings" ariaLabel="Settings: choose the account to pay from" onClick={openSettings} />
            )
          }
        >
          No account to pay from
        </Strip>,
      )
    }
    // Income-source honesty (rule 28): the pool is the month's budgeted income lines —
    // attributed ones per person, unattributed ones shared equally with a nudge to assign
    // them. A month with no income lines has nothing to allocate.
    if (noIncomeInBudget) {
      strips.push(
        <Strip
          key="no-income"
          id="no-income"
          tone="soft"
          role="status"
          hint={`No income in ${monthLabel}’s budget yet. Add income lines to the Dashboard (attribute them to people for a by-income split) and come back.`}
          hintLabel="About adding income"
          action={<StripAction label="Open the Dashboard" onClick={() => navigate('/')} />}
        >
          No income in {monthLabel}’s budget yet
        </Strip>,
      )
    }
    const unattributedMinor = fromAmount(preview.unattributedIncome ?? 0)
    if (unattributedMinor > 0) {
      strips.push(
        <Strip
          key="unattributed"
          id="unattributed"
          tone="warn"
          hint={`${money(unattributedMinor)} of ${monthName}’s income isn’t assigned to a person, so it’s treated as shared equally. Assign income lines on the Dashboard for an accurate split.`}
          hintLabel="About unassigned income"
          action={
            <StripAction label="Assign on the Dashboard" ariaLabel="Assign income lines on the Dashboard" onClick={() => navigate('/')} />
          }
        >
          {money(unattributedMinor)} of income isn’t assigned to a person
        </Strip>,
      )
    }
    if (preview.equalSplitNote) {
      strips.push(
        <Strip key="equal-split" id="equal-split" tone="soft" role="note" hint={preview.equalSplitNote} hintLabel="About the equal split">
          By-income split shared equally
        </Strip>,
      )
    }
    if (showReconcile || doubleCounted) {
      const disagree = !doubleCounted && budgetRemainingMinor !== null && budgetRemainingMinor < unrepresentedMinor
      const full = doubleCounted
        ? 'Pocket money is currently counted twice — once as a budget group and once as the allocation’s pocket-money step.'
        : disagree
          ? `Your budget and your allocation disagree. The budget leaves only ${money(budgetRemainingMinor ?? 0)} unassigned, but the allocation also promises ${money(pocketStepMinor)} in pocket money${positiveSavingsMinor > 0 ? ` and ${money(positiveSavingsMinor)} to personal savings` : ''}. That’s ${money(unrepresentedMinor - (budgetRemainingMinor ?? 0))} more than your income covers — trim budget lines, or lower pocket money in Settings.`
          : `${money(unrepresentedMinor)} of your income is already promised by the allocation (pocket money${positiveSavingsMinor > 0 ? ', personal savings' : ''}) but isn’t in your budget — the budget will keep showing it as “still to assign”.`
      // Named by what is missing only while nothing the allocation promises is in the budget yet.
      // Once some of it is (the pocket-money lines just added, say), the flagged lines can't be told
      // apart, so the line says how much is missing: it never contradicts the "added" strip.
      const line = doubleCounted
        ? 'Pocket money is counted twice'
        : disagree
          ? `Budget and allocation disagree by ${money(unrepresentedMinor - (budgetRemainingMinor ?? 0))}`
          : flaggedPlannedMinor > 0
            ? `${money(unrepresentedMinor)} promised but not budgeted`
            : pocketStepMinor > 0 && positiveSavingsMinor > 0
              ? 'Pocket money and savings aren’t budgeted'
              : pocketStepMinor > 0
                ? 'Pocket money isn’t budgeted'
                : 'Savings aren’t budgeted'
      strips.push(
        <Strip
          key="reconcile"
          id={doubleCounted ? 'double-counted' : disagree ? 'disagree' : 'unbudgeted'}
          tone="warn"
          hint={full}
          hintLabel="About the budget and the allocation"
          action={
            canWrite &&
            pocketStepMinor > 0 && (
              <StripAction
                label="Add pocket money"
                ariaLabel={`Add pocket money to ${monthName}'s budget`}
                onClick={syncPocketLines}
                disabled={busy}
              />
            )
          }
        >
          {line}
        </Strip>,
      )
    }
    if (toSavingsMinor < 0) {
      strips.push(
        <Strip
          key="overshoot"
          id="overshoot"
          tone="bad"
          hint={`Shared costs, jars and pocket money overshoot the pooled income by ${money(-toSavingsMinor)} — pocket money can’t be funded this month.`}
          hintLabel="About the overshoot"
        >
          Over the pooled income by {money(-toSavingsMinor)}
        </Strip>,
      )
    }
    if (nothingToSave && toSavingsMinor === 0 && strandedMinor === 0) {
      strips.push(
        <Strip
          key="nothing-to-save"
          id="nothing-to-save"
          tone="soft"
          hint="Shared spending uses up all the pooled income this month, so there’s nothing left to move to savings."
          hintLabel="About savings this month"
        >
          Nothing left for savings
        </Strip>,
      )
    }
    if (incomeMismatch && budgetIncomeMinor !== null) {
      strips.push(
        <Strip
          key="mismatch"
          id="mismatch"
          tone="soft"
          hint={`Note: the pooled income here (${money(poolMinor)}) doesn’t match ${monthName}’s budgeted income lines (${money(budgetIncomeMinor)}). Both come from the same budget — refresh the page if you’ve just edited it.`}
          hintLabel="About the income here"
        >
          Income here doesn’t match the budget
        </Strip>,
      )
    }
  }

  // ---- The Steps card's (i): one short paragraph (the mock's) saying what each step is ----
  const ruleSplit = (type: number) => profile?.rules.find((r) => r.type === type)?.split
  /**
   * Each person's part of a cost step: " (€X each)" when it is the same for everyone; otherwise
   * by name, after ", split by income" when that is the saved split (and it didn't fall back).
   */
  const shares = (step: AllocationStepDto) => {
    const parts = step.perMember.filter((p) => p.amount !== 0)
    if (parts.length === 0 || step.total <= 0) return ''
    const first = parts[0].amount
    if (parts.length === step.perMember.length && parts.every((p) => p.amount === first)) return ` (${money(fromAmount(first))} each)`
    const byIncome = !step.fellBackToEqual && ruleSplit(step.type) === SplitMethod.ByIncomeRatio
    return `${byIncome ? ', split by income' : ''} (${parts.map((p) => `${p.name} ${money(fromAmount(p.amount))}`).join(', ')})`
  }
  const stepsHint = (() => {
    const steps = preview?.steps ?? []
    const has = (type: number) => steps.find((s) => s.type === type)
    const costs = has(AllocationRuleType.FundEnvelopes)
    const jars = has(AllocationRuleType.FundJars)
    const pocket = has(AllocationRuleType.FixedPerMember)
    const rest = has(AllocationRuleType.SplitRemainderToMembers)
    const out: string[] = []
    const jarsWords = (j: AllocationStepDto) => `this month’s contributions${shares(j)}`
    if (costs) {
      out.push(`Shared costs are ${monthName}’s spending lines${shares(costs)}${jars ? `, jars ${jarsWords(jars)}` : ''}.`)
    } else if (jars) {
      out.push(`Jars are ${jarsWords(jars)}.`)
    }
    if (pocket) out.push('Pocket money is set in Settings.')
    if (rest) {
      const s = ruleSplit(rest.type)
      // The savings card beside this lists each person's share; here, only how it is shared out.
      // Balance at a lean of 0 is a plain even split (IncomeAllocator.BalanceTiltSplit).
      out.push(
        `What’s left goes to savings, ${
          rest.fellBackToEqual
            ? 'split equally'
            : s === SplitMethod.BalanceTilt
              ? (profile?.balanceLeanPercent ?? 25) === 0
                ? 'split equally'
                : 'leaning toward whoever’s savings are lowest'
              : s === SplitMethod.ByIncomeRatio
                ? 'in proportion to income'
                : 'split equally'
        }.`,
      )
    }
    return out.join(' ')
  })()

  return (
    <AppShell active="allocation" title="Allocation" month actions={desktop ? allocateButton || undefined : undefined}>
      {ready && preview && (
        <KpiRow tiles={2}>
          <KpiTile
            hero
            label="Income to allocate"
            hint={`${monthName}’s income lines from the budget, pooled. A line not assigned to a person is shared equally.`}
            value={money(poolMinor)}
            valueLabel={`Income to allocate: ${money(poolMinor)}`}
          />
          <KpiTile
            label="Shared spending"
            icon={<Receipt strokeWidth={1.8} />}
            iconColor="var(--color-steel)"
            value={money(sharedSpendingMinor)}
          />
          <KpiTile
            label="To savings"
            icon={<Coins strokeWidth={1.8} />}
            iconColor="var(--color-sky)"
            // A negative figure is a shortfall, not savings: it reads in the bad red.
            valueTone={toSavingsMinor < 0 ? 'bad' : undefined}
            value={money(toSavingsMinor)}
          />
        </KpiRow>
      )}

      {!desktop && allocateButton && <div className="flex justify-end">{allocateButton}</div>}

      {error && !showSettings && !showCommitConfirm && <ErrorBanner>{error}</ErrorBanner>}
      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && !profile && (
        <EmptyState
          icon={<AllocationIcon className="h-6 w-6" />}
          title="No allocation set up yet"
          description="Choose where shared costs come from and how to split them, then save — we’ll show you the monthly breakdown."
        >
          {canWrite && (
            <Button onClick={openSettings} aria-label="Set up allocation">
              Set up allocation
            </Button>
          )}
        </EmptyState>
      )}

      {strips.length > 0 && <div className="flex flex-col gap-3 max-[699.98px]:gap-2.5">{strips}</div>}

      {ready && preview && (
        <div className="@container">
          <div className="grid items-start gap-4 min-[700px]:gap-6 @min-[880px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            {/* The steps: one segmented bar of the whole income, then the steps as its legend. */}
            <section aria-labelledby={stepsId} className={DASH_CARD}>
              <div className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <h2 id={stepsId} className={CARD_TITLE}>
                    Steps
                  </h2>
                  <InfoHint fixed label="About the steps" buttonClassName={TITLE_HINT}>
                    {stepsHint}
                  </InfoHint>
                </div>
                {canWrite && (
                  <Button data-refocus="settings" variant="secondary" onClick={openSettings} aria-label="Allocation settings" className={OUTLINE_SM}>
                    <SlidersHorizontal aria-hidden strokeWidth={1.8} className="size-[15px]" />
                    Settings
                  </Button>
                )}
              </div>
              <IncomeBar steps={preview.steps} monthName={monthName} money={money} />
              <ol aria-label={`How ${monthName} is allocated`}>
                {preview.steps.map((step, i) => {
                  const terminal = step.type === AllocationRuleType.SplitRemainderToMembers
                  const perEach =
                    step.type === AllocationRuleType.FixedPerMember ? step.perMember[0]?.amount : undefined
                  const look = STEP_LOOK[step.type] ?? STEP_FALLBACK
                  const total = fromAmount(step.total)
                  return (
                    <li
                      key={i}
                      data-step={step.type}
                      className="flex min-h-14 items-center gap-3.5 py-3 not-first:border-t not-first:border-line max-[699.98px]:gap-3"
                    >
                      <TxTile color={look.color}>
                        <look.Icon strokeWidth={1.8} />
                      </TxTile>
                      {/* The name stays whole: "· €X each" follows it, or takes a line of its own under
                          it when the row has no room for both (its dot then sits past the clipped edge). */}
                      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3.5 overflow-hidden whitespace-nowrap">
                        <b className="min-w-0 truncate font-semibold text-slate-900">{STEP_LABEL[step.type] ?? 'Step'}</b>
                        {perEach !== undefined && perEach > 0 && (
                          <span className="relative font-medium text-slate-500">
                            <span aria-hidden className="absolute right-full mr-[5px]">
                              {'· '}
                            </span>
                            {money(fromAmount(perEach))} each
                          </span>
                        )}
                      </span>
                      {terminal && total >= 0 ? (
                        // The last step's total is the To savings tile: here it says who it goes to.
                        <>
                          <span className="sr-only">{money(total)}</span>
                          {/* At most three circles, so the step's name keeps its room: past three
                              people, two avatars and "+N". The image's name lists everyone. */}
                          <span role="img" aria-label={`To ${formatNames(members.map((m) => m.name))}`} className="flex shrink-0">
                            {(members.length > 3 ? members.slice(0, 2) : members).map((m, at) => (
                              <span
                                key={m.memberId}
                                className="rounded-full not-first:-ml-1.5 not-first:shadow-[0_0_0_2px_var(--color-card)]"
                              >
                                <MemberAvatar name={m.name} hue={hueOf(m, at)} className="size-[26px] text-[11px]" />
                              </span>
                            ))}
                            {members.length > 3 && (
                              <span className="-ml-1.5 grid size-[26px] place-items-center rounded-full bg-surface-2 text-[11px] font-[650] text-slate-600 tabular-nums shadow-[inset_0_0_0_1px_var(--color-line),0_0_0_2px_var(--color-card)]">
                                +{members.length - 2}
                              </span>
                            )}
                          </span>
                        </>
                      ) : (
                        <span
                          data-tone={total < 0 ? 'bad' : undefined}
                          className={`shrink-0 text-sm font-[650] tabular-nums ${total < 0 ? 'text-bad' : 'text-slate-900'}`}
                        >
                          {money(total)}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>

            {/* Savings: a row per person — what they save and where it goes. */}
            <section aria-labelledby={savingsId} className={DASH_CARD}>
              <div className="mb-3.5 flex min-h-8 items-center">
                <h2 id={savingsId} className={CARD_TITLE}>
                  Savings
                </h2>
              </div>
              <ul aria-label="Savings by person">
                {preview.members.map((m, i) => {
                  const neg = m.residual < 0
                  const noAccount = !m.savingsAccountId && !m.savingsPrivate
                  const stranded = noAccount && m.residual > 0
                  let sub: ReactNode
                  if (m.savingsPrivate) {
                    sub = (
                      <span className={`flex min-w-0 items-center gap-[5px] text-[13px] ${m.residual > 0 ? 'font-semibold text-warn' : 'text-slate-500'}`}>
                        {m.residual > 0 && <TriangleAlert aria-hidden strokeWidth={2} className="size-3.5 shrink-0" />}
                        <span className="truncate">Private savings account</span>
                        {m.residual > 0 && (
                          <InfoHint fixed label={`About ${m.name}’s share`} buttonClassName={LINE_HINT} className="whitespace-normal">
                            {m.name}’s savings account is private, so only {m.name} can record this transfer. Allocating
                            is refused until {m.name} shares it or picks a shared savings account on the People page.
                          </InfoHint>
                        )}
                      </span>
                    )
                  } else if (noAccount) {
                    sub = (
                      <span className="flex min-w-0 items-center gap-[5px] text-[13px] font-semibold text-warn">
                        <TriangleAlert aria-hidden strokeWidth={2} className="size-3.5 shrink-0" />
                        <span className="truncate">Stays in {sourceShort}</span>
                        <InfoHint fixed label={`About ${m.name}’s share`} buttonClassName={LINE_HINT} className="whitespace-normal">
                          <span className="block">
                            {canWrite
                              ? `No savings account linked — ${m.name}’s share stays in ${sourceAccountName ?? 'the source account'} when you allocate.`
                              : `No savings account linked — ${m.name}’s share will stay in the source account. Ask an admin to link one on the People page.`}
                          </span>
                          {/* The total that stays, only when it is more than this row's own share (two
                              or more people without an account); one person's is the figure beside it. */}
                          {stranded && strandedMembers.length > 1 && (
                            <span className="mt-1.5 block">
                              {money(strandedMinor)} won’t be transferred — {strandedNames} {strandedHasHave} no savings
                              account linked.
                            </span>
                          )}
                        </InfoHint>
                      </span>
                    )
                  } else {
                    const name = savingsName(m)
                    sub = (
                      <span className="flex min-w-0 items-center gap-[5px] text-[13px] text-slate-500">
                        <span className="truncate">{name}</span>
                        <InfoHint fixed label={`About ${m.name}’s savings`} buttonClassName={LINE_HINT} className="whitespace-normal">
                          {m.savingsBalance === null
                            ? 'Savings not available'
                            : `Projected balance ${money(fromAmount(m.savingsBalance + Math.max(0, m.residual)))}: ${money(fromAmount(m.savingsBalance))} in ${name} today${m.residual > 0 ? ', plus this share' : ''}.`}
                        </InfoHint>
                      </span>
                    )
                  }
                  // An admin fixes a missing savings account right here: link one (or make one first).
                  const fix =
                    noAccount && canWrite ? (
                      savingsAccounts.length === 0 ? (
                        <button type="button" onClick={() => navigate('/accounts')} className={FILL_CHIP}>
                          <Plus aria-hidden strokeWidth={2} />
                          Create a savings account
                        </button>
                      ) : (
                        <LinkPicker
                          member={m}
                          phone={phone}
                          disabled={linkingId === m.memberId}
                          suggestion={suggestionFor(m)}
                          accounts={accountsForLinking}
                          onPick={(accountId) => linkSavings(m, accountId)}
                        />
                      )
                    ) : null
                  return (
                    <li
                      key={m.memberId}
                      data-member-id={m.memberId}
                      className="flex items-center gap-3.5 py-3 not-first:border-t not-first:border-line max-[699.98px]:items-start max-[699.98px]:gap-3"
                    >
                      <MemberAvatar name={m.name} hue={hueOf(m, i)} className="size-9 shrink-0 text-sm max-[699.98px]:mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate font-semibold text-slate-900">{m.name}</span>
                          <span
                            data-tone={neg ? 'bad' : undefined}
                            className={`shrink-0 text-base font-[650] tabular-nums ${neg ? 'text-bad' : 'text-slate-900'}`}
                          >
                            {money(fromAmount(m.residual))}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          {sub}
                          {fix && <span className="ml-auto flex max-[699.98px]:ml-0 max-[699.98px]:basis-full">{fix}</span>}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>
        </div>
      )}

      {/* Recording the allocation means recording completed bank transfers: the user confirms they
          made them and when the money left. A stranded share is called out here, never silently skipped. */}
      {showCommitConfirm && (
        <Modal
          sheet
          title={strandedMinor > 0 ? `Allocate without ${strandedNames}?` : `Record ${monthName}’s transfers`}
          hint={
            <>
              The suggested amounts become recorded transfers only once you’ve moved the money at the bank. Each
              transfer is recorded as departed from {sourceAccountName ?? 'the source account'} on the date you set and
              stays in transit until you confirm its receipt on the Transactions page.
            </>
          }
          hintLabel="About recording the transfers"
          onClose={closeCommit}
          footer={
            // On a phone the open date field takes a row of its own, so the checkbox line keeps its width.
            <div
              className={`mt-1.5 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-3.5 pt-3 [grid-template-areas:'chk_chk_chk'_'date_._acts'] max-[699.98px]:grid-cols-[minmax(0,1fr)_auto] max-[699.98px]:gap-y-3 max-[699.98px]:pt-2 ${
                editingDate
                  ? "max-[699.98px]:[grid-template-areas:'chk_chk'_'date_date'_'acts_acts']"
                  : "max-[699.98px]:[grid-template-areas:'chk_date'_'acts_acts']"
              }`}
            >
              <label className="dlg-check flex min-h-10 cursor-pointer items-center gap-2.5 font-semibold text-slate-900 [grid-area:chk] max-[699.98px]:min-h-11 max-[699.98px]:gap-[9px]">
                <input
                  type="checkbox"
                  checked={commitConfirmed}
                  // Recording with the box unticked marks it, beside the message at the top.
                  aria-invalid={(!!error && !commitConfirmed) || undefined}
                  onChange={(e) => setCommitConfirmed(e.target.checked)}
                />
                I’ve completed these transfers
              </label>
              <span
                className={`flex items-center gap-2 [grid-area:date] ${editingDate ? 'max-[699.98px]:justify-self-stretch' : 'max-[699.98px]:justify-self-end'}`}
              >
                {editingDate && (
                  // The pill's words, while its field is open on a row of its own (a phone).
                  <span className="mr-auto text-[13px] font-semibold text-slate-500 min-[700px]:hidden">Sent on</span>
                )}
                {editingDate ? (
                  <input
                    type="date"
                    // The pill opens the field; leaving it (or Enter) shows the pill again.
                    autoFocus
                    value={commitDate}
                    aria-label="Allocation departure date"
                    onChange={(e) => setCommitDate(e.target.value)}
                    onBlur={() => setEditingDate(false)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      focusDatePill.current = true
                      setEditingDate(false)
                    }}
                    // outline-hidden: none on screen (the ring is the shadow), a real outline in a contrast theme.
                    className="h-10 rounded-[10px] bg-[var(--dlg-field)] px-3 text-[13px] font-semibold text-slate-900 shadow-[inset_0_0_0_1px_var(--dlg-edge)] focus:shadow-[inset_0_0_0_1.5px_var(--color-ring),0_0_0_3px_color-mix(in_srgb,var(--color-ring)_14%,transparent)] focus:outline-hidden forced-colors:border forced-colors:border-[CanvasText] max-[699.98px]:text-base"
                  />
                ) : (
                  <DatePill
                    date={commitDate}
                    source={sourceAccountName ?? 'the source account'}
                    onOpen={() => setEditingDate(true)}
                    takeFocusRef={focusDatePill}
                  />
                )}
              </span>
              <div className="flex gap-2 [grid-area:acts] max-[699.98px]:gap-2.5">
                <Button variant="ghost" onClick={closeCommit} className="h-10 px-3.5 text-slate-500 max-[699.98px]:h-11">
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    if (!commitConfirmed) {
                      setError('Confirm that you’ve completed these transfers before recording them.')
                      return
                    }
                    closeCommit()
                    await commit()
                  }}
                  disabled={busy}
                  className={`${PRIMARY_BUTTON} h-10! min-w-[104px] px-[18px]! max-[699.98px]:h-11! max-[699.98px]:flex-1`}
                >
                  Record transfers
                </Button>
              </div>
            </div>
          }
        >
          {error && (
            <div ref={commitErrorRef} className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <CommitList
            members={members}
            hueOf={hueOf}
            money={money}
            source={sourceShort}
            savingsName={savingsName}
            strandedWhy={
              strandedMinor > 0
                ? `${money(strandedMinor)} will stay in ${sourceAccountName ?? 'the source account'} because ${strandedNames} ${strandedHasHave} no savings account linked. You can link one on the person’s row and re-run — re-running Allocate keeps unchanged transfers, never doubles up.`
                : ''
            }
          />
          {jarMembers.map(({ member, ledger, jars }) => (
            <div key={member.memberId} className="mt-5 max-[699.98px]:mt-[18px]">
              <JarAllocationFields
                look="dialog"
                // One person's jars: "Into jars"; several: whose jars each list is.
                title={jarMembers.length > 1 ? `Into ${member.name}’s jars` : 'Into jars'}
                hintLabel={jarMembers.length > 1 ? `About putting ${member.name}’s share into jars` : undefined}
                hint={
                  <>
                    A savings account here holds jars. {member.name}’s {money(fromAmount(member.residual))} lands in{' '}
                    {ledger.accountName}: say how much of it goes into which jar; whatever you leave empty stays
                    unallocated.
                  </>
                }
                idPrefix={`alloc-${member.memberId}`}
                jars={jars}
                accountName={ledger.accountName}
                currency={ledger.currency}
                amount={member.residual}
                value={allocJar[member.memberId] ?? {}}
                onChange={(value) => setAllocJar((prev) => ({ ...prev, [member.memberId]: value }))}
              />
            </div>
          ))}
        </Modal>
      )}

      {/* Allocation settings — a modal (mounted only while open so the focus trap engages). */}
      {showSettings && canWrite && (
        <Modal
          sheet
          title={profile ? 'Allocation settings' : 'Set up allocation'}
          onClose={closeSettings}
          footer={
            <div className="mt-1.5 flex justify-end pt-3 max-[699.98px]:pt-2">
              <div className="flex gap-2 max-[699.98px]:w-full max-[699.98px]:gap-2.5">
                <Button variant="ghost" onClick={closeSettings} aria-label="Cancel settings" className="h-10 px-3.5 text-slate-500 max-[699.98px]:h-11">
                  Cancel
                </Button>
                <Button
                  onClick={saveProfile}
                  disabled={busy}
                  aria-label="Save allocation settings"
                  className={`${PRIMARY_BUTTON} h-10! min-w-[104px] px-[18px]! max-[699.98px]:h-11! max-[699.98px]:flex-1`}
                >
                  {profile ? 'Save' : 'Set up'}
                </Button>
              </div>
            </div>
          }
        >
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          {/* Two columns: the choices on the left (one width, so the select and the segmented
              controls line up), the amounts on the right. */}
          <div className="grid grid-cols-[minmax(0,1fr)_128px] gap-x-3 gap-y-[18px] pt-0.5 pb-1.5 max-[699.98px]:grid-cols-[minmax(0,1fr)_140px] max-[699.98px]:gap-x-2.5 max-[699.98px]:gap-y-4">
            {/* div, not label — an InfoHint <button> inside a <label> would become the label's
                control (clicking the text would open the tooltip instead of focusing the field);
                the select carries its own aria-label. */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={FIELD_LABEL}>
                Pay shared costs from
                <InfoHint fixed label="About the source account" buttonClassName={FIELD_HINT} className="whitespace-normal">
                  The account the allocated savings are transferred out of when you press “Allocate”. It only
                  affects the commit — the preview below is the same whichever account you pick.
                </InfoHint>
              </span>
              <span className="dlg-sel">
                <select value={sourceAccountId} aria-label="Source account" onChange={(e) => setSourceAccountId(e.target.value)}>
                  {sourceAccountId === PRIVATE_SOURCE ? (
                    <option value={PRIVATE_SOURCE}>{PRIVATE_ACCOUNT}</option>
                  ) : (
                    <option value="">Choose an account…</option>
                  )}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden strokeWidth={1.8} />
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {/* The one real <label> here (its field has no (i)); the € sits outside it, so the label says only its words. */}
              <label htmlFor={pocketId} className={FIELD_LABEL}>
                Pocket money (each)
              </label>
              {/* The whole field is a target: a press beside the figure still reaches the input. */}
              <label className="dlg-in">
                <span aria-hidden>{currencySymbol(CURRENCY)}</span>
                <input
                  id={pocketId}
                  type="text"
                  inputMode="decimal"
                  {...selectOnFocusProps}
                  value={pocket}
                  placeholder="0.00"
                  aria-label="Pocket money per member"
                  onChange={(e) => setPocket(e.target.value)}
                />
              </label>
            </div>
            <div className="col-start-1 flex min-w-0 flex-col gap-1.5 max-[699.98px]:col-span-2">
              <span className={FIELD_LABEL}>
                Split shared costs
                <InfoHint fixed label="About splitting shared costs" buttonClassName={FIELD_HINT} className="whitespace-normal">
                  How much each person is treated as contributing to the shared costs and jars — split Equally, or in
                  proportion to income.
                </InfoHint>
              </span>
              <div className={SEG_STRETCH}>
                <SegmentedControl
                  variant="quiet"
                  value={String(split)}
                  ariaLabel="Split method"
                  onChange={(v) => setSplit(Number(v))}
                  options={[
                    { value: String(SplitMethod.Equal), label: 'Equally' },
                    { value: String(SplitMethod.ByIncomeRatio), label: 'By income' },
                  ]}
                />
              </div>
            </div>
            <div className="col-start-1 flex min-w-0 flex-col gap-1.5 max-[699.98px]:col-span-2">
              <span className={FIELD_LABEL}>
                Send savings to
                <InfoHint fixed label="About the savings split" buttonClassName={FIELD_HINT} className="whitespace-normal">
                  How the pooled leftover is divided into each person’s savings. <strong>Balance</strong> leans toward
                  whoever’s savings are lowest; <strong>Equally</strong> splits it evenly; <strong>By income</strong>{' '}
                  splits it in proportion to each person’s income.
                </InfoHint>
              </span>
              <div className={SEG_STRETCH}>
                <SegmentedControl
                  variant="quiet"
                  value={String(savingsSplit)}
                  ariaLabel="Savings split method"
                  onChange={(v) => setSavingsSplit(Number(v))}
                  options={[
                    { value: String(SplitMethod.BalanceTilt), label: 'Balance' },
                    { value: String(SplitMethod.Equal), label: 'Equally' },
                    { value: String(SplitMethod.ByIncomeRatio), label: 'By income' },
                  ]}
                />
              </div>
            </div>
            {savingsSplit === SplitMethod.BalanceTilt && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={FIELD_LABEL}>
                  Balance lean
                  <InfoHint fixed label="About balance lean" buttonClassName={FIELD_HINT} align="end" className="whitespace-normal">
                    How hard the split leans toward equalising savings. <strong>0</strong> is a plain even split;{' '}
                    <strong>100</strong> fills the lowest balance first. 25 is a gentle nudge.
                  </InfoHint>
                </span>
                {/* On a phone the field spans the first column; it keeps the amount column's width. */}
                <label className="dlg-in max-[699.98px]:w-[140px]">
                  <input
                    type="text"
                    inputMode="numeric"
                    {...selectOnFocusProps}
                    value={lean}
                    placeholder="25"
                    aria-label="Balance lean percent"
                    onChange={(e) => setLean(e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </Modal>
      )}
    </AppShell>
  )
}

/** A quiet segmented control stretched to its column, each option an equal share (40px on a phone). */
const SEG_STRETCH =
  '[&>[role=group]]:flex [&>[role=group]]:w-full [&_button]:flex-1 [&_button]:justify-center max-[699.98px]:[&_button]:h-10'

/**
 * The month's income as one segmented bar: each step's slice, in order (a step below zero has no
 * slice). An image whose name says the same in words.
 */
function IncomeBar({
  steps,
  monthName,
  money,
}: {
  steps: AllocationStepDto[]
  monthName: string
  money: (minor: number) => string
}) {
  const weights = steps.map((s) => Math.max(0, fromAmount(s.total)))
  if (weights.every((w) => w === 0)) return null
  const said = steps.map((s) => `${money(fromAmount(s.total))} ${(STEP_LABEL[s.type] ?? 'step').toLowerCase()}`).join(', ')
  return (
    <div role="img" aria-label={`${monthName}’s income: ${said}`} className="mt-0.5 mb-2 flex h-2 gap-[3px] max-[699.98px]:mb-1.5 max-[699.98px]:h-1.5">
      {steps.map((s, i) =>
        weights[i] > 0 ? (
          <span
            key={i}
            className="min-w-1.5 rounded-full"
            style={{ flex: `${weights[i]} 1 0`, background: (STEP_LOOK[s.type] ?? STEP_FALLBACK).color }}
          />
        ) : null,
      )}
    </div>
  )
}

/**
 * "+ Link account" (a person with no savings account): the dashed chip opens the account picker,
 * a menu on a wider screen and a bottom sheet on a phone. A one-click suggestion (the one unlinked
 * savings account named after the person) comes first; then every account, savings first.
 */
function LinkPicker({
  member,
  phone,
  disabled,
  suggestion,
  accounts,
  onPick,
}: {
  member: MemberAllocationDto
  phone: boolean
  disabled: boolean
  suggestion: AccountDto | null
  accounts: AccountDto[]
  onPick: (accountId: string) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const actions: RowAction[] = [
    ...(suggestion
      ? [
          {
            key: `use-${suggestion.id}`,
            label: `Use “${suggestion.name}”`,
            // The account's own type icon, as its row has: a tick would read as "already linked".
            icon: (() => {
              const Icon = TYPE_ICON[suggestion.type] ?? Banknote
              return <Icon aria-hidden strokeWidth={1.8} />
            })(),
            disabled,
            onSelect: () => onPick(suggestion.id),
          },
        ]
      : []),
    ...accounts
      .filter((a) => a.id !== suggestion?.id)
      .map((a, i) => {
        const Icon = TYPE_ICON[a.type] ?? Banknote
        return {
          key: a.id,
          label: a.name,
          // The type is in the icon for the eye; the name says it in words.
          ariaLabel: accountOptionLabel(a),
          icon: <Icon aria-hidden strokeWidth={1.8} />,
          disabled,
          separatorBefore: !!suggestion && i === 0,
          onSelect: () => onPick(a.id),
        }
      }),
  ]
  const title = `Savings account for ${member.name}`
  const chip = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Link account for ${member.name}’s savings`}
      className={FILL_CHIP}
    >
      <Plus aria-hidden strokeWidth={2} />
      Link account
    </button>
  )
  return phone ? (
    <ActionSheet title={title} actions={actions} open={sheetOpen} onOpenChange={setSheetOpen}>
      {chip}
    </ActionSheet>
  ) : (
    <RowMenu label={title} menuLabel={title} actions={actions} trigger={chip} />
  )
}

/**
 * The Allocate dialog's people, as one grouped list: who moves what, from where to where; whose
 * share stays in the source account (and why, behind its (i)); whose private account only they
 * can record into. A share of zero or less moves nothing and has no line.
 */
function CommitList({
  members,
  hueOf,
  money,
  source,
  savingsName,
  strandedWhy,
}: {
  members: MemberAllocationDto[]
  hueOf: (m: MemberAllocationDto, i: number) => ReturnType<typeof memberHue>
  money: (minor: number) => string
  source: string
  savingsName: (m: MemberAllocationDto) => string
  strandedWhy: string
}) {
  const rows = members
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.residual > 0)
    // The transfers first, then the shares that stay put.
    .sort((a, b) => Number(!a.m.savingsAccountId || !!a.m.savingsPrivate) - Number(!b.m.savingsAccountId || !!b.m.savingsPrivate))
  // Nobody has a share to move (the month's spending uses up the pool): say so, not an empty sheet.
  if (rows.length === 0) return <p className="py-2 text-sm text-slate-500">No savings to transfer this month.</p>
  return (
    <ul aria-label="Transfers" className="rounded-xl bg-[var(--dlg-field)] shadow-[inset_0_0_0_1px_var(--color-line)]">
      {rows.map(({ m, i }) => {
        const moves = !!m.savingsAccountId && !m.savingsPrivate
        return (
          <li
            key={m.memberId}
            data-member-id={m.memberId}
            className="relative flex min-h-[62px] items-center gap-3 py-2.5 pr-4 pl-3.5 not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[58px] not-first:before:border-t not-first:before:border-slate-200 not-first:before:content-[''] max-[699.98px]:pr-3.5 max-[699.98px]:pl-3 max-[699.98px]:not-first:before:left-14"
          >
            <MemberAvatar name={m.name} hue={hueOf(m, i)} className="size-8 shrink-0 text-[13px]" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={`truncate text-base font-semibold ${moves ? 'text-slate-900' : 'text-slate-500'}`}>{m.name}</span>
              <span className="flex min-w-0 items-center gap-[5px] text-[13px] text-slate-500">
                {moves ? (
                  <>
                    <span className="truncate">{source}</span>
                    <ArrowRight aria-hidden strokeWidth={1.8} className="size-[13px] shrink-0 text-slate-400" />
                    <span className="sr-only"> to </span>
                    <span className="truncate">{savingsName(m)}</span>
                  </>
                ) : m.savingsPrivate ? (
                  <>
                    <span className="truncate">Private savings account</span>
                    <InfoHint fixed label={`About ${m.name}’s share`} buttonClassName={LINE_HINT} className="whitespace-normal">
                      {m.name}’s savings account is private, so only {m.name} can record this transfer. Allocating is
                      refused until {m.name} shares it or picks a shared savings account on the People page.
                    </InfoHint>
                  </>
                ) : (
                  <>
                    <span className="truncate">Stays in {source}</span>
                    <InfoHint fixed label={`About ${m.name}’s share`} buttonClassName={LINE_HINT} className="whitespace-normal">
                      {strandedWhy}
                    </InfoHint>
                  </>
                )}
              </span>
            </span>
            <span className={`ml-auto shrink-0 text-base tabular-nums ${moves ? 'font-[650] text-slate-900' : 'font-semibold text-slate-500'}`}>
              {money(fromAmount(m.residual))}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** "Sent today" (or "Sent 3 Jun"): the date the money left, as a quiet pill that opens the date field. */
function DatePill({
  date,
  source,
  onOpen,
  takeFocusRef,
}: {
  date: string
  source: string
  onOpen: () => void
  /** Set when the field closed by Enter: the pill takes focus back as it appears. */
  takeFocusRef: { current: boolean }
}) {
  const sent = !date
    ? 'Sent on…'
    : date === todayIso()
      ? 'Sent today'
      : `Sent ${new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          ...(date.slice(0, 4) === todayIso().slice(0, 4) ? {} : { year: 'numeric' }),
        })}`
  return (
    <button
      type="button"
      ref={(el) => {
        if (el && takeFocusRef.current) {
          takeFocusRef.current = false
          el.focus()
        }
      }}
      onClick={onOpen}
      aria-label={`${sent}: the date the money left ${source}`}
      className="inline-flex h-10 items-center gap-[7px] rounded-[10px] px-[13px] text-[13px] font-semibold whitespace-nowrap text-slate-500 shadow-[inset_0_0_0_1px_var(--color-border)] transition hover:bg-surface-2 hover:text-slate-900 forced-colors:border forced-colors:border-[ButtonText] max-[699.98px]:gap-1.5 max-[699.98px]:px-[11px] dark:hover:bg-foreground/7"
    >
      <CalendarDays aria-hidden strokeWidth={1.8} className="size-3.5 text-slate-400" />
      {sent}
    </button>
  )
}
