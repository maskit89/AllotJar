import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select, SegmentedControl } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { AllocationIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { api } from '../lib/api'
import { bucketCount, EVENTS, track } from '../analytics'
import type { AccountDto, AllocationProfileDto, AllocationResultDto, BudgetMonthDto } from '../types'
import { AllocationRuleType, SplitMethod } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'

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

function standardRules(costSplit: number, pocketAmount: number, savingsSplit: number): RuleSpec[] {
  return [
    { order: 0, type: AllocationRuleType.FundEnvelopes, split: costSplit, fixedAmountPerMember: 0 },
    { order: 1, type: AllocationRuleType.FundJars, split: costSplit, fixedAmountPerMember: 0 },
    { order: 2, type: AllocationRuleType.FixedPerMember, split: SplitMethod.Equal, fixedAmountPerMember: pocketAmount },
    { order: 3, type: AllocationRuleType.SplitRemainderToMembers, split: savingsSplit, fixedAmountPerMember: 0 },
  ]
}

export function AllocationPage() {
  // Editing the allocation profile needs Admin+; running an allocation is day-to-day (Limited+).
  const { canWrite, canEnterData, preferredCurrency } = useAuth()
  const { isShared, loading: householdLoading } = useHousehold()
  const navigate = useNavigate()
  const CURRENCY = preferredCurrency
  const [profile, setProfile] = useState<AllocationProfileDto | null>(null)
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [preview, setPreview] = useState<AllocationResultDto | null>(null)
  const [period, setPeriod] = useState<{ year: number; month: number }>(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState<number | null>(null)

  // Setup/edit form (in a modal).
  const [showSettings, setShowSettings] = useState(false)
  const [sourceAccountId, setSourceAccountId] = useState('')
  const [pocket, setPocket] = useState('')
  const [split, setSplit] = useState<number>(SplitMethod.Equal)
  const [savingsSplit, setSavingsSplit] = useState<number>(SplitMethod.BalanceTilt)
  const [lean, setLean] = useState('25')

  const loadPreview = useCallback(async (year: number, month: number) => {
    try {
      const { data } = await api.get<AllocationResultDto>(`/allocation/preview/${year}/${month}`)
      setPreview(data)
    } catch {
      setError('Could not compute the allocation preview.')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<AllocationProfileDto | null>('/allocation/profile').catch(() => ({ data: null })),
      api.get<AccountDto[]>('/accounts').catch(() => ({ data: [] })),
      api.get<BudgetMonthDto>('/budget/current').catch(() => null),
    ])
      .then(async ([prof, acc, budget]) => {
        if (cancelled) return
        const p = prof?.data ?? null
        setProfile(p)
        setAccounts(Array.isArray(acc?.data) ? acc.data : [])
        const year = budget?.data?.year ?? period.year
        const month = budget?.data?.month ?? period.month
        setPeriod({ year, month })
        if (p) {
          setSourceAccountId(p.sourceAccountId ?? '')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveProfile = useCallback(async () => {
    const pocketAmount = pocket.trim() === '' ? 0 : parseMinor(pocket)
    if (pocketAmount === null) {
      setError('Enter a valid pocket-money amount.')
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
        sourceAccountId: sourceAccountId || null,
        balanceLeanPercent: leanValue,
        rules: standardRules(split, toAmount(pocketAmount as number), savingsSplit),
      })
      setProfile(data)
      track(EVENTS.allocationPreviewed, { split })
      await loadPreview(period.year, period.month)
      setShowSettings(false)
    } catch {
      setError('Could not save the allocation profile.')
    } finally {
      setBusy(false)
    }
  }, [pocket, lean, split, savingsSplit, sourceAccountId, profile, period, loadPreview])

  const commit = useCallback(async () => {
    setBusy(true)
    setError(null)
    setCommitted(null)
    try {
      const { data } = await api.post<AllocationResultDto>(`/allocation/commit/${period.year}/${period.month}`, {})
      setPreview(data)
      setCommitted(data.transfersCreated)
      track(EVENTS.allocationCommitted, { count_bucket: bucketCount(data.transfersCreated) })
    } catch {
      setError('Could not commit the allocation. Check the source account and members’ savings accounts are set.')
    } finally {
      setBusy(false)
    }
  }, [period])

  const monthName = useMemo(
    () => new Date(period.year, period.month - 1, 1).toLocaleDateString('en-GB', { month: 'long' }),
    [period],
  )

  // Hero figures — the pooled income, what goes to shared costs, what goes to savings.
  const stepTotal = (type: number) =>
    fromAmount(preview?.steps.find((s) => s.type === type)?.total ?? 0)
  const sharedCostsMinor = stepTotal(AllocationRuleType.FundEnvelopes)
  const toSavingsMinor = stepTotal(AllocationRuleType.SplitRemainderToMembers)

  // Allocation only makes sense once the budget is shared. A solo user who reaches
  // this route directly gets a friendly nudge to add members rather than an empty engine.
  if (!householdLoading && !isShared) {
    return (
      <AppShell active="allocation" title="Income allocation">
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

  return (
    <AppShell active="allocation" title="Income allocation">
      {profile && preview && (
        <Hero
          eyebrow="Income to allocate"
          amount={formatMoney(fromAmount(preview.pool), CURRENCY)}
          amountLabel={`Income to allocate: ${formatMoney(fromAmount(preview.pool), CURRENCY)}`}
          tiles={[
            { label: 'Shared costs', value: formatMoney(sharedCostsMinor, CURRENCY) },
            { label: 'To savings', value: formatMoney(toSavingsMinor, CURRENCY) },
          ]}
        />
      )}

      {error && !showSettings && <ErrorBanner>{error}</ErrorBanner>}
      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && !profile && (
        <EmptyState
          icon={<AllocationIcon className="h-6 w-6" />}
          title="No allocation set up yet"
          description="Choose where shared costs come from and how to split them, then save — we’ll show you the monthly breakdown."
        >
          {canWrite && (
            <Button onClick={() => { setError(null); setShowSettings(true) }} aria-label="Set up allocation">
              Set up allocation
            </Button>
          )}
        </EmptyState>
      )}

      {!loading && profile && preview && (
        <Card as="section" className="px-6 py-[22px]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">How {monthName} is allocated</h2>
            <div className="flex items-center gap-2">
              {canWrite && (
                <Button variant="ghost" size="sm" onClick={() => { setError(null); setShowSettings(true) }} aria-label="Allocation settings">
                  Settings
                </Button>
              )}
              {canEnterData && (
                <Button onClick={commit} disabled={busy} aria-label="Commit allocation">
                  Allocate {monthName}
                </Button>
              )}
            </div>
          </div>

          {committed !== null && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
            >
              Allocated — created {committed} savings transfer{committed === 1 ? '' : 's'}.
            </div>
          )}

          {/* The waterfall — each step and the amount it moves (terminal row highlighted). */}
          <ol>
            {preview.steps.map((step, i) => {
              const terminal = step.type === AllocationRuleType.SplitRemainderToMembers
              const perEach =
                step.type === AllocationRuleType.FixedPerMember ? step.perMember[0]?.amount : undefined
              return (
                <li
                  key={i}
                  className={`flex items-center justify-between gap-3 px-4 py-3.5 ${
                    i > 0 ? 'border-t border-slate-100' : ''
                  } ${terminal ? 'rounded-lg bg-brand-50 dark:bg-brand-500/10' : ''}`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-hidden />
                    <span className="text-sm font-medium text-slate-700">{STEP_LABEL[step.type] ?? 'Step'}</span>
                    {perEach !== undefined && perEach > 0 && (
                      <span className="text-sm text-slate-500">· {formatMoney(fromAmount(perEach), CURRENCY)} each</span>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {formatMoney(fromAmount(step.total), CURRENCY)}
                  </span>
                </li>
              )
            })}
          </ol>

          {/* Each person's surplus → their savings. */}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {preview.members.map((m) => (
              <div key={m.memberId} className="rounded-xl border border-slate-200/70 p-4">
                <p className="text-sm font-semibold text-slate-800">{m.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Savings {formatMoney(fromAmount(m.savingsBalance), CURRENCY)} → saves
                </p>
                <p
                  className={`text-xl font-bold tabular-nums ${
                    m.residual < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-brand-700 dark:text-brand-200'
                  }`}
                >
                  {formatMoney(fromAmount(m.residual), CURRENCY)}
                </p>
                <p className="text-xs tabular-nums text-slate-500">
                  New balance {formatMoney(fromAmount(m.savingsBalance + m.residual), CURRENCY)}
                </p>
                {!m.savingsAccountId && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    No savings account set — won’t transfer on commit.
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Allocation settings — a modal (mounted only while open so the focus trap engages). */}
      {showSettings && canWrite && (
        <Modal title={profile ? 'Allocation settings' : 'Set up allocation'} onClose={() => setShowSettings(false)} size="lg">
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="space-y-4">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Pay shared costs from
              <Select
                value={sourceAccountId}
                aria-label="Source account"
                onChange={(e) => setSourceAccountId(e.target.value)}
                className="w-full"
              >
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Pocket money (each)
              <Input
                type="text"
                inputMode="decimal"
                value={pocket}
                placeholder="0.00"
                aria-label="Pocket money per member"
                onChange={(e) => setPocket(e.target.value)}
                className="w-40 text-right tabular-nums"
              />
            </label>
            <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Split shared costs
              <SegmentedControl
                value={String(split)}
                ariaLabel="Split method"
                onChange={(v) => setSplit(Number(v))}
                options={[
                  { value: String(SplitMethod.Equal), label: 'Equally' },
                  { value: String(SplitMethod.ByIncomeRatio), label: 'By income' },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Send savings to
              <SegmentedControl
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
            {savingsSplit === SplitMethod.BalanceTilt && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Balance lean (0–100)
                <Input
                  type="text"
                  inputMode="numeric"
                  value={lean}
                  placeholder="25"
                  aria-label="Balance lean percent"
                  onChange={(e) => setLean(e.target.value)}
                  className="w-24 text-right tabular-nums"
                />
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setShowSettings(false)} aria-label="Cancel settings">
                Cancel
              </Button>
              <Button onClick={saveProfile} disabled={busy} aria-label="Save allocation settings">
                {profile ? 'Save' : 'Set up'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </AppShell>
  )
}
