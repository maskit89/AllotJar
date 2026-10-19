import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import axios from 'axios'
import { Link } from 'react-router-dom'
import { Archive, ArrowUpRight, Ellipsis, Mail, Pencil, Trash2, User, UserPlus, UserX } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, EmptyState, ErrorBanner, Input, Select, SegmentedControl } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { InfoHint } from '../components/InfoHint'
import { Notice } from '../components/Notice'
import { StatusChip } from '../components/StatusChip'
import { MemberAvatar } from '../components/MemberAvatar'
import { ActionSheet, ROW_MENU_TRIGGER, RowMenu, type RowAction } from '../components/RowActions'
import { CARD_TITLE, DASH_CARD, TITLE_HINT } from '../components/budget/card'
import { Modal } from '../components/Modal'
import { MembersIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { useFeatures } from '../features/FeatureContext'
import { useMonth } from '../features/MonthContext'
import { api } from '../lib/api'
import { useMediaQuery } from '../lib/useMediaQuery'
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
  type ResendResultDto,
  type PocketMoneyMonthDto,
} from '../types'
import { currencySymbol, formatMoney, fromAmount, parseMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { editConflict, serverErrors } from '../lib/serverErrors'
import { accountOptionLabel, savingsFirst } from '../lib/accountOptions'
import { PRIVATE_ACCOUNT } from '../lib/accountHolders'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { hueColor, memberHue, type CategoryHue } from '../lib/categoryColors'

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

/** What the (i) on a person's share says. */
const SHARE_HINT = 'Their part of this month’s income.'

/**
 * What the (i) after "Other sign-ins" says. The menu is named in words, as its button is ("…: more
 * actions"), so a screen reader or voice control can find it; the glyph is only for the eye.
 */
const SIGN_INS_HINT = 'Sign-ins not linked to a person yet. Link one from its More actions menu (⋯).'

/** What the (i) beside the editor's sign-in controls says: they act at once, not on Save. */
const SIGN_IN_HINT =
  'A new access level applies as soon as you pick it, and Remove sign-in takes it away at once. Save and Cancel don’t change either.'

/** The inline editor's small captions (the fields carry their full names for assistive tech). */
const CAPTION = 'text-xs font-medium text-slate-500'
/** A 40px target for a finger (a phone, or any screen without hover), 36px for a pointer. */
const TOUCH_H = 'max-[699.98px]:h-10 [@media(hover:none)]:h-10'
const FIELD = `h-9 w-full py-1.5 focus-visible:outline-none! ${TOUCH_H}`

/**
 * An (i) inside a card: above the next card while its popover is open (the popover can reach it).
 * Its text wraps, whatever the line it sits in.
 */
const HINT_WRAP = 'whitespace-normal has-[[role=tooltip]]:z-10'

/** The small (i) on a person's share plate: 20px, the icon at 13px, a 40px target. */
const PLATE_HINT =
  "relative inline-grid size-5 place-items-center rounded-full opacity-85 transition after:absolute after:-inset-2.5 after:content-[''] hover:bg-slate-500/10 hover:opacity-100 [&_svg]:size-[13px]!"

/** The page's quiet Add person button: in the top bar on a desktop, a pill under the KPI row below 900px. */
const ADD_BUTTON =
  'h-[38px] gap-[7px] rounded-[10px] border-slate-200 py-0 text-slate-900 shadow-[var(--shadow-frame)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:hover:bg-foreground/7'

/** Where focus goes once a card's controls have closed or a card or row has gone (see `pendingFocus`). */
interface FocusTarget {
  /** What to focus (looked up when the time comes). */
  find: () => HTMLElement | null
  /** Only when focus has fallen to the page (a save that ends after the user moved on leaves focus alone). */
  ifLost: boolean
  /** Wait until this element (a card or row being removed) has left the page. */
  gone?: () => HTMLElement | null
}

/** The card of the person `id`, the row of the sign-in `id`, and that row's ⋯ (looked up when needed). */
const personCard = (id: string) => () => document.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(id)}"]`)
/** A control of the open editor in the card of the person `id`, by its data attribute. */
const inEditor = (id: string, attr: string) => () =>
  document.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(id)}"] [data-person-editor] [${attr}]`)
const personSave = (id: string) => inEditor(id, 'data-person-save')
const signInRow = (id: string) => () => document.querySelector<HTMLElement>(`[data-sign-in-id="${CSS.escape(id)}"]`)
const signInTrigger = (id: string) => () =>
  document.querySelector<HTMLElement>(`[data-sign-in-id="${CSS.escape(id)}"] [data-row-trigger]`)
/**
 * A card's ⋯ or, once it has nothing left to offer, the (i) in its place: where focus stays after
 * an action that can take the last item away (This isn't me, for a read-only login).
 */
const personMenuOrHint = (id: string) => () =>
  document.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(id)}"] [data-row-trigger], [data-person-id="${CSS.escape(id)}"] [data-person-hint] button`)

/**
 * The People page (restyle PR 8, the approved "polished Warm" mock-up): one KPI row (the
 * household's income this month, the gold hero, and what the people spent), then one card per
 * person: their avatar inside a ring that fills to their share of the month's income, their name,
 * whether they are you, their access level and an invite still pending, and under a hairline their
 * income, spending and the account they save to. The rarely used actions (This is me, This isn't
 * me, Invite to sign in, Send again, Edit, Archive) sit behind each card's ⋯ (a bottom sheet on
 * phones), whose note says who the person signs in as. Below the cards, the owner sees the
 * sign-ins not linked to a person, each with its own ⋯.
 *
 * Every income, share and spending figure is the app-wide selected month's (rules 28/29): the
 * income comes from that month's budget lines, never from the saved per-person default, which
 * is only a helper for filling in a new budget. Budget edits need Admin+ (canWrite); managing
 * sign-ins and roles is owner-only (canManageHousehold).
 */
export function PeoplePage() {
  const { canWrite, canManageHousehold, budgetCurrency } = useAuth()
  const { refresh: refreshHousehold } = useHousehold()
  const features = useFeatures()
  const { year, month, label: monthLabel } = useMonth()
  const CURRENCY = budgetCurrency
  // The top bar has room for Add person from 900px (AppShell's own breakpoint); below it the
  // button sits under the KPI row, as in the mock-up.
  const desktop = useMediaQuery('(min-width: 900px)')
  // Phones: a card's ⋯ opens a bottom sheet.
  const phone = useMediaQuery('(max-width: 699.98px)')

  const [members, setMembers] = useState<HouseholdMemberDto[]>([])
  const [memberships, setMemberships] = useState<MembershipDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  // False when the accounts couldn't be read: an id not in the list then says nothing about privacy.
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [spending, setSpending] = useState<MemberSpendingDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The household couldn't be read: the page says so and nothing else (no "on your own" empty state).
  const [loadFailed, setLoadFailed] = useState(false)
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

  // Inline (in-card) budget edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eName, setEName] = useState('')
  const [eIncome, setEIncome] = useState('')
  const [eSavings, setESavings] = useState('')
  // The version the edit was loaded from, sent back with the save (D11).
  const [eVersion, setEVersion] = useState<string | null>(null)

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
  // "Send again" (D7): the sign-in whose email just went out again, or failed to.
  const [resent, setResent] = useState<{ id: string; emailSent: boolean } | null>(null)
  // The sign-in (not linked to a person) whose "Link to a person" picker is open.
  const [linkingId, setLinkingId] = useState<string | null>(null)

  const gridHeadingId = useId()
  const signInsHeadingId = useId()
  const addButtonId = useId()
  const inviteSubmitId = useId()
  // Where focus goes once the editor, a dialog, a picker or a removal has closed a card's or a
  // row's controls (see FocusTarget).
  const [pendingFocus, setPendingFocus] = useState<FocusTarget | null>(null)

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
    if (viewedMonth.current !== shown) return null
    setLoadFailed(false)
    setMembers(Array.isArray(m?.data) ? m.data : [])
    setAccounts(Array.isArray(acc?.data) ? acc.data : [])
    setAccountsLoaded(Array.isArray(acc?.data))
    setSpending(Array.isArray(spend?.data) ? spend.data : [])
    setMemberships(Array.isArray(mem?.data) ? mem.data : [])
    // Accept only a well-shaped payload — a failed/foreign response falls back to null (the
    // members' own month figures still carry the page), never a partial object.
    setMonthIncome(Array.isArray(inc?.data?.items) ? inc.data : null)
    return Array.isArray(m?.data) ? m.data : null
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reloadAll()
      .catch(() => {
        if (cancelled) return
        setLoadFailed(true)
        setError('Could not load your household.')
      })
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
  // login, which is claimed via "This is me" on a person's ⋯ instead.
  const orphanLogins = useMemo(
    () => memberships.filter((m) => !m.memberId && !m.isSelf),
    [memberships],
  )

  // The current login, and whether it still needs connecting to a budget person (common for
  // imported/pre-existing households, where the owner login was never linked to a person).
  const myMembership = useMemo(() => memberships.find((m) => m.isSelf) ?? null, [memberships])
  const myUnlinked = myMembership !== null && !myMembership.memberId

  // KPI figures — the household's income in the selected month's budget (rule 28: the budget
  // lines, never the saved defaults) and what the people spent in that month.
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

  /** The savings account's name; null when the person has none, '' when it can't be told (the accounts didn't load). */
  function accountName(id: string | null): string | null {
    if (!id) return null
    // An id the viewer can't see is the person's own private account (W13, P53), once the
    // accounts have loaded (P3-5).
    return accounts.find((a) => a.id === id)?.name ?? (accountsLoaded ? PRIVATE_ACCOUNT : '')
  }

  function memberSpending(id: string): MemberSpendingDto | undefined {
    return spending.find((s) => s.memberId === id)
  }

  /** The ⋯ of the person card `id` (or, for null, the Add person button). */
  const personTrigger = useCallback(
    (id: string | null) => () =>
      (id === null
        ? document.getElementById(addButtonId)
        : document.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(id)}"] [data-row-trigger]`)) ?? null,
    [addButtonId],
  )

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

  const startEdit = useCallback((m: HouseholdMemberDto) => {
    setEditingId(m.id)
    setEName(m.name)
    setEIncome(toEditString(fromAmount(m.netMonthlyIncome)))
    setESavings(m.savingsPrivate ? PRIVATE_SAVINGS : (m.personalSavingsAccountId ?? ''))
    setEVersion(m.version ?? null)
  }, [])

  /** Close the editor from its Cancel (or Escape): focus back to the card's ⋯. */
  const cancelEdit = useCallback(
    (id: string) => {
      setPendingFocus({ find: personTrigger(id), ifLost: false })
      setEditingId(null)
    },
    [personTrigger],
  )

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
          version: eVersion,
        })
        track(EVENTS.memberEdited)
        await reloadAll()
        setPendingFocus({ find: personTrigger(id), ifLost: true })
        setEditingId(null)
      } catch (err) {
        const conflict = editConflict(err)
        if (conflict) {
          // Someone else saved this person first (D11): show what they saved in the open form.
          const fresh = (await reloadAll().catch(() => null))?.find((m) => m.id === id)
          if (fresh) startEdit(fresh)
          else setEditingId(null)
          setError(conflict)
        } else {
          setError(serverErrors(err) ?? 'Could not save that person.')
        }
        // Save was disabled while it ran, which dropped the focus: back to it, in the open editor.
        setPendingFocus({ find: personSave(id), ifLost: true })
      } finally {
        setSavingId(null)
      }
    },
    [eName, eIncome, eSavings, eVersion, members, reloadAll, startEdit, personTrigger],
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
        // Once the card has gone, focus moves on to the card that takes its place (or the one
        // before it), else the Add person button.
        const at = members.findIndex((m) => m.id === id)
        const next = at < 0 ? undefined : (members[at + 1] ?? members[at - 1])
        setPendingFocus({ find: personTrigger(next?.id ?? null), ifLost: true, gone: personCard(id) })
        setArchivePreview(null)
        await reloadAll()
        await refreshHousehold()
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not archive that person.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll, refreshHousehold, members, personTrigger],
  )

  // Archive still archives on the one choice unless this month's pocket money needs the decision,
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
      // The button was disabled while the invite ran, which dropped the focus out of the dialog
      // (Escape and Tab then did nothing): back to it, so the result reads next.
      setPendingFocus({ find: () => document.getElementById(inviteSubmitId), ifLost: true })
    }
  }, [iEmail, iName, iRole, iMethod, iTempPassword, invitePersonId, reloadAll, inviteSubmitId])

  const changeRole = useCallback(
    async (id: string, role: number, focusAfter?: FocusTarget) => {
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
        // The select was disabled while it saved, which dropped the focus: back to it.
        if (focusAfter) setPendingFocus(focusAfter)
      }
    },
    [reloadAll],
  )

  const revoke = useCallback(
    async (id: string, focusAfter?: FocusTarget) => {
      setSavingId(id)
      setError(null)
      try {
        await api.delete(`/access/members/${id}`)
        track(EVENTS.memberRevoked)
        if (focusAfter) setPendingFocus(focusAfter)
        await reloadAll()
      } catch {
        setError('Could not remove that sign-in.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  // "Send again" for a pending invite (a fresh link; the earlier one stops working) or a login
  // still waiting to choose its password (its link again). The server spaces sends a minute apart.
  const resend = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    setResent(null)
    try {
      const { data } = await api.post<ResendResultDto>(`/access/members/${id}/resend`)
      setResent({ id, emailSent: data?.emailSent !== false })
    } catch (err) {
      setError(inviteError(err))
    } finally {
      setSavingId(null)
    }
  }, [])

  // D5: "This isn't me" — releases this sign-in's own earlier link to the person, so it no
  // longer stops the person's own sign-in making their accounts private. Never anyone else's link.
  const releaseMyLink = useCallback(
    async (memberId: string) => {
      setSavingId(memberId)
      setError(null)
      try {
        await api.post(`/access/people/${memberId}/not-me`)
        await reloadAll()
        // A read-only login's ⋯ goes with its last item: focus stays on the card's (i).
        setPendingFocus({ find: personMenuOrHint(memberId), ifLost: true })
      } catch (err) {
        setError(serverErrors(err) ?? 'Could not save that.')
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  const linkLoginToPerson = useCallback(
    async (membershipId: string, memberId: string, focusAfter?: FocusTarget) => {
      setSavingId(membershipId)
      setError(null)
      try {
        await api.put(`/access/members/${membershipId}/link`, { memberId: memberId || null })
        if (focusAfter) setPendingFocus(focusAfter)
        setLinkingId(null)
        await reloadAll()
      } catch (err) {
        setError(inviteError(err))
      } finally {
        setSavingId(null)
      }
    },
    [reloadAll],
  )

  /** Close a sign-in's link picker without linking: focus back to the row's ⋯. */
  const closeLinkPicker = useCallback((id: string) => {
    setPendingFocus({ find: signInTrigger(id), ifLost: false })
    setLinkingId(null)
  }, [])

  // Focus back to a card's ⋯ once its editor has closed, into the editor after a sign-in it showed
  // was removed, or on to the next card or row after one has gone (see FocusTarget). Runs after a
  // dialog's own clean-up (an update effect runs after an unmount's), and waits while the archive
  // question is open.
  useEffect(() => {
    const target = pendingFocus
    if (!target || archivePreview) return
    if (target.gone?.()) return
    setPendingFocus(null)
    const active = document.activeElement
    if (target.ifLost && active && active !== document.body && active.isConnected) return
    target.find()?.focus()
  }, [pendingFocus, members, memberships, editingId, archivePreview, linkingId])

  const money = (minor: number) => formatMoney(minor, CURRENCY)

  const incomeHint = (
    <>
      The income lines in {monthLabel}’s budget: each person’s own lines, plus an equal share of the lines that name no one. A
      person’s default income only fills in a blank new month.
      {incomeFxPending > 0 && <> Income rows in another currency aren’t counted until their amount in {CURRENCY} is entered.</>}
    </>
  )
  const spentHint = (
    <>
      What each person spent in {monthLabel}: spending marked for them, or their part of a split, less their refunds. Spending
      marked for no one isn’t counted, nor are payments still waiting for their {CURRENCY} amount, nor money in a private account
      that isn’t on a budget line.
    </>
  )
  // The hero's one line: the month has no budget yet (with the way to start one), or income rows in
  // another currency are waiting for their amount.
  const incomeSub =
    !hasBudget ? (
      <span>
        No budget for {monthLabel} yet.{' '}
        <Link to="/" className="font-semibold text-white underline underline-offset-2 hover:text-white">
          Open the Dashboard
        </Link>
      </span>
    ) : incomeFxPending > 0 ? (
      // One short line, in the "€ amount" words of the fill-in chips elsewhere; the (i) says why.
      <span>
        +{incomeFxPending} income {incomeFxPending === 1 ? 'row needs its' : 'rows need their'} {currencySymbol(CURRENCY)} amount
        {incomeFxPending === 1 ? '' : 's'}
      </span>
    ) : undefined

  // A rarely used action: quiet (an outline), as Accounts' Add account.
  const addButton =
    canWrite && !loading ? (
      <Button
        id={addButtonId}
        variant="secondary"
        onClick={() => {
          setError(null)
          setShowAdd(true)
        }}
        aria-label="Add person"
        className={ADD_BUTTON}
      >
        <UserPlus aria-hidden strokeWidth={1.8} className="size-4" />
        Add person
      </Button>
    ) : null

  /** Which of a person's actions to offer, each only where it applies (the card builds its ⋯ list from this). */
  function offersFor(m: HouseholdMemberDto, login: MembershipDto | undefined): PersonOffers {
    return {
      // Your own sign-in isn't linked to anyone yet: say which person you are.
      me: canAccess && myUnlinked && !login && myMembership ? { disabled: savingId === myMembership.id } : null,
      // D5: any role may release its own earlier link to this person.
      notMe: m.canReleaseMyLink ? { disabled: savingId === m.id } : null,
      invite: canAccess && !login,
      resend: canAccess && login && canSendAgain(login) ? { disabled: savingId === login.id } : null,
      write: canWrite ? { busy: savingId === m.id } : null,
    }
  }

  function onPersonAction(m: HouseholdMemberDto, login: MembershipDto | undefined, kind: PersonActionKind) {
    switch (kind) {
      case 'me':
        if (myMembership) void linkLoginToPerson(myMembership.id, m.id)
        return
      case 'not-me':
        void releaseMyLink(m.id)
        return
      case 'invite':
        openInviteFor(m.id)
        return
      case 'resend':
        if (login) void resend(login.id)
        return
      case 'edit':
        startEdit(m)
        return
      case 'archive':
        void archive(m.id)
        return
    }
  }

  function editorFor(m: HouseholdMemberDto, login: MembershipDto | undefined) {
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      cancelEdit(m.id)
    }
    const manage = !!login && canAccess && !login.isOwner && !login.isSelf
    return (
      <div data-person-editor="" className="flex flex-col gap-3 border-t border-line pt-4" onKeyDown={onKeyDown}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <div className="col-span-2 flex flex-col gap-1">
            <span aria-hidden className={CAPTION}>
              Name
            </span>
            <Input type="text" autoFocus value={eName} aria-label={`Name for ${m.name}`} onChange={(e) => setEName(e.target.value)} className={FIELD} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            {/* Both captions in the same 16px row (the (i) overhangs it), so the two fields line up. */}
            <span className="flex h-4 items-center gap-1">
              <span aria-hidden className={CAPTION}>
                Default income
              </span>
              <InfoHint label="About the default income" buttonClassName={TITLE_HINT} className={HINT_WRAP}>
                {DEFAULT_INCOME_HINT}
              </InfoHint>
            </span>
            <Input
              type="text"
              inputMode="decimal"
              {...selectOnFocusProps}
              value={eIncome}
              aria-label={`Default income for ${m.name}`}
              onChange={(e) => setEIncome(e.target.value)}
              className={`${FIELD} text-right tabular-nums`}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className={`flex h-4 items-center ${CAPTION}`}>
              Savings account
            </span>
            <Select value={eSavings} aria-label={`Savings account for ${m.name}`} onChange={(e) => setESavings(e.target.value)} className={FIELD}>
              {/* Only the login that holds a private savings account can clear it, so "None" is
                  not offered over it; another account can replace it. */}
              {!m.savingsPrivate && <option value="">None</option>}
              {eSavings && !accounts.some((a) => a.id === eSavings) && <option value={eSavings}>{PRIVATE_ACCOUNT}</option>}
              {savingsFirst(accounts).map((a) => (
                <option key={a.id} value={a.id}>
                  {accountOptionLabel(a)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {login && (
          // The sign-in: who it signs in as and, for the owner, its access level and Remove, which
          // act at once (as before the restyle), not on Save.
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 px-3 py-2.5 dark:bg-foreground/5">
            <p className="flex min-w-0 items-center gap-1 text-[13px] text-slate-500">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                Signs in as <span className="font-semibold text-slate-700">{login.email}</span>
              </span>
              {manage && (
                <InfoHint label="About the sign-in controls" buttonClassName={TITLE_HINT} align="end" className={`shrink-0 ${HINT_WRAP}`}>
                  {SIGN_IN_HINT}
                </InfoHint>
              )}
            </p>
            {manage && (
              <div className="flex flex-wrap items-end gap-x-2 gap-y-2.5">
                <span className="flex flex-col gap-1">
                  <span aria-hidden className={CAPTION}>
                    Access level
                  </span>
                  <Select
                    data-access-level=""
                    value={String(login.role)}
                    aria-label={`Access level for ${m.name}`}
                    disabled={savingId === login.id}
                    onChange={(e) => changeRole(login.id, Number(e.target.value), { find: inEditor(m.id, 'data-access-level'), ifLost: true })}
                    className={`h-9 py-1.5 focus-visible:outline-none! ${TOUCH_H}`}
                  >
                    {GRANTABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {HOUSEHOLD_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    revoke(login.id, {
                      // The sign-in controls go: focus back to the editor's first field.
                      find: () => document.querySelector<HTMLElement>(`[data-person-id="${CSS.escape(m.id)}"] [data-person-editor] input`),
                      ifLost: true,
                    })
                  }
                  disabled={savingId === login.id}
                  aria-label={`Remove sign-in for ${m.name}`}
                  className={`h-9 text-bad! hover:bg-bad-bg! hover:text-bad! ${TOUCH_H}`}
                >
                  <Trash2 aria-hidden strokeWidth={1.8} className="size-4" />
                  Remove sign-in
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => cancelEdit(m.id)} aria-label="Cancel edit" className={`h-9 ${TOUCH_H}`}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-person-save=""
            onClick={() => saveEdit(m.id)}
            disabled={savingId === m.id}
            aria-label={`Save ${m.name}`}
            className={`h-9 ${TOUCH_H}`}
          >
            Save
          </Button>
        </div>
      </div>
    )
  }

  function onSignInAction(login: MembershipDto, kind: SignInActionKind) {
    switch (kind) {
      case 'resend':
        void resend(login.id)
        return
      case 'link':
        setLinkingId(login.id)
        return
      case 'remove': {
        // Once the row has gone, focus moves on to the row that takes its place (or the one
        // before it), else the Add person button.
        const at = orphanLogins.findIndex((o) => o.id === login.id)
        const next = at < 0 ? undefined : (orphanLogins[at + 1] ?? orphanLogins[at - 1])
        void revoke(login.id, { find: next ? signInTrigger(next.id) : personTrigger(null), ifLost: true, gone: signInRow(login.id) })
        return
      }
    }
  }

  function linkPickerFor(login: MembershipDto) {
    const close = () => closeLinkPicker(login.id)
    return (
      <span
        className="flex items-center gap-1.5"
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          close()
        }}
      >
        <Select
          autoFocus
          value=""
          aria-label={`Link ${login.email} to a person`}
          disabled={savingId === login.id}
          onChange={(e) => {
            const memberId = e.target.value
            // Linked, the sign-in leaves this list and shows on the person's card: focus goes to its ⋯.
            if (memberId) linkLoginToPerson(login.id, memberId, { find: personTrigger(memberId), ifLost: true })
          }}
          className={`h-9 max-w-[220px] min-w-0 py-1.5 focus-visible:outline-none! ${TOUCH_H}`}
        >
          <option value="">Link to a person…</option>
          {members
            .filter((p) => !membershipByMember.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
        <Button size="sm" variant="ghost" onClick={close} aria-label="Cancel linking" className={`h-9 shrink-0 ${TOUCH_H}`}>
          Cancel
        </Button>
      </span>
    )
  }

  // The KPI row and the cards wait for the first answers, so they show in their final shape.
  const showFigures = !loading && members.length > 0

  return (
    <AppShell list active="people" title="People" month actions={desktop ? addButton || undefined : undefined}>
      {/* No people (or none could be loaded): nothing to add up, so no KPI row. */}
      {showFigures && (
        <KpiRow tiles={1} halves>
          <KpiTile
            hero
            label="Income"
            hint={incomeHint}
            value={money(monthIncomeMinor)}
            valueLabel={`Income this month: ${money(monthIncomeMinor)}`}
            sub={incomeSub}
          />
          <KpiTile
            label="Spent"
            icon={<ArrowUpRight strokeWidth={1.8} />}
            iconColor="var(--color-clay)"
            hint={spentHint}
            value={money(sharedSpentMinor)}
            valueLabel={`Spent this month: ${money(sharedSpentMinor)}`}
            strip
          />
        </KpiRow>
      )}

      {!desktop && addButton && <div className="flex justify-end">{addButton}</div>}

      {error && !showAdd && !inviteOpen && !archivePreview && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && (
        <section aria-labelledby={gridHeadingId} className="dash-palette @container">
          {/* The cards say who they are; the heading names the list for assistive tech. */}
          <h2 id={gridHeadingId} className="sr-only">
            Your household
          </h2>
          {members.length === 0 ? (
            // A household that couldn't be read is not one of one: the error says so, and only it.
            !loadFailed && (
              <>
                <EmptyState
                  icon={<MembersIcon className="h-6 w-6" />}
                  title="Budgeting on your own?"
                  description="You don’t need anyone else to use AllotJar. If you share money with a partner or housemate, add them here to split shared costs, divide savings, and give them their own sign-in."
                />
                {/* With no people there is no KPI row to say it: the month's missing budget, quietly. */}
                {!hasBudget && (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    No budget for {monthLabel} yet.{' '}
                    <Link to="/" className="font-semibold text-ok underline underline-offset-2">
                      Open the Dashboard
                    </Link>
                  </p>
                )}
              </>
            )
          ) : (
            <div className="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2 @min-[640px]:gap-6">
              {members.map((m, i) => {
                const login = membershipByMember.get(m.id)
                const spend = memberSpending(m.id)
                const incomeMinor = fromAmount(memberBudgetIncome(m))
                const defaultMinor = fromAmount(m.netMonthlyIncome)
                const offers = offersFor(m, login)
                return (
                  <PersonCard
                    key={m.id}
                    member={m}
                    hue={memberHue(i)}
                    login={login}
                    isSelf={myMembership?.memberId === m.id}
                    income={money(incomeMinor)}
                    // No budget for the month, no income figures: no ring and no share.
                    share={hasBudget ? m.incomeSharePct : null}
                    // The saved default is only a helper for a new budget; shown when it differs.
                    defaultIncome={defaultMinor !== 0 && incomeMinor !== defaultMinor ? money(defaultMinor) : null}
                    spent={money(fromAmount(spend?.spent ?? 0))}
                    fxPending={spend?.fxPendingCount ?? 0}
                    currency={currencySymbol(CURRENCY)}
                    savesTo={m.savingsPrivate ? PRIVATE_ACCOUNT : accountName(m.personalSavingsAccountId)}
                    note={personNote(m, login, canAccess, !!offers.me)}
                    phone={phone}
                    offers={offers}
                    onAction={(kind) => onPersonAction(m, login, kind)}
                    editor={editingId === m.id && canWrite ? editorFor(m, login) : null}
                    resent={login && resent?.id === login.id ? <ResentNote login={login} emailSent={resent.emailSent} /> : null}
                  />
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Sign-ins not tied to a budget person — so their access is never hidden. */}
      {!loading && canAccess && orphanLogins.length > 0 && (
        <section aria-labelledby={signInsHeadingId} className={DASH_CARD}>
          <div className="mb-1.5 flex min-h-8 items-center gap-1.5">
            <h2 id={signInsHeadingId} className={CARD_TITLE}>
              Other sign-ins
            </h2>
            <InfoHint label="About other sign-ins" buttonClassName={TITLE_HINT}>
              {SIGN_INS_HINT}
            </InfoHint>
          </div>
          <ul className="-mb-1.5 flex flex-col">
            {orphanLogins.map((login) => (
              <SignInRow
                key={login.id}
                login={login}
                phone={phone}
                busy={savingId === login.id}
                onAction={(kind) => onSignInAction(login, kind)}
                picker={linkingId === login.id ? linkPickerFor(login) : null}
                resent={resent?.id === login.id ? <ResentNote login={login} emailSent={resent.emailSent} /> : null}
              />
            ))}
          </ul>
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
            <Button id={inviteSubmitId} onClick={invite} disabled={inviting}>
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
            // One line on the warn tone; what to do next is behind its (i).
            <Notice
              role="alert"
              tone="warn"
              className="mt-4"
              hintLabel="About the failed email"
              hint={
                invited.method === 'direct' ? (
                  <>
                    We couldn't email <span className="font-medium">{invited.email}</span> their link. When they sign in
                    with the temporary password, they can ask for it again with "Email me the link".
                  </>
                ) : (
                  <>
                    We couldn't email <span className="font-medium">{invited.email}</span> their link. Use "Send again"
                    in their More actions menu (⋯) to try once more.
                  </>
                )
              }
            >
              {invited.method === 'direct' ? 'Login created, but the email failed' : 'Invite saved, but the email failed'}
            </Notice>
          )}
        </Modal>
      )}
    </AppShell>
  )
}

type PersonActionKind = 'me' | 'not-me' | 'invite' | 'resend' | 'edit' | 'archive'

/** Which of a person's actions apply (null / false: not offered), and whether each is busy. */
interface PersonOffers {
  me: { disabled: boolean } | null
  notMe: { disabled: boolean } | null
  invite: boolean
  resend: { disabled: boolean } | null
  /** Edit and Archive (Admin+); `busy` while the person is being saved or archived. */
  write: { busy: boolean } | null
}

/**
 * A person's ⋯ list, in the mock-up's order: who you are (This is me, This isn't me), their
 * sign-in (Invite to sign in, or Send again where Invite would be), Edit, then Archive after a
 * divider. Each item keeps the accessible name its button had before the restyle.
 */
function personActions(name: string, o: PersonOffers, onAction: (kind: PersonActionKind) => void): RowAction[] {
  const actions: RowAction[] = []
  if (o.me) actions.push({ key: 'me', label: 'This is me', icon: <User aria-hidden />, disabled: o.me.disabled, onSelect: () => onAction('me') })
  if (o.notMe) {
    actions.push({ key: 'not-me', label: "This isn't me", icon: <UserX aria-hidden />, disabled: o.notMe.disabled, onSelect: () => onAction('not-me') })
  }
  // The invite dialog gives focus back to the ⋯ when it closes.
  if (o.invite) actions.push({ key: 'invite', label: 'Invite to sign in', icon: <Mail aria-hidden />, after: 'dialog', onSelect: () => onAction('invite') })
  if (o.resend) {
    actions.push({
      key: 'resend',
      label: 'Send again',
      ariaLabel: `Send the email to ${name} again`,
      icon: <Mail aria-hidden />,
      disabled: o.resend.disabled,
      onSelect: () => onAction('resend'),
    })
  }
  if (o.write) {
    // The editor opens in the card and takes focus itself.
    actions.push({ key: 'edit', label: 'Edit', ariaLabel: `Edit ${name}`, icon: <Pencil aria-hidden />, after: 'focus', onSelect: () => onAction('edit') })
    actions.push({
      key: 'archive',
      label: 'Archive',
      ariaLabel: `Archive ${name}`,
      icon: <Archive aria-hidden />,
      disabled: o.write.busy,
      separatorBefore: true,
      // Focus is back on the ⋯ before the archive starts: the question (when there is one) gives
      // it back there, and a card that goes passes it on to the next.
      after: 'dialog',
      onSelect: () => onAction('archive'),
    })
  }
  return actions
}

/**
 * What a person's ⋯ note (and the phone sheet's description, or the (i) of a login with no
 * actions) says, one short fact a line and none the card already shows: who they sign in as (or
 * that they have no sign-in, for someone who can't invite them), what "This is me" does when it is
 * offered, and, when your sign-in was linked to them before, why "This isn't me" matters.
 */
function personNote(m: HouseholdMemberDto, login: MembershipDto | undefined, canAccess: boolean, offersMe: boolean): string[] {
  const lines: string[] = []
  if (login) lines.push(`Signs in as ${login.email}`)
  else if (!canAccess) lines.push('No sign-in')
  if (offersMe) lines.push(`“This is me” links your sign-in to ${m.name}.`)
  // D5: the earlier link still counts as theirs, so their own sign-in can't make their accounts private.
  if (m.canReleaseMyLink) lines.push(`Your sign-in was linked to ${m.name} before, which stops ${m.name} making their accounts private.`)
  return lines
}

/** The note's lines, each its own line, a space apart in the text a screen reader reads. */
function NoteLines({ lines, phone }: { lines: string[]; phone: boolean }) {
  return (
    <>
      {lines.map((t, i) => (
        // In the ⋯ menu a long line wraps, so the menu stays about the width of its items.
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={phone ? 'block' : 'block max-w-[216px] text-balance'}>{t}</span>
        </Fragment>
      ))}
    </>
  )
}

/**
 * One person (restyle PR 8): the avatar inside the share ring, the name (the card's heading) with
 * "You", the access level and a pending invite as chips, and the ⋯ (a bottom sheet on phones;
 * an (i) with the note for a login with no actions); under a hairline the month's income (with
 * the saved default when it differs), what they spent (with the payments still waiting for their
 * amount) and the account they save to. While it is being edited the editor takes the stats' place.
 */
function PersonCard({
  member: m,
  hue,
  login,
  isSelf,
  income,
  share,
  defaultIncome,
  spent,
  fxPending,
  currency,
  savesTo,
  note,
  phone,
  offers,
  onAction,
  editor,
  resent,
}: {
  member: HouseholdMemberDto
  hue: CategoryHue
  login: MembershipDto | undefined
  isSelf: boolean
  income: string
  /** Their share of the month's income (0 to 1); null when the month has no income figures (no budget). */
  share: number | null
  defaultIncome: string | null
  spent: string
  fxPending: number
  /** The budget currency's symbol ("€"), for the payments still waiting for their amount in it. */
  currency: string
  /** The savings account's name; null for none; '' when it can't be told. */
  savesTo: string | null
  note: string[]
  phone: boolean
  offers: PersonOffers
  onAction: (kind: PersonActionKind) => void
  editor: ReactNode
  resent: ReactNode
}) {
  const nameId = useId()
  const [sheetOpen, setSheetOpen] = useState(false)
  const actions = personActions(m.name, offers, onAction)
  const menuLabel = `${m.name}: more actions`
  const noteEl = note.length > 0 ? <NoteLines lines={note} phone={phone} /> : undefined
  const menu = editor ? null : actions.length > 0 ? (
    phone ? (
      <ActionSheet title={m.name} wrapTitle description={noteEl} actions={actions} open={sheetOpen} onOpenChange={setSheetOpen}>
        <button type="button" data-row-trigger="" aria-label={menuLabel} className={ROW_MENU_TRIGGER}>
          <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
        </button>
      </ActionSheet>
    ) : (
      <RowMenu label={menuLabel} actions={actions} note={noteEl} />
    )
  ) : noteEl ? (
    // A login with nothing to do here has no ⋯: what its note says sits behind an (i) in its place.
    <span data-person-hint="" className="inline-grid size-8 place-items-center">
      <InfoHint label={`About ${m.name}`} buttonClassName={TITLE_HINT} align="end" className={HINT_WRAP}>
        {noteEl}
      </InfoHint>
    </span>
  ) : null

  const chips: ReactNode[] = []
  if (isSelf) {
    chips.push(
      <StatusChip key="you" tone="neutral">
        You
      </StatusChip>,
    )
  }
  if (login?.status === MembershipStatus.Invited) {
    chips.push(
      <StatusChip key="invited" tone="warn">
        Invited
      </StatusChip>,
    )
  }
  if (login) {
    chips.push(
      <StatusChip key="role" tone="line">
        {HOUSEHOLD_ROLE_LABELS[login.role] ?? 'Unknown'}
      </StatusChip>,
    )
  }

  // The figures take their size from the card, not the screen: 18px in a card with room for them
  // (as in the mock-up), 16px in a narrow one (a phone, or two cards side by side on a small
  // screen). A sum is never cut short: Income and Spent keep their full width and "Saves to"
  // shares what is left, its name wrapping, or moves under them when even that is too little.
  const DD =
    'text-base leading-[1.3] font-[650] tracking-[-0.01em] text-slate-900 tabular-nums @min-[352px]/person:text-lg'
  const SUM = `${DD} whitespace-nowrap`
  return (
    <article
      aria-labelledby={nameId}
      data-person-id={m.id}
      className={`@container/person relative flex min-w-0 flex-col gap-[22px] has-[[role=tooltip]]:z-10 max-[699.98px]:gap-5 ${DASH_CARD}`}
    >
      <div className="flex min-w-0 items-center gap-4 max-[699.98px]:gap-3.5">
        {/* The name first for a screen reader (the share then reads as theirs); the ring stays first on screen. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          <h2 id={nameId} className="max-w-full min-w-0 text-lg leading-[1.3] font-[650] tracking-[-0.01em] break-words text-slate-900">
            {m.name}
          </h2>
          {chips.length > 0 && <span className="flex flex-wrap gap-1.5">{chips}</span>}
        </div>
        <ShareRing name={m.name} hue={hue} share={share} />
        {menu && <div className="-mr-1.5 shrink-0 self-center">{menu}</div>}
      </div>

      {editor ?? (
        <dl className="flex flex-wrap gap-x-2.5 gap-y-3.5 border-t border-line pt-4 @min-[352px]/person:gap-x-4 @min-[352px]/person:pt-[18px]">
          <div className="flex min-w-max flex-[1_1_0] flex-col gap-1">
            <dt className="text-[13px] text-slate-500">Income</dt>
            <dd className={SUM}>{income}</dd>
            {defaultIncome && <dd className="text-xs whitespace-nowrap text-slate-500 tabular-nums">default {defaultIncome}</dd>}
          </div>
          <div className="flex min-w-max flex-[1_1_0] flex-col gap-1">
            <dt className="text-[13px] text-slate-500">Spent</dt>
            <dd className={SUM}>{spent}</dd>
            {fxPending > 0 && (
              // In the "€ amount" words of the fill-in chips elsewhere; the Spent (i) says why.
              <dd className="text-xs font-semibold whitespace-nowrap text-warn">
                +{fxPending} need{fxPending === 1 ? 's' : ''} {currency} amount{fxPending === 1 ? '' : 's'}
              </dd>
            )}
          </div>
          <div className="flex min-w-[5.5rem] flex-[1.2_1_0] flex-col gap-1">
            <dt className="text-[13px] text-slate-500">Saves to</dt>
            {savesTo ? (
              <dd className={`${DD} break-words`}>{savesTo}</dd>
            ) : (
              <dd className={`${DD} font-medium! text-slate-500!`}>
                <span aria-hidden>—</span>
                {/* An account the accounts list couldn't name says nothing about whether there is one. */}
                <span className="sr-only">{savesTo === null ? 'None' : 'Unknown'}</span>
              </dd>
            )}
          </div>
        </dl>
      )}
      {resent}
    </article>
  )
}

/**
 * The person's avatar inside an open ring (a gap at the bottom for the % plate) that fills to
 * their share of the month's income; the plate says the share in words, with an (i). With no
 * income figures for the month (`share` null: no budget yet) only the avatar, in the same place.
 * First in its row on screen (`order-first`), after the name for a screen reader.
 */
function ShareRing({ name, hue, share }: { name: string; hue: CategoryHue; share: number | null }) {
  const box = 'relative order-first grid size-[60px] shrink-0 place-items-center max-[699.98px]:size-14'
  if (share === null) {
    return (
      <div className={box}>
        <MemberAvatar name={name} hue={hue} className="size-11 text-lg" />
      </div>
    )
  }
  const r = 28
  const w = 3.5
  const gap = 110 // the gap, in degrees, centred at the bottom
  const c = 2 * Math.PI * r
  const track = (c * (360 - gap)) / 360
  const fill = track * Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0))
  const turn = `rotate(${90 + gap / 2} 30 30)` // start just after the gap and run clockwise
  const color = hueColor(hue)
  return (
    <div className={box}>
      <svg viewBox="0 0 60 60" aria-hidden className="absolute inset-0 size-full">
        <circle
          cx="30"
          cy="30"
          r={r}
          fill="none"
          stroke="var(--color-track)"
          strokeWidth={w}
          strokeLinecap="round"
          strokeDasharray={`${track.toFixed(1)} ${c.toFixed(1)}`}
          transform={turn}
        />
        {fill > 0.05 && (
          <circle
            data-testid="share-arc"
            cx="30"
            cy="30"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={w}
            strokeLinecap="round"
            strokeDasharray={`${fill.toFixed(1)} ${c.toFixed(1)}`}
            transform={turn}
          />
        )}
      </svg>
      <MemberAvatar name={name} hue={hue} className="size-11 text-lg" />
      <span
        className="absolute -bottom-3 left-1/2 inline-flex h-[22px] -translate-x-1/2 items-center rounded-full bg-surface pr-px pl-2 text-xs font-[650] whitespace-nowrap tabular-nums has-[[role=tooltip]]:z-10"
        style={{
          color: `color-mix(in srgb, ${color} 62%, var(--color-foreground))`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, var(--color-border))`,
        }}
      >
        {sharePct(share)}
        <span className="sr-only"> of income</span>
        <InfoHint label={`About ${name}’s share of income`} buttonClassName={PLATE_HINT} className={`ml-0.5 ${HINT_WRAP}`}>
          {SHARE_HINT}
        </InfoHint>
      </span>
    </div>
  )
}

type SignInActionKind = 'resend' | 'link' | 'remove'

/**
 * A sign-in's ⋯ list, in the mock-up's order: Send again (a pending invite, or a login still to
 * choose its password), Link to a person (not the owner's), then Remove in red after a divider
 * (not the owner's, not yours). Each keeps the accessible name its control had before the restyle.
 */
function signInActions(login: MembershipDto, busy: boolean, onAction: (kind: SignInActionKind) => void): RowAction[] {
  const who = login.displayName ?? login.email
  const actions: RowAction[] = []
  if (canSendAgain(login)) {
    actions.push({
      key: 'resend',
      label: 'Send again',
      ariaLabel: `Send the email to ${who} again`,
      icon: <Mail aria-hidden />,
      disabled: busy,
      onSelect: () => onAction('resend'),
    })
  }
  if (!login.isOwner) {
    actions.push({
      key: 'link',
      label: 'Link to a person',
      ariaLabel: `Link ${login.email} to a person`,
      icon: <User aria-hidden />,
      disabled: busy,
      // The picker opens in the row and takes focus itself.
      after: 'focus',
      onSelect: () => onAction('link'),
    })
  }
  if (!login.isOwner && !login.isSelf) {
    actions.push({
      key: 'remove',
      label: 'Remove',
      ariaLabel: `Remove ${who}`,
      icon: <Trash2 aria-hidden />,
      danger: true,
      disabled: busy,
      separatorBefore: actions.length > 0,
      onSelect: () => onAction('remove'),
    })
  }
  return actions
}

/**
 * A sign-in not linked to a person (restyle PR 8): a neutral avatar (their initial, or a mail
 * icon when there is only an email), the name or the email, a warn chip while the invite is still
 * pending and the access level as a line chip, then the ⋯ (Send again, Link to a person, Remove;
 * a bottom sheet on phones). The link picker opens in the row.
 */
function SignInRow({
  login,
  phone,
  busy,
  onAction,
  picker,
  resent,
}: {
  login: MembershipDto
  phone: boolean
  /** The sign-in is being saved: its actions wait. */
  busy: boolean
  onAction: (kind: SignInActionKind) => void
  picker: ReactNode
  resent: ReactNode
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const who = login.displayName ?? login.email
  const actions = signInActions(login, busy, onAction)
  const label = `Sign-in ${login.email}: more actions`
  const steel = 'var(--color-steel)'
  const menu =
    actions.length === 0 ? null : phone ? (
      // Under the name, the email it signs in with (as the row shows), so the sheet can't pass for a person's.
      <ActionSheet
        title={who}
        wrapTitle
        description={login.displayName ? login.email : undefined}
        actions={actions}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      >
        <button type="button" data-row-trigger="" aria-label={label} className={ROW_MENU_TRIGGER}>
          <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
        </button>
      </ActionSheet>
    ) : (
      <RowMenu label={label} actions={actions} />
    )
  return (
    <li
      data-sign-in-id={login.id}
      className="grid min-h-14 grid-cols-[36px_minmax(0,1fr)_auto_40px] items-center gap-x-3.5 gap-y-2 py-3 not-first:border-t not-first:border-line max-[699.98px]:grid-cols-[36px_minmax(0,1fr)_40px] max-[699.98px]:gap-x-3"
    >
      <span
        aria-hidden
        className="col-start-1 row-start-1 grid size-9 place-items-center rounded-full text-sm font-[650] max-[699.98px]:self-start [&_svg]:size-[17px]"
        style={{
          background: `color-mix(in srgb, ${steel} 16%, var(--color-card))`,
          color: `color-mix(in srgb, ${steel} 62%, var(--color-foreground))`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${steel} 28%, transparent)`,
        }}
      >
        {login.displayName ? login.displayName.trim().charAt(0).toUpperCase() || '?' : <Mail strokeWidth={1.8} />}
      </span>
      {/* 14px, as the list rows on the other pages; a long name or email wraps rather than being cut. */}
      <div className="col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere] text-slate-900">{who}</span>
          <span className="flex gap-1.5">
            {login.status === MembershipStatus.Invited && <StatusChip tone="warn">Invited</StatusChip>}
            <StatusChip tone="line">{HOUSEHOLD_ROLE_LABELS[login.role] ?? 'Unknown'}</StatusChip>
          </span>
        </span>
        {login.displayName && <span className="text-[13px] [overflow-wrap:anywhere] text-slate-500">{login.email}</span>}
        {resent}
      </div>
      {picker && (
        <div className="col-start-3 row-start-1 min-w-0 max-[699.98px]:col-start-2 max-[699.98px]:row-start-2">{picker}</div>
      )}
      <div className="col-start-4 row-start-1 -mr-1.5 justify-self-end max-[699.98px]:col-start-3 max-[699.98px]:self-start">{menu}</div>
    </li>
  )
}

/** A pending invite, or a login someone else created that hasn't chosen its password yet (D7). */
function canSendAgain(login: MembershipDto): boolean {
  return !login.isOwner && !login.isSelf && (login.status === MembershipStatus.Invited || login.awaitingPassword === true)
}

function ResentNote({ login, emailSent }: { login: MembershipDto; emailSent: boolean }) {
  if (!emailSent) {
    return (
      <p role="alert" className="text-[13px] text-warn">
        We couldn't email {login.email} just now
        {login.status === MembershipStatus.Invited ? ', and the earlier link no longer works' : ''}. Try again later.
      </p>
    )
  }
  return (
    <p role="status" className="text-[13px] text-ok">
      {login.status === MembershipStatus.Invited
        ? `We've emailed ${login.email} a new link. The earlier one no longer works.`
        : `We've emailed ${login.email} their link to choose a password again.`}
    </p>
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
