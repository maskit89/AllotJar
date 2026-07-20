import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select, SegmentedControl } from '../components/ui'
import { Hero } from '../components/Hero'
import { InfoHint } from '../components/InfoHint'
import { Modal } from '../components/Modal'
import { AllocationIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { api } from '../lib/api'
import { bucketCount, EVENTS, track } from '../analytics'
import type { AccountDto, AllocationProfileDto, AllocationResultDto, BudgetMonthDto, MemberAllocationDto } from '../types'
import { AccountType, AllocationRuleType, SplitMethod } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { accountOptionLabel, formatNames, savingsFirst } from '../lib/accountOptions'
import { selectOnFocusProps } from '../lib/selectOnFocus'

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
  // Inline savings-link (member card) + the allocate-with-stranded-shares confirm.
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [showCommitConfirm, setShowCommitConfirm] = useState(false)

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
        // `|| null` (not `?? null`) so a falsy body — a 204's '' or an empty string — normalises
        // to null too; otherwise `''` survives and openSettings throws on `''?.rules.find`.
        const p = prof?.data || null
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
      // A prior "Allocated" banner is now stale (the numbers just changed) — clear it.
      setCommitted(null)
      track(EVENTS.allocationPreviewed, { split })
      await loadPreview(period.year, period.month)
      setShowSettings(false)
    } catch {
      setError('Could not save the allocation profile.')
    } finally {
      setBusy(false)
    }
  }, [pocket, lean, split, savingsSplit, sourceAccountId, profile, period, loadPreview])

  // Link a savings account to a member straight from the warning on their card. Full-echo
  // PUT: name + income come from the preview DTO, so a concurrent People-page income edit in
  // the window between preview load and this PUT is overwritten (last write wins) — a narrow,
  // accepted race for a link action.
  const linkSavings = useCallback(
    async (m: MemberAllocationDto, accountId: string) => {
      if (!accountId) return
      setLinkingId(m.memberId)
      setError(null)
      try {
        await api.put(`/members/${m.memberId}`, {
          name: m.name,
          netMonthlyIncome: m.netIncome,
          personalSavingsAccountId: accountId,
        })
        // The balance-tilt figures change once the link lands; a prior banner is stale.
        setCommitted(null)
        await loadPreview(period.year, period.month)
      } catch {
        setError(`Could not link a savings account for ${m.name}.`)
      } finally {
        setLinkingId(null)
      }
    },
    [period, loadPreview],
  )

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

  // Re-seed the settings form from the saved profile (defaults when there's none). Called when the
  // modal opens (clean start) and closes (Cancel/backdrop discards unsaved edits, so a later Save
  // can't quietly commit a value the user thought they'd cancelled).
  const syncFormFromProfile = useCallback(() => {
    setError(null)
    setSourceAccountId(profile?.sourceAccountId ?? '')
    const pocketRule = profile?.rules.find((r) => r.type === AllocationRuleType.FixedPerMember)
    setPocket(pocketRule ? toEditString(fromAmount(pocketRule.fixedAmountPerMember)) : '')
    const fundRule = profile?.rules.find((r) => r.type === AllocationRuleType.FundEnvelopes)
    setSplit(fundRule?.split ?? SplitMethod.Equal)
    const savingsRule = profile?.rules.find((r) => r.type === AllocationRuleType.SplitRemainderToMembers)
    setSavingsSplit(savingsRule?.split ?? SplitMethod.BalanceTilt)
    setLean(String(profile?.balanceLeanPercent ?? 25))
  }, [profile])

  const openSettings = useCallback(() => {
    syncFormFromProfile()
    setShowSettings(true)
  }, [syncFormFromProfile])
  const closeSettings = useCallback(() => {
    syncFormFromProfile()
    setShowSettings(false)
  }, [syncFormFromProfile])

  const monthName = useMemo(
    // undefined locale = the visitor's browser locale (e.g. "June" / "Juni").
    () => new Date(period.year, period.month - 1, 1).toLocaleDateString(undefined, { month: 'long' }),
    [period],
  )

  // Hero figures. The pool splits into shared spending (costs + jars + pocket money) and savings,
  // so those two tiles reconcile exactly to the pooled income; the waterfall below breaks spending
  // down further.
  const stepTotal = (type: number) =>
    fromAmount(preview?.steps.find((s) => s.type === type)?.total ?? 0)
  const sharedSpendingMinor =
    stepTotal(AllocationRuleType.FundEnvelopes) +
    stepTotal(AllocationRuleType.FundJars) +
    stepTotal(AllocationRuleType.FixedPerMember)
  const toSavingsMinor = stepTotal(AllocationRuleType.SplitRemainderToMembers)

  // What will actually transfer on commit vs. what's stranded because a member has no savings
  // account (a positive share with nowhere to go stays in the source account).
  const members = preview?.members ?? []
  const strandedMembers = members.filter((m) => !m.savingsAccountId && m.residual > 0)
  const strandedMinor = fromAmount(strandedMembers.reduce((sum, m) => sum + m.residual, 0))
  const strandedNames = formatNames(strandedMembers.map((m) => m.name))
  const strandedHasHave = strandedMembers.length === 1 ? 'has' : 'have'
  const nothingToSave = !!preview && toSavingsMinor <= 0
  const hasSource = !!profile?.sourceAccountId
  const sourceAccountName = accounts.find((a) => a.id === profile?.sourceAccountId)?.name

  // The inline link picker's offerings: savings accounts first, and a one-click suggestion
  // when exactly ONE unlinked savings account's name contains the member's (offer-only —
  // nothing is ever linked without a click).
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
            { label: 'Shared spending', value: formatMoney(sharedSpendingMinor, CURRENCY) },
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
            <Button onClick={openSettings} aria-label="Set up allocation">
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
                <Button variant="ghost" size="sm" onClick={openSettings} aria-label="Allocation settings">
                  Settings
                </Button>
              )}
              {canEnterData && (
                <Button
                  onClick={() => (strandedMinor > 0 ? setShowCommitConfirm(true) : commit())}
                  disabled={busy || !hasSource}
                  aria-label="Commit allocation"
                >
                  Allocate {monthName}
                </Button>
              )}
            </div>
          </div>

          {!hasSource && (
            <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">
              Set the account to pay shared costs from in <span className="font-medium">Settings</span> before
              you can allocate {monthName}.
            </p>
          )}

          {committed !== null && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
            >
              {committed === 0
                ? `Allocated ${monthName} — no savings transfers were needed this month.`
                : `Allocated ${monthName} — ${committed} savings transfer${committed === 1 ? '' : 's'} created. Re-running Allocate replaces them, never doubles up.`}
              {strandedMinor > 0 &&
                ` ${formatMoney(strandedMinor, CURRENCY)} stayed in ${sourceAccountName ?? 'the source account'} for ${strandedNames} (no savings account linked).`}
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

          {nothingToSave && strandedMinor === 0 && (
            <p className="mt-4 text-sm text-slate-500">
              Shared spending uses up all the pooled income this month, so there’s nothing left to move to
              savings.
            </p>
          )}
          {strandedMinor > 0 && (
            <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
              {formatMoney(strandedMinor, CURRENCY)} won’t be transferred — {strandedNames} {strandedHasHave} no
              savings account linked (see below).
            </p>
          )}

          {/* Each person's surplus → their savings. */}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {preview.members.map((m) => {
              const suggestion = suggestionFor(m)
              const linking = linkingId === m.memberId
              return (
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
                  Projected balance {formatMoney(fromAmount(m.savingsBalance + m.residual), CURRENCY)}
                </p>
                {!m.savingsAccountId && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {canWrite
                        ? `No savings account linked — ${m.name}’s share stays in ${sourceAccountName ?? 'the source account'} when you allocate.`
                        : `No savings account linked — ${m.name}’s share will stay in the source account. Ask an admin to link one on the People page.`}
                    </p>
                    {canWrite && savingsAccounts.length === 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/accounts')}
                        className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-200"
                      >
                        Create a savings account
                      </button>
                    )}
                    {canWrite && savingsAccounts.length > 0 && (
                      <>
                        {suggestion && (
                          <button
                            type="button"
                            onClick={() => linkSavings(m, suggestion.id)}
                            disabled={linking}
                            className="rounded-full border border-brand-300 bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200"
                          >
                            Use “{suggestion.name}”
                          </button>
                        )}
                        <Select
                          value=""
                          aria-label={`Savings account for ${m.name}`}
                          disabled={linking}
                          onChange={(e) => linkSavings(m, e.target.value)}
                          className="w-full text-xs"
                        >
                          <option value="">Link a savings account…</option>
                          {accountsForLinking.map((a) => (
                            <option key={a.id} value={a.id}>
                              {accountOptionLabel(a)}
                            </option>
                          ))}
                        </Select>
                      </>
                    )}
                  </div>
                )}
              </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Allocating while someone's share has nowhere to go: explicit confirm, never a silent skip. */}
      {showCommitConfirm && (
        <Modal title={`Allocate without ${strandedNames}?`} onClose={() => setShowCommitConfirm(false)}>
          <p className="text-sm text-slate-600">
            {formatMoney(strandedMinor, CURRENCY)} will stay in {sourceAccountName ?? 'the source account'}{' '}
            because {strandedNames} {strandedHasHave} no savings account linked. You can link one on the
            person’s card and re-run — re-running Allocate replaces the transfers, never doubles up.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCommitConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setShowCommitConfirm(false)
                commit()
              }}
              aria-label="Allocate anyway"
            >
              Allocate anyway
            </Button>
          </div>
        </Modal>
      )}

      {/* Allocation settings — a modal (mounted only while open so the focus trap engages). */}
      {showSettings && canWrite && (
        <Modal title={profile ? 'Allocation settings' : 'Set up allocation'} onClose={closeSettings} size="lg">
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="space-y-4">
            {/* div, not label — an InfoHint <button> inside a <label> would become the label's
                control (clicking the text would open the tooltip instead of focusing the field);
                the Select carries its own aria-label. */}
            <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                Pay shared costs from
                <InfoHint label="About the source account">
                  The account the allocated savings are transferred out of when you press “Allocate”. It
                  only affects the commit — the preview below is the same whichever account you pick.
                </InfoHint>
              </span>
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
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Pocket money (each)
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={pocket}
                placeholder="0.00"
                aria-label="Pocket money per member"
                onChange={(e) => setPocket(e.target.value)}
                className="w-40 text-right tabular-nums"
              />
            </label>
            <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                Split shared costs
                <InfoHint label="About splitting shared costs">
                  How much each person is treated as contributing to the shared costs and jars — split
                  Equally, or in proportion to income.
                </InfoHint>
              </span>
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
              <span className="inline-flex items-center gap-1.5">
                Send savings to
                <InfoHint label="About the savings split">
                  How the pooled leftover is divided into each person’s savings. <strong>Balance</strong>{' '}
                  leans toward whoever’s savings are lowest; <strong>Equally</strong> splits it evenly;{' '}
                  <strong>By income</strong> splits it in proportion to each person’s income.
                </InfoHint>
              </span>
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
              <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  Balance lean (0–100)
                  <InfoHint label="About balance lean">
                    How hard the split leans toward equalising savings. <strong>0</strong> is a plain even
                    split; <strong>100</strong> fills the lowest balance first. 25 is a gentle nudge.
                  </InfoHint>
                </span>
                <Input
                  type="text"
                  inputMode="numeric"
                  {...selectOnFocusProps}
                  value={lean}
                  placeholder="25"
                  aria-label="Balance lean percent"
                  onChange={(e) => setLean(e.target.value)}
                  className="w-24 text-right tabular-nums"
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={closeSettings} aria-label="Cancel settings">
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
