import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, Select, SegmentedControl } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { MembersIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { useFeatures } from '../features/FeatureContext'
import { useMonth } from '../features/MonthContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import {
  HouseholdRole,
  HOUSEHOLD_ROLE_HINTS,
  HOUSEHOLD_ROLE_LABELS,
  InviteMethod,
  MembershipStatus,
  PocketMoneyDecision,
  type AccountDto,
  type HouseholdMemberDto,
  type InviteResultDto,
  type MemberArchivePreviewDto,
  type MemberIncomeDto,
  type MemberIncomeResultDto,
  type MemberSpendingDto,
  type MembershipDto,
  type PocketMoneyMonthDto,
} from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { serverErrors } from '../lib/serverErrors'
import { accountOptionLabel, savingsFirst } from '../lib/accountOptions'
import { PRIVATE_ACCOUNT } from '../lib/accountHolders'
import { selectOnFocusProps } from '../lib/selectOnFocus'

/** The savings picker's value for a person's savings account that is private to another login (its id is never sent). */
const PRIVATE_SAVINGS = 'private'

/** Roles the owner can grant (everything except Owner itself). */
const GRANTABLE_ROLES = [HouseholdRole.Admin, HouseholdRole.Limited, HouseholdRole.ReadOnly]

/** "September 2026" in the visitor's locale, for the month a pocket-money line belongs to. */
function pocketMoneyMonthLabel(m: PocketMoneyMonthDto): string {
  return new Date(m.year, m.month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. */
function parseAmount(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

function sharePct(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** The hint shown wherever the saved default income is edited (rule 28: it is never calculated with). */
const DEFAULT_INCOME_HINT =
  'Becomes this person’s income line when you start a blank month. Calculations use the income lines in the month’s budget.'

/**
 * "+N need EUR amount": rows in another currency left out of a month figure because they still
 * wait for their amount in the budget currency (the app never converts on its own).
 */
function FxPendingHint({ count, what, currency }: { count: number; what: string; currency: string }) {
  if (count <= 0) return null
  return (
    <span
      title={`${count} ${what} ${count === 1 ? 'row is' : 'rows are'} in another currency, waiting for the amount in ${currency}, and not counted yet`}
      className="block text-[11px] font-normal text-amber-700 dark:text-amber-400"
    >
      +{count} need{count === 1 ? 's' : ''} {currency} amount
    </span>
  )
}

/** Up to two initials for a person's avatar (first + last word). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * The household's people in one place: each person's budget details (income, savings, share)
 * together with their sign-in and access level. Adding a person never requires an account —
 * inviting them to sign in is a separate, optional step on the same row. Budget edits need
 * Admin+ (canWrite); managing sign-ins/roles is owner-only (canManageHousehold).
 *
 * Every income, share and spending figure is the app-wide selected month's (rules 28/29): the
 * income comes from that month's budget lines, never from the saved per-person default, which
 * is only a helper for filling in a new budget.
 */
export function PeoplePage() {
  const { canWrite, canManageHousehold, budgetCurrency } = useAuth()
  const { refresh: refreshHousehold } = useHousehold()
  const features = useFeatures()
  const { year, month, label: monthLabel } = useMonth()
  const CURRENCY = budgetCurrency

  const [members, setMembers] = useState<HouseholdMemberDto[]>([])
  const [memberships, setMemberships] = useState<MembershipDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  // False when the accounts couldn't be read: an id not in the list then says nothing about privacy.
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [spending, setSpending] = useState<MemberSpendingDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  // Rule 54: the archive-preview of the person being archived, while this month's pocket money
  // still needs the keep-or-cancel answer (null = no question open).
  const [archivePreview, setArchivePreview] = useState<MemberArchivePreviewDto | null>(null)

  // Add-a-person form (in a modal).
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [income, setIncome] = useState('')
  const [savings, setSavings] = useState('')
  const [adding, setAdding] = useState(false)

  // Inline budget edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eName, setEName] = useState('')
  const [eIncome, setEIncome] = useState('')
  const [eSavings, setESavings] = useState('')

  // Invite form (owner-only). `invitePersonId` links the new login to a budget person.
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invitePersonId, setInvitePersonId] = useState('')
  const [iEmail, setIEmail] = useState('')
  const [iName, setIName] = useState('')
  const [iRole, setIRole] = useState<number>(HouseholdRole.Admin)
  const [iMethod, setIMethod] = useState<'direct' | 'link'>('link')
  const [iTempPassword, setITempPassword] = useState('')
  const [inviting, setInviting] = useState(false)
  const [monthIncome, setMonthIncome] = useState<MemberIncomeResultDto | null>(null)
  // Who was just invited and how: both kinds of invite are emailed to the invited address, never
  // shown here, so the owner can't open the invitee's login for them (S-P2-3, P59).
  const [invited, setInvited] = useState<{ email: string; method: 'direct' | 'link'; emailSent: boolean } | null>(null)

  const canAccess = features.householdAccess && canManageHousehold

  // The month on screen now. A save's reload reads this month, not the one the save started on,
  // and an answer for a month the user has since left is dropped (CL-P2-3): the new month's own
  // read fills the page.
  const viewedMonth = useRef({ year, month })
  useEffect(() => {
    viewedMonth.current = { year, month }
  }, [year, month])

  // Everything month-scoped is read for the selected month, so the page moves with the top
  // bar's month navigator together with Budget (rule 29).
  const reloadAll = useCallback(async () => {
    const shown = viewedMonth.current
    const { year, month } = shown
    const [m, acc, spend, mem, inc] = await Promise.all([
      api.get<HouseholdMemberDto[]>(`/members?year=${year}&month=${month}`),
      api.get<AccountDto[]>('/accounts').catch(() => ({ data: null })),
      api
        .get<MemberSpendingDto[]>(`/members/spending/${year}/${month}`)
        .catch(() => ({ data: [] as MemberSpendingDto[] })),
      api.get<MembershipDto[]>('/access/members').catch(() => ({ data: [] as MembershipDto[] })),
      // Per-person income for the month — attributed budget lines plus their share of the rest.
      api
        .get<MemberIncomeResultDto>(`/members/income/${year}/${month}`)
        .catch(() => ({ data: null as MemberIncomeResultDto | null })),
    ])
    if (viewedMonth.current !== shown) return
    setMembers(Array.isArray(m?.data) ? m.data : [])
    setAccounts(Array.isArray(acc?.data) ? acc.data : [])
    setAccountsLoaded(Array.isArray(acc?.data))
    setSpending(Array.isArray(spend?.data) ? spend.data : [])
    setMemberships(Array.isArray(mem?.data) ? mem.data : [])
    // Accept only a well-shaped payload — a failed/foreign response falls back to null (the
    // members' own month figures still carry the page), never a partial object.
    setMonthIncome(Array.isArray(inc?.data?.items) ? inc.data : null)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reloadAll()
      .catch(() => !cancelled && setError('Could not load your household.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [year, month, reloadAll])

  // The login (membership) linked to a given budget person, if any.
  const membershipByMember = useMemo(() => {
    const map = new Map<string, MembershipDto>()
    for (const m of memberships) if (m.memberId) map.set(m.memberId, m)
    return map
  }, [memberships])

  // Logins not tied to any budget person (so their access isn't hidden) — excluding the current
  // login, which is claimed via "This is me" on the rows below instead.
  const orphanLogins = useMemo(
    () => memberships.filter((m) => !m.memberId && !m.isSelf),
    [memberships],
  )

  // The current login, and whether it still needs connecting to a budget person (common for
  // imported/pre-existing households, where the owner login was never linked to a person).
  const myMembership = useMemo(() => memberships.find((m) => m.isSelf) ?? null, [memberships])
  const myUnlinked = myMembership !== null && !myMembership.memberId

  // Hero figures — the household's income in the selected month's budget (rule 28: the budget
  // lines, never the saved defaults), its headcount, and what the people spent in that month.
  const incomeByMember = useMemo(() => {
    const map = new Map<string, MemberIncomeDto>()
    for (const i of monthIncome?.items ?? []) map.set(i.memberId, i)
    return map
  }, [monthIncome])
  /** A member's income in the month's budget: attributed lines plus an equal share of the unattributed ones. */
  const memberBudgetIncome = useCallback(
    (m: HouseholdMemberDto): number => incomeByMember.get(m.id)?.income ?? m.budgetIncome ?? 0,
    [incomeByMember],
  )
  const monthIncomeMinor = useMemo(
    () => members.reduce((s, m) => s + fromAmount(memberBudgetIncome(m)), 0),
    [members, memberBudgetIncome],
  )
  // False only when the server says the month has no budget yet; absent flags read as "has one".
  const hasBudget = monthIncome?.hasBudget ?? members[0]?.hasBudget ?? true
  const incomeFxPending = monthIncome?.fxPendingCount ?? 0
  const sharedSpentMinor = useMemo(
    () => spending.reduce((s, sp) => s + fromAmount(sp.spent), 0),
    [spending],
  )

  function accountName(id: string | null): string {
    if (!id) return '—'
    // An id the viewer can't see is the person's own private account (W13, P53), once the
    // accounts have loaded (P3-5).
    return accounts.find((a) => a.id === id)?.name ?? (accountsLoaded ? PRIVATE_ACCOUNT : '—')
  }

  function memberSpending(id: string): MemberSpendingDto | undefined {
    return spending.find((s) => s.memberId === id)
  }

  const addMember = useCallback(async () => {
    if (name.trim() === '') {
      setError('Give the person a name.')
      return
    }
    const netMonthlyIncome = parseAmount(income)
    if (netMonthlyIncome === null) {
      setError('Enter a valid monthly income.')
      return
    }
    if (tooPrecise(income)) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    setAdding(true)
    setError(null)
    try {
      await api.post<HouseholdMemberDto>('/members', {
        name: name.trim(),
        netMonthlyIncome,
        personalSavingsAccountId: savings || null,
      })
      track(EVENTS.memberAdded)
      await reloadAll()
      await refreshHousehold() // adding a 2nd person flips solo → shared
      setName('')
      setIncome('')
      setSavings('')
      setShowAdd(false)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not add that person.')
    } finally {
      setAdding(false)
    }
  }, [name, income, savings, reloadAll, refreshHousehold])

  function startEdit(m: HouseholdMemberDto) {
    setEditingId(m.id)
    setEName(m.name)
    setEIncome(toEditString(fromAmount(m.netMonthlyIncome)))
    setESavings(m.savingsPrivate ? PRIVATE_SAVINGS : (m.personalSavingsAccountId ?? ''))
  }

  const saveEdit = useCallback(
    async (id: string) => {
      if (eName.trim() === '') {
        setError('Give the person a name.')
        return
      }
      const netMonthlyIncome = parseAmount(eIncome)
      if (netMonthlyIncome === null) {
        setError('Enter a valid monthly income.')
        return
      }
      // A typed amount is whole cents (D1); the saved one goes back as it is.
      const saved = members.find((m) => m.id === id)
      if (tooPrecise(eIncome, saved ? fromAmount(saved.netMonthlyIncome) : null)) {
        setError(TOO_MANY_DECIMALS)
        return
      }
      setSavingId(id)
      setError(null)
      try {
        await api.put<HouseholdMemberDto>(`/members/${id}`, {
          name: eName.trim(),
          netMonthlyIncome,
          // The server keeps a private savings account it was sent no id for (P53/P56).
          personalSavingsAccountId: eSavings === PRIVATE_SAVINGS ? null : eSavings || null,
        })
        track(EVENTS.memberEdited)
        await reloadAll()
        setEditingId(null)
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not save that person.')
      } finally {
        setSavingId(null)
      }
    },
    [eName, eIncome, eSavings, members, reloadAll],
  )

  /**
   * Rule 54: archiving stops the person's pocket money from next month on (the server cancels the
   * lines already planned in later months). When this month still has pocket money planned beyond
   * what was paid, the server needs the keep-or-cancel decision, sent as `pocketMoneyThisMonth`;
   * without one the request is the plain `{ archived: true }` it always was.
   */
  const commitArchive = useCallback(
    async (id: string, pocketMoneyThisMonth?: number) => {
      setSavingId(id)
      setError(null)
      try {
        await api.put(
          `/members/${id}/archive`,
          pocketMoneyThisMonth === undefined ? { archived: true } : { archived: true, pocketMoneyThisMonth },
        )
        setArchivePreview(null)
        await reloadAll()
        await refreshHousehold()
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not archive that person.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll, refreshHousehold],
  )

  // The ✕ still archives on the one click unless this month's pocket money needs the decision,
  // in which case it opens the question instead. If the preview cannot be read the archive goes
  // ahead and the server's own 400 (when a decision is needed) is shown.
  const archive = useCallback(
    async (id: string) => {
      setSavingId(id)
      setError(null)
      let preview: MemberArchivePreviewDto | null = null
      try {
        preview = (await api.get<MemberArchivePreviewDto>(`/members/${id}/archive-preview`)).data
      } catch {
        // Unreadable preview: archive anyway; the server's own 400 (a decision was needed) is shown.
      }
      if (preview?.thisMonth && preview.thisMonth.remaining > 0) {
        setSavingId(null)
        setArchivePreview(preview)
        return
      }
      await commitArchive(id)
    },
    [commitArchive],
  )

  function openInviteFor(personId: string) {
    setInvitePersonId(personId)
    setInviteOpen(true)
    setInvited(null)
    const person = members.find((p) => p.id === personId)
    setIName(person?.name ?? '')
    setIEmail('')
    setITempPassword('')
    setIMethod('link')
  }

  const invite = useCallback(async () => {
    if (iEmail.trim() === '') {
      setError('Enter an email address.')
      return
    }
    if (iMethod === 'direct' && iTempPassword.length < 8) {
      setError('Set a temporary password of at least 8 characters.')
      return
    }
    setInviting(true)
    setError(null)
    setInvited(null)
    try {
      const email = iEmail.trim()
      const { data } = await api.post<InviteResultDto>('/access/invite', {
        email,
        role: iRole,
        method: iMethod === 'direct' ? InviteMethod.Direct : InviteMethod.Link,
        tempPassword: iMethod === 'direct' ? iTempPassword : null,
        displayName: iName.trim() || null,
        memberId: invitePersonId || null,
      })
      setInvited({ email, method: iMethod, emailSent: data.emailSent !== false })
      track(EVENTS.memberInvited, { method: iMethod })
      await reloadAll()
      setIEmail('')
      setIName('')
      setITempPassword('')
    } catch (err) {
      setError(inviteError(err))
    } finally {
      setInviting(false)
    }
  }, [iEmail, iName, iRole, iMethod, iTempPassword, invitePersonId, reloadAll])

  const changeRole = useCallback(
    async (id: string, role: number) => {
      setSavingId(id)
      setError(null)
      try {
        await api.put(`/access/members/${id}/role`, { role })
        track(EVENTS.memberRoleChanged, { kind: HOUSEHOLD_ROLE_LABELS[role] ?? 'unknown' })
        await reloadAll()
      } catch {
        setError('Could not change that role.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  const revoke = useCallback(
    async (id: string) => {
      setSavingId(id)
      setError(null)
      try {
        await api.delete(`/access/members/${id}`)
        track(EVENTS.memberRevoked)
        await reloadAll()
      } catch {
        setError('Could not remove that sign-in.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  const linkLoginToPerson = useCallback(
    async (membershipId: string, memberId: string) => {
      setSavingId(membershipId)
      setError(null)
      try {
        await api.put(`/access/members/${membershipId}/link`, { memberId: memberId || null })
        await reloadAll()
      } catch (err) {
        setError(inviteError(err))
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  return (
    <AppShell active="people" title="People">
      <Hero
        eyebrow="Income this month"
        amount={formatMoney(monthIncomeMinor, CURRENCY)}
        amountLabel={`Income this month: ${formatMoney(monthIncomeMinor, CURRENCY)}`}
        footnote={
          !loading && !hasBudget ? (
            <p className="text-[13px] text-white/85">
              No budget for {monthLabel} yet.{' '}
              <Link to="/" className="font-semibold underline underline-offset-2 hover:text-white">
                Open the Dashboard
              </Link>
            </p>
          ) : incomeFxPending > 0 ? (
            <p className="text-[13px] text-white/85">
              +{incomeFxPending} income {incomeFxPending === 1 ? 'row' : 'rows'} in another currency, not counted
              until {incomeFxPending === 1 ? 'its' : 'their'} amount in {CURRENCY} is entered.
            </p>
          ) : undefined
        }
        tiles={[
          { label: 'People', value: `${members.length}` },
          { label: 'Shared this month', value: formatMoney(sharedSpentMinor, CURRENCY) },
        ]}
      />

      {error && !showAdd && !inviteOpen && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your household</h2>
            {canWrite && (
              <Button onClick={() => { setError(null); setShowAdd(true) }} aria-label="Add person">
                <span aria-hidden className="text-base leading-none">+</span> Add person
              </Button>
            )}
          </div>

          {members.length === 0 ? (
            <EmptyState
              icon={<MembersIcon className="h-6 w-6" />}
              title="Budgeting on your own?"
              description="You don’t need anyone else to use AllotJar. If you share money with a partner or housemate, add them here to split shared costs, divide savings, and give them their own sign-in."
            />
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-slate-500">
                      <th className="w-[27%] px-4 py-3 font-bold">Person</th>
                      <th className="w-[12%] px-4 py-3 text-right font-bold">Income</th>
                      <th className="w-[10%] px-4 py-3 text-right font-bold">Share</th>
                      <th className="w-[11%] px-4 py-3 text-right font-bold">Spent</th>
                      <th className="w-[16%] px-4 py-3 font-bold">Savings</th>
                      <th className="w-[24%] px-4 py-3 font-bold">Sign-in &amp; access</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {members.map((m) => {
                      const editing = editingId === m.id
                      const login = membershipByMember.get(m.id)
                      const isSelf = myMembership?.memberId === m.id
                      return (
                        <tr key={m.id} className="group align-middle hover:bg-slate-50">
                          <td className="px-4 py-4 font-medium text-slate-700">
                            {editing ? (
                              <input
                                type="text"
                                value={eName}
                                aria-label={`Name for ${m.name}`}
                                onChange={(e) => setEName(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                              />
                            ) : (
                              <div className="flex items-center gap-3">
                                <span
                                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white"
                                  aria-hidden
                                >
                                  {initials(m.name)}
                                </span>
                                <div className="min-w-0">
                                  <div className="truncate font-semibold text-slate-900">{m.name}</div>
                                  {isSelf && <div className="text-xs text-slate-500">You</div>}
                                </div>
                              </div>
                            )}
                          </td>
                      <td className="px-4 py-4 text-right font-medium tabular-nums text-slate-900">
                        {editing ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            {...selectOnFocusProps}
                            value={eIncome}
                            aria-label={`Default income for ${m.name}`}
                            title={DEFAULT_INCOME_HINT}
                            onChange={(e) => setEIncome(e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-right text-sm tabular-nums"
                          />
                        ) : (
                          <div>
                            {formatMoney(fromAmount(memberBudgetIncome(m)), CURRENCY)}
                            {/* The saved default is only a helper for a new budget; shown when it differs. */}
                            {fromAmount(m.netMonthlyIncome) !== 0 &&
                              fromAmount(memberBudgetIncome(m)) !== fromAmount(m.netMonthlyIncome) && (
                                <div className="text-xs font-normal text-slate-500">
                                  default {formatMoney(fromAmount(m.netMonthlyIncome), CURRENCY)}
                                </div>
                              )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums text-slate-500">{sharePct(m.incomeSharePct)}</td>
                      <td className="px-4 py-4 text-right tabular-nums text-slate-700">
                        {formatMoney(fromAmount(memberSpending(m.id)?.spent ?? 0), CURRENCY)}
                        <FxPendingHint count={memberSpending(m.id)?.fxPendingCount ?? 0} what="spending" currency={CURRENCY} />
                      </td>
                      <td className="px-4 py-4 text-slate-500">
                        {editing ? (
                          <select
                            value={eSavings}
                            aria-label={`Savings account for ${m.name}`}
                            onChange={(e) => setESavings(e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600"
                          >
                            {/* Only the login that holds a private savings account can clear it,
                                so "None" is not offered over it; another account can replace it. */}
                            {!m.savingsPrivate && <option value="">None</option>}
                            {eSavings && !accounts.some((a) => a.id === eSavings) && (
                              <option value={eSavings}>{PRIVATE_ACCOUNT}</option>
                            )}
                            {savingsFirst(accounts).map((a) => (
                              <option key={a.id} value={a.id}>
                                {accountOptionLabel(a)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          m.savingsPrivate ? PRIVATE_ACCOUNT : accountName(m.personalSavingsAccountId)
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            {login ? (
                              <div className="flex flex-col gap-1.5">
                                <span className="break-all text-[13px] font-medium text-brand-700 dark:text-brand-200">{login.email}</span>
                                <div className="flex flex-wrap items-center gap-2">
                                  {login.status === MembershipStatus.Invited && <Badge tone="amber">Invited</Badge>}
                                  {canAccess && !login.isOwner && !login.isSelf ? (
                                    <select
                                      value={String(login.role)}
                                      aria-label={`Access level for ${m.name}`}
                                      disabled={savingId === login.id}
                                      onChange={(e) => changeRole(login.id, Number(e.target.value))}
                                      className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600"
                                    >
                                      {GRANTABLE_ROLES.map((r) => (
                                        <option key={r} value={r}>
                                          {HOUSEHOLD_ROLE_LABELS[r]}
                                        </option>
                                      ))}
                                    </select>
                                  ) : login.isOwner ? (
                                    <Badge tone="brand">{HOUSEHOLD_ROLE_LABELS[login.role]}</Badge>
                                  ) : (
                                    <span className="inline-flex items-center rounded-full border border-slate-300 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                      {HOUSEHOLD_ROLE_LABELS[login.role]}
                                    </span>
                                  )}
                                  {canAccess && !login.isOwner && !login.isSelf && (
                                    <button
                                      type="button"
                                      onClick={() => revoke(login.id)}
                                      disabled={savingId === login.id}
                                      aria-label={`Remove sign-in for ${m.name}`}
                                      className="rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </div>
                            ) : canAccess ? (
                              <div className="flex flex-wrap items-center gap-2">
                                {myUnlinked && (
                                  <button
                                    type="button"
                                    onClick={() => myMembership && linkLoginToPerson(myMembership.id, m.id)}
                                    disabled={savingId === myMembership?.id}
                                    title="Connect your sign-in to this person"
                                    className="rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                                  >
                                    This is me
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openInviteFor(m.id)}
                                  className="rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-slate-400 hover:text-slate-700"
                                >
                                  Invite to sign in
                                </button>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-500">No sign-in</span>
                            )}
                          </div>

                          {/* Row edit / delete — revealed on hover (Save / Cancel while editing). */}
                          {canWrite && (
                            <div className={`shrink-0 items-center gap-1 ${editing ? 'flex' : 'hidden group-hover:flex'}`}>
                              {editing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => saveEdit(m.id)}
                                    disabled={savingId === m.id}
                                    aria-label={`Save ${m.name}`}
                                    className="rounded-md bg-brand-600 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingId(null)}
                                    aria-label="Cancel edit"
                                    className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startEdit(m)}
                                    aria-label={`Edit ${m.name}`}
                                    title="Edit person"
                                    className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                  >
                                    ✎
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => archive(m.id)}
                                    disabled={savingId === m.id}
                                    aria-label={`Archive ${m.name}`}
                                    title="Archive person"
                                    className="rounded-md px-2 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                                  >
                                    ✕
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </section>
      )}

      {/* Rule 54: archiving with pocket money still planned this month — keep it or cancel what remains. */}
      {archivePreview?.thisMonth && (
        <Modal title={`Archive ${archivePreview.name}`} onClose={() => setArchivePreview(null)}>
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <p className="text-sm text-slate-700">
            {archivePreview.name} still has{' '}
            <strong>{formatMoney(fromAmount(archivePreview.thisMonth.remaining), CURRENCY)}</strong> of pocket money
            planned for {pocketMoneyMonthLabel(archivePreview.thisMonth)}
            {archivePreview.thisMonth.paid > 0
              ? ` (${formatMoney(fromAmount(archivePreview.thisMonth.paid), CURRENCY)} already paid)`
              : ''}
            .
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Keep it for this month, or cancel what remains? Either way {archivePreview.name}’s payments stay recorded
            {archivePreview.futureMonths.length === 0
              ? ', and no pocket money is planned from next month on.'
              : archivePreview.futureMonths.length === 1
                ? `, and the pocket money already planned for ${pocketMoneyMonthLabel(archivePreview.futureMonths[0])} is cancelled.`
                : `, and the pocket money already planned for ${archivePreview.futureMonths.length} later months is cancelled.`}
          </p>
          {archivePreview.thisMonth.waitingForConvertedAmount && (
            <p className="mt-2 text-sm text-slate-600">
              A payment this month is waiting for its converted amount, so its line keeps its plan until the amount is
              confirmed.
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setArchivePreview(null)}
              disabled={savingId === archivePreview.id}
              aria-label="Don’t archive"
            >
              Don’t archive
            </Button>
            <Button
              variant="secondary"
              onClick={() => commitArchive(archivePreview.id, PocketMoneyDecision.Cancel)}
              disabled={savingId === archivePreview.id}
              aria-label="Cancel remaining pocket money and archive"
            >
              Cancel remaining
            </Button>
            <Button
              onClick={() => commitArchive(archivePreview.id, PocketMoneyDecision.Keep)}
              disabled={savingId === archivePreview.id}
              aria-label="Keep this month’s pocket money and archive"
            >
              Keep this month
            </Button>
          </div>
        </Modal>
      )}

      {/* Add a person — a modal (mounted only while open so the focus trap engages). */}
      {showAdd && canWrite && (
        <Modal title="Add a person" onClose={() => setShowAdd(false)}>
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Name
              <Input
                type="text"
                value={name}
                placeholder="First name"
                aria-label="Person name"
                onChange={(e) => setName(e.target.value)}
                className="w-full"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Default income
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={income}
                placeholder="0.00"
                aria-label="Default income"
                onChange={(e) => setIncome(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addMember()
                }}
                className="w-full text-right tabular-nums"
              />
              <span className="font-normal text-slate-500">{DEFAULT_INCOME_HINT}</span>
            </label>
            {accounts.length > 0 && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Savings account
                <Select value={savings} aria-label="Savings account" onChange={(e) => setSavings(e.target.value)} className="w-full">
                  <option value="">None</option>
                  {savingsFirst(accounts).map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountOptionLabel(a)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setShowAdd(false)} aria-label="Cancel add person">
                Cancel
              </Button>
              <Button onClick={addMember} disabled={adding} aria-label="Add person">
                Add person
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Invite form — opened from a person's "Invite to sign in", owner-only. */}
      {canAccess && inviteOpen && (
        <Modal
          title={`Invite ${members.find((p) => p.id === invitePersonId)?.name ?? 'someone'} to sign in`}
          onClose={() => setInviteOpen(false)}
          size="lg"
        >
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Email
              <Input
                type="email"
                value={iEmail}
                onChange={(e) => setIEmail(e.target.value)}
                placeholder="sam@example.eu"
                aria-label="Invitee email"
                className="w-full"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Access level
              <Select
                value={String(iRole)}
                onChange={(e) => setIRole(Number(e.target.value))}
                aria-label="Access level"
                className="w-full"
              >
                {GRANTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {HOUSEHOLD_ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
              <span className="text-xs font-normal text-slate-500">{HOUSEHOLD_ROLE_HINTS[iRole]}</span>
            </label>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-slate-500">How should they get access?</div>
            <SegmentedControl
              ariaLabel="Invite method"
              value={iMethod}
              onChange={setIMethod}
              options={[
                { value: 'link', label: 'Email an invite link' },
                { value: 'direct', label: 'Set a temporary password' },
              ]}
            />
          </div>

          {iMethod === 'direct' ? (
            <label className="mt-4 flex max-w-xs flex-col gap-1 text-xs font-medium text-slate-500">
              Temporary password
              <Input
                type="text"
                value={iTempPassword}
                onChange={(e) => setITempPassword(e.target.value)}
                placeholder="At least 8 characters"
                aria-label="Temporary password"
                className="w-full"
              />
              <span className="font-normal text-slate-500">Only works for someone without an account yet.</span>
            </label>
          ) : (
            <p className="mt-4 max-w-md text-xs text-slate-500">
              We email them a one-time link. If they already have an account, they accept it while signed in;
              otherwise they set their own password when they open it.
            </p>
          )}

          <div className="mt-5">
            <Button onClick={invite} disabled={inviting}>
              {inviting ? 'Inviting…' : iMethod === 'direct' ? 'Create login' : 'Send invite'}
            </Button>
          </div>

          {invited && invited.emailSent && (
            <div
              role="status"
              className="mt-4 rounded-lg border border-brand-200 bg-brand-50 p-4 dark:border-brand-500/30 dark:bg-brand-500/10"
            >
              <p className="text-sm font-medium text-brand-800 dark:text-brand-200">
                {invited.method === 'direct' ? 'Login created' : 'Invite sent'}
              </p>
              <p className="mt-1 text-xs text-brand-700/80 dark:text-brand-200/80">
                {invited.method === 'direct' ? (
                  <>
                    We've emailed <span className="font-medium">{invited.email}</span> a link to choose their own
                    password. Until they do, the temporary password you set only lets them sign in to see that
                    prompt.
                  </>
                ) : (
                  <>
                    We've emailed <span className="font-medium">{invited.email}</span> a one-time link. It expires
                    in 7 days.
                  </>
                )}
              </p>
            </div>
          )}

          {invited && !invited.emailSent && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10"
            >
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {invited.method === 'direct' ? 'Login created, but the email failed' : 'Invite saved, but the email failed'}
              </p>
              <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">
                {invited.method === 'direct' ? (
                  <>
                    We couldn't email <span className="font-medium">{invited.email}</span> their link. When they sign
                    in with the temporary password, they can ask for it again with "Email me the link again".
                  </>
                ) : (
                  <>
                    We couldn't email <span className="font-medium">{invited.email}</span> their link. Remove the
                    invite and send it again later.
                  </>
                )}
              </p>
            </div>
          )}
        </Modal>
      )}

      {/* Sign-ins not tied to a budget person — so their access is never hidden. */}
      {canAccess && orphanLogins.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Other sign-ins
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {orphanLogins.map((login) => (
                  <tr key={login.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-700">{login.displayName ?? login.email}</div>
                      {login.displayName && <div className="text-xs text-slate-500">{login.email}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      {login.status === MembershipStatus.Invited ? <Badge tone="amber">Invited</Badge> : <Badge tone="brand">Active</Badge>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={login.isOwner ? 'brand' : 'neutral'}>{HOUSEHOLD_ROLE_LABELS[login.role]}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {!login.isOwner && (
                        <select
                          value=""
                          aria-label={`Link ${login.email} to a person`}
                          disabled={savingId === login.id}
                          onChange={(e) => e.target.value && linkLoginToPerson(login.id, e.target.value)}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600"
                        >
                          <option value="">Link to a person…</option>
                          {members
                            .filter((p) => !membershipByMember.has(p.id))
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!login.isOwner && !login.isSelf && (
                        <button
                          type="button"
                          onClick={() => revoke(login.id)}
                          disabled={savingId === login.id}
                          aria-label={`Remove ${login.displayName ?? login.email}`}
                          className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </AppShell>
  )
}

function inviteError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { title?: string; error?: string; errors?: Record<string, string[]> } | undefined
    const fieldError = data?.errors ? Object.values(data.errors).flat().join(' ') : undefined
    return fieldError ?? data?.error ?? data?.title ?? 'Could not complete that request.'
  }
  return 'Could not complete that request.'
}
