import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Clock, Ellipsis, Landmark, Lock, Pencil, Plus, Trash2, TriangleAlert, Users, type LucideIcon } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { InfoHint } from '../components/InfoHint'
import { MiniBar, StatusChip } from '../components/StatusChip'
import { ActionSheet, ROW_MENU_TRIGGER, RowMenu, type RowAction } from '../components/RowActions'
import { CARD_TITLE, DASH_CARD, TITLE_HINT } from '../components/budget/card'
import { HolderAvatars, TypeTile } from '../components/accounts/AccountParts'
import { accountJars, reconState } from '../lib/accountJars'
import { Modal } from '../components/Modal'
import { AccountsIcon, JarNavIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useFeatures } from '../features/FeatureContext'
import { useHousehold } from '../features/HouseholdContext'
import { HolderPicker, PrivateCheckbox } from '../components/AccountHolders'
import { holderNames } from '../lib/accountHolders'
import { api } from '../lib/api'
import { useMediaQuery } from '../lib/useMediaQuery'
import { EVENTS, track } from '../analytics'
import type { AccountDto, AccountReconciliationDto, HouseholdMemberDto, UnreachableAccountDto } from '../types'
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_OPTIONS, AccountType } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { formatDate, todayIso } from '../lib/dates'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { editConflict, serverErrors } from '../lib/serverErrors'
import { hueColor } from '../lib/categoryColors'

// Current / Savings / Cash / Other — credit cards are not accounts (rule 75). An account
// recorded as one before the change still labels via ACCOUNT_TYPE_LABELS, so keep it as an
// extra option only while editing that row (never offered for a new account).
const TYPE_OPTIONS = ACCOUNT_TYPE_OPTIONS

function typeOptionsFor(type: number) {
  return TYPE_OPTIONS.some((o) => o.value === type)
    ? TYPE_OPTIONS
    : [...TYPE_OPTIONS, { value: type, label: ACCOUNT_TYPE_LABELS[type] ?? 'Other' }]
}

/**
 * Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. No
 * account may open below zero (rule 74), so a leading minus is invalid here; should one
 * reach the server anyway, its 400 message is shown as-is.
 */
function parseOpeningBalance(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

/** The optional bank identifiers (rule 76): trimmed, empty → null on the wire. */
interface Identifiers {
  iban: string
  bic: string
  sortCode: string
  accountNumber: string
}

const BLANK_IDS: Identifiers = { iban: '', bic: '', sortCode: '', accountNumber: '' }

function identifiersFrom(a: AccountDto): Identifiers {
  return { iban: a.iban ?? '', bic: a.bic ?? '', sortCode: a.sortCode ?? '', accountNumber: a.accountNumber ?? '' }
}

function identifiersPayload(ids: Identifiers) {
  const clean = (v: string) => (v.trim() === '' ? null : v.trim())
  return { iban: clean(ids.iban), bic: clean(ids.bic), sortCode: clean(ids.sortCode), accountNumber: clean(ids.accountNumber) }
}

const ID_FIELDS: Array<{ key: keyof Identifiers; label: string; placeholder: string }> = [
  { key: 'iban', label: 'IBAN', placeholder: 'e.g. MT84 MALT 0110 0001 2345 MTLC AST0 01S' },
  { key: 'bic', label: 'BIC', placeholder: 'e.g. VALLMTMT' },
  { key: 'sortCode', label: 'Sort code', placeholder: 'e.g. 40-47-84' },
  { key: 'accountNumber', label: 'Account number', placeholder: 'e.g. 12345678' },
]

/**
 * An (i) on a card: above the stretched link, and above the next card's ⋯ while it is open (its
 * popover can reach it). Its text wraps, whatever the line it sits in.
 */
const HINT_WRAP = 'z-[2] whitespace-normal has-[[role=tooltip]]:z-10'

/** The inline editor's small captions (the fields carry their full names for assistive tech). */
const CAPTION = 'text-xs font-medium text-slate-500'
const FIELD = 'h-9 w-full py-1.5 focus-visible:outline-none!'

/**
 * The Accounts page (restyle PR 6, the approved "polished Warm" mock-up): one KPI row (the total
 * balance, and what the jars hold of it and what they don't), then one card per account: its
 * type's icon, its name (the link to its own page), who holds it, its balance and, for an account
 * that holds jars, a slim bar of what they hold with the rest under it (this replaces the old
 * reconciliation table). Edit, Make private or Share, and Delete sit behind each card's ⋯ (a bottom
 * sheet on phones), with what else there is to know about the account in the menu's note. Below
 * the cards, the owner's private accounts nobody can reach, when there are any.
 */
export function AccountsPage() {
  // Managing accounts needs Admin+ (canWrite); others get a read-only register.
  const { canWrite, canManageHousehold, budgetCurrency, memberId } = useAuth()
  const { multiCurrency } = useFeatures()
  // W13: the people who can hold an account (rule 30).
  const { members } = useHousehold()
  // The top bar has room for Add account from 900px (AppShell's own breakpoint); below it the
  // button sits under the KPI row, as in the mock-up.
  const desktop = useMediaQuery('(min-width: 900px)')
  // Phones: a card's ⋯ opens a bottom sheet.
  const phone = useMediaQuery('(max-width: 699.98px)')
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [reconciliation, setReconciliation] = useState<AccountReconciliationDto[]>([])
  // Whether the reconciliation has answered (or failed) once. The page waits for it under
  // Loading…, so the KPI row and the cards' jar lines show in their final shape from the start.
  const [reconReady, setReconReady] = useState(false)
  // Whether a reconciliation answer is on screen (not only tried): then a card's link hands its
  // account's line to the account's page (router state, #344 P3-3), which reads it itself otherwise.
  const [reconOk, setReconOk] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // P59: accounts private to a login no longer in the household. Only the owner sees them, by
  // name and entry count, and may erase one for good behind its typed name.
  const [unreachable, setUnreachable] = useState<UnreachableAccountDto[]>([])
  const [eraseId, setEraseId] = useState<string | null>(null)
  const [eraseName, setEraseName] = useState('')
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)

  // Add-account modal.
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<number>(AccountType.Current)
  const [opening, setOpening] = useState('')
  // The opening balance is the money held at the START of this date (rule 40); required.
  const [openingDate, setOpeningDate] = useState(todayIso)
  const [ids, setIds] = useState<Identifiers>(BLANK_IDS)
  const [holderIds, setHolderIds] = useState<string[]>([])
  // Rule 31: an account you add for yourself alone starts private unless you untick this.
  const [keepPrivate, setKeepPrivate] = useState(true)
  const [adding, setAdding] = useState(false)

  // Inline (in-card) edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eName, setEName] = useState('')
  const [eType, setEType] = useState<number>(AccountType.Current)
  const [eOpening, setEOpening] = useState('')
  const [eOpeningDate, setEOpeningDate] = useState('')
  const [eIds, setEIds] = useState<Identifiers>(BLANK_IDS)
  const [eHolderIds, setEHolderIds] = useState<string[]>([])
  // The version the edit was loaded from, sent back with the save (D11).
  const [eVersion, setEVersion] = useState<string | null>(null)

  const gridHeadingId = useId()
  const unreachableHeadingId = useId()
  const addButtonId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  // Where focus goes once the editor or a delete has closed a card's controls: the ⋯ of the
  // account `id` (or, for null, the Add account button). `ifLost`: only when focus has fallen to
  // the page (a save or delete that ends after the user moved on leaves focus where it is).
  const pendingFocus = useRef<{ id: string | null; ifLost: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<AccountDto[]>('/accounts')
      .then(({ data }) => !cancelled && setAccounts(data))
      .catch(() => !cancelled && setError('Could not load your accounts.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!canManageHousehold) return
    let cancelled = false
    api
      .get<UnreachableAccountDto[]>('/accounts/unreachable')
      .then(({ data }) => !cancelled && setUnreachable(Array.isArray(data) ? data : []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [canManageHousehold])

  const erase = useCallback(async (id: string, confirmName: string) => {
    setErasing(true)
    setEraseError(null)
    try {
      await api.post(`/accounts/${id}/erase`, { confirmName })
      setUnreachable((prev) => prev.filter((a) => a.id !== id))
      setEraseId(null)
      setEraseName('')
      // The erase can drop movements the shared accounts counted (a transfer that never
      // arrived), so the accounts are read again (the reconciliation follows the account set).
      const { data } = await api.get<AccountDto[]>('/accounts')
      setAccounts(data)
    } catch (err) {
      // A refused erase (the name doesn't match, a refund elsewhere names a purchase in it, a
      // shared account would go below zero without a transfer from it) carries the reason.
      setEraseError(serverErrors(err) ?? 'Could not erase that account.')
    } finally {
      setErasing(false)
    }
  }, [])

  // Reconciliation reflects current balances + fund backing, so refresh it whenever
  // the account set changes (initial load and after any add/edit/delete). The answer on screen
  // stays until a newer one arrives, and an answer older than it is dropped: so the first answer
  // (asked for alongside the accounts) shows at once instead of waiting for the re-read the
  // loaded accounts start, and a late one never overwrites a newer one.
  const reconAsked = useRef(0)
  const reconShown = useRef(0)
  useEffect(() => {
    const seq = ++reconAsked.current
    api
      .get<AccountReconciliationDto[]>('/accounts/reconciliation')
      .then(({ data }) => {
        if (seq < reconShown.current) return
        reconShown.current = seq
        setReconciliation(Array.isArray(data) ? data : [])
        setReconOk(true)
      })
      .catch(() => {})
      .finally(() => setReconReady(true))
  }, [accounts])

  const ownPersonal = !!memberId && holderIds.length === 1 && holderIds[0] === memberId

  const addAccount = useCallback(async () => {
    if (name.trim() === '') {
      setError('Give the account a name.')
      return
    }
    const openingBalance = parseOpeningBalance(opening)
    if (openingBalance === null) {
      setError(opening.trim().startsWith('-') ? 'An opening balance can’t be negative.' : 'Enter a valid opening balance.')
      return
    }
    if (tooPrecise(opening)) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    if (!openingDate) {
      setError('Enter the date the opening balance applies from.')
      return
    }
    setAdding(true)
    setError(null)
    try {
      const { data } = await api.post<AccountDto>('/accounts', {
        name: name.trim(),
        type,
        // One currency for the whole budget: every new account uses the budget currency.
        currency: budgetCurrency,
        openingBalance,
        openingDate,
        ...identifiersPayload(ids),
        holderIds,
        ...(ownPersonal ? { isPrivate: keepPrivate } : {}),
      })
      // A row with this id (a save answered twice) is replaced, never listed twice.
      setAccounts((prev) => (prev.some((a) => a.id === data.id) ? prev.map((a) => (a.id === data.id ? data : a)) : [...prev, data]))
      track(EVENTS.accountCreated, { kind: ACCOUNT_TYPE_LABELS[type] ?? 'unknown' })
      setName('')
      setOpening('')
      setOpeningDate(todayIso())
      setIds(BLANK_IDS)
      setHolderIds([])
      setKeepPrivate(true)
      setShowAdd(false)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not add that account.')
    } finally {
      setAdding(false)
    }
  }, [name, type, opening, openingDate, budgetCurrency, ids, holderIds, keepPrivate, ownPersonal])

  const startEdit = useCallback((a: AccountDto) => {
    setEditingId(a.id)
    setEName(a.name)
    setEType(a.type)
    setEOpening(toEditString(fromAmount(a.openingBalance)))
    setEOpeningDate(a.openingDate ?? '')
    setEIds(identifiersFrom(a))
    setEHolderIds((a.holders ?? []).map((h) => h.memberId))
    setEVersion(a.version ?? null)
  }, [])

  /** Close the editor from its Cancel (or Escape): focus back to the card's ⋯. */
  const cancelEdit = useCallback((id: string) => {
    pendingFocus.current = { id, ifLost: false }
    setEditingId(null)
  }, [])

  const saveEdit = useCallback(
    async (id: string) => {
      if (eName.trim() === '') {
        setError('Give the account a name.')
        return
      }
      const openingBalance = parseOpeningBalance(eOpening)
      if (openingBalance === null) {
        setError(eOpening.trim().startsWith('-') ? 'An opening balance can’t be negative.' : 'Enter a valid opening balance.')
        return
      }
      // A typed amount is whole cents (D1); the saved one goes back as it is.
      const saved = accounts.find((a) => a.id === id)
      if (tooPrecise(eOpening, saved ? fromAmount(saved.openingBalance) : null)) {
        setError(TOO_MANY_DECIMALS)
        return
      }
      if (!eOpeningDate) {
        setError('Enter the date the opening balance applies from.')
        return
      }
      setSavingId(id)
      setError(null)
      try {
        const { data } = await api.put<AccountDto>(`/accounts/${id}`, {
          name: eName.trim(),
          type: eType,
          openingBalance,
          openingDate: eOpeningDate,
          ...identifiersPayload(eIds),
          // Sent only once the people are known, so an unloaded list never clears the holders.
          ...(members.length > 0 ? { holderIds: eHolderIds } : {}),
          version: eVersion,
        })
        setAccounts((prev) => prev.map((a) => (a.id === id ? data : a)))
        track(EVENTS.accountEdited)
        pendingFocus.current = { id, ifLost: true }
        setEditingId(null)
      } catch (err) {
        const conflict = editConflict(err)
        if (conflict) {
          // Someone else saved this account first (D11): show what they saved in the open form.
          const fresh = await api.get<AccountDto[]>('/accounts').then(({ data }) => data, () => null)
          const row = Array.isArray(fresh) ? fresh.find((a) => a.id === id) : undefined
          if (Array.isArray(fresh)) setAccounts(fresh)
          if (row) startEdit(row)
          else setEditingId(null)
          setError(conflict)
        } else {
          setError(serverErrors(err) ?? 'Could not save that account.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [eName, eType, eOpening, eOpeningDate, eIds, eHolderIds, eVersion, members.length, accounts, startEdit],
  )

  // Rules 31/33: the holder's own choice of who sees their personal account.
  const setSharing = useCallback(async (a: AccountDto, isPrivate: boolean) => {
    setSavingId(a.id)
    setError(null)
    try {
      const { data } = await api.put<AccountDto>(`/accounts/${a.id}/sharing`, { isPrivate })
      setAccounts((prev) => prev.map((x) => (x.id === a.id ? data : x)))
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not change who sees that account.')
    } finally {
      setSavingId(null)
    }
  }, [])

  const remove = useCallback(
    async (id: string) => {
      // Once it has gone, focus moves on to the card that takes its place (or the one before it),
      // else the Add account button: the dialog gave it back to the removed card's ⋯.
      const at = accounts.findIndex((a) => a.id === id)
      const next = at < 0 ? undefined : (accounts[at + 1] ?? accounts[at - 1])
      setSavingId(id)
      setError(null)
      try {
        await api.delete(`/accounts/${id}`)
        pendingFocus.current = { id: next?.id ?? null, ifLost: true }
        setAccounts((prev) => prev.filter((a) => a.id !== id))
      } catch (err) {
        // A refused delete (the account is a side of a transfer) carries the reason.
        setError(serverErrors(err) ?? 'Could not delete that account.')
      } finally {
        setSavingId(null)
      }
    },
    [accounts],
  )

  // Focus back to a card's ⋯ once its editor has closed, or on to the next card after a delete
  // (see pendingFocus). Runs after the dialog's own clean-up, as an update effect runs after an
  // unmount's.
  useEffect(() => {
    const target = pendingFocus.current
    if (!target || confirmDeleteId) return
    pendingFocus.current = null
    const active = document.activeElement
    if (target.ifLost && active && active !== document.body && active.isConnected) return
    const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-account-id]') ?? []).find(
      (el) => el.dataset.accountId === target.id,
    )
    ;(card?.querySelector<HTMLElement>('[data-row-trigger]') ?? (target.id === null ? document.getElementById(addButtonId) : null))?.focus()
  }, [accounts, editingId, confirmDeleteId, addButtonId])

  // The whole budget uses one currency and the app never converts, so the totals count only
  // accounts in the budget currency. An account in another currency (legacy data) is left out
  // and called out; per-account figures always use the account's own currency.
  const inBudgetCurrency = useMemo(
    () => accounts.filter((a) => a.currency === budgetCurrency),
    [accounts, budgetCurrency],
  )
  const otherCurrencyCount = accounts.length - inBudgetCurrency.length
  // The total across those accounts whose balance is available, and the money they hold (the
  // positive balances; it differs only when a legacy account is below zero). An unavailable
  // balance (no opening date, rule 67) is left out and called out, never counted as zero.
  const known = useMemo(() => inBudgetCurrency.filter((a) => a.currentBalance !== null), [inBudgetCurrency])
  const unavailableCount = inBudgetCurrency.length - known.length
  const netMinor = useMemo(
    () => known.reduce((sum, a) => sum + fromAmount(a.currentBalance ?? 0), 0),
    [known],
  )
  const availableMinor = useMemo(
    () => known.reduce((sum, a) => sum + Math.max(0, fromAmount(a.currentBalance ?? 0)), 0),
    [known],
  )
  const pendingReviewCount = useMemo(
    () => accounts.reduce((n, a) => n + (a.pendingReceiptCount ?? 0), 0),
    [accounts],
  )

  // Each account's line of the reconciliation (what its jars hold, and the rest).
  const reconById = useMemo(() => new Map(reconciliation.map((r) => [r.accountId, r])), [reconciliation])
  // The KPI row's In jars and Not in jars, over the same accounts as the total: the jars' money
  // and each account's unallocated rest (its whole balance when it holds no jar), from the
  // reconciliation. Only once some counted account holds a jar: otherwise they would read zero
  // and the total again.
  const jarFigures = useMemo(() => {
    let inJars = 0
    let notInJars = 0
    let holdsJars = false
    for (const a of known) {
      const r = reconById.get(a.id)
      const balance = fromAmount(a.currentBalance ?? 0)
      const backed = r ? fromAmount(r.backedJarsTotal) : 0
      if (r && r.backedJarCount > 0) holdsJars = true
      inJars += backed
      notInJars += r && r.float !== null ? fromAmount(r.float) : balance - backed
    }
    return holdsJars ? { inJars, notInJars } : null
  }, [known, reconById])

  const money = (minor: number) => formatMoney(minor, budgetCurrency)

  const heroHint = (
    <>
      Your accounts in {budgetCurrency} added up. An account in another currency, or with no balance before its opening date, is
      left out. Money on its way from one account to another counts in neither until it arrives.
    </>
  )
  const heroLines: Array<{ key: string; Icon?: LucideIcon; text: string }> = []
  if (availableMinor !== netMinor) heroLines.push({ key: 'available', text: `${money(availableMinor)} available` })
  if (otherCurrencyCount > 0) {
    heroLines.push({
      key: 'currency',
      Icon: TriangleAlert,
      text: `${otherCurrencyCount} account${otherCurrencyCount === 1 ? '' : 's'} in another currency ${otherCurrencyCount === 1 ? 'is' : 'are'} not counted.`,
    })
  }
  if (unavailableCount > 0) {
    heroLines.push({
      key: 'unavailable',
      Icon: TriangleAlert,
      text: `${unavailableCount} account${unavailableCount === 1 ? '' : 's'} with no balance before ${unavailableCount === 1 ? 'its' : 'their'} opening date ${unavailableCount === 1 ? 'is' : 'are'} not counted.`,
    })
  }
  if (pendingReviewCount > 0) {
    heroLines.push({
      key: 'review',
      Icon: Clock,
      text: `${pendingReviewCount} transfer receipt${pendingReviewCount === 1 ? '' : 's'} pending review.`,
    })
  }
  const heroSub =
    heroLines.length > 0 ? (
      <span className="flex flex-col gap-1">
        {heroLines.map(({ key, Icon, text }) => (
          <span key={key} className="inline-flex items-start gap-1.5">
            {Icon && <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
            <span>{text}</span>
          </span>
        ))}
      </span>
    ) : undefined

  // The account whose delete is being confirmed.
  const deleting = confirmDeleteId ? (accounts.find((a) => a.id === confirmDeleteId) ?? null) : null

  // The accounts and the first reconciliation answer are in: the page shows in its final shape.
  const ready = !loading && reconReady

  // A rarely used action: quiet (an outline), as Jars' Move money.
  const addButton =
    canWrite && ready ? (
      <Button
        id={addButtonId}
        variant="secondary"
        onClick={() => {
          setError(null)
          setShowAdd(true)
        }}
        aria-label="Add account"
        className="h-[38px] gap-[7px] rounded-[10px] border-slate-200 py-0 text-slate-900 shadow-[var(--shadow-frame)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:hover:bg-foreground/7"
      >
        <Plus aria-hidden className="size-4" />
        Add account
      </Button>
    ) : null

  function actionsFor(a: AccountDto): RowAction[] {
    const saving = savingId === a.id
    const actions: RowAction[] = []
    if (canWrite) {
      // The editor opens in the card and takes focus itself.
      actions.push({ key: 'edit', label: 'Edit', ariaLabel: `Edit ${a.name}`, icon: <Pencil aria-hidden />, after: 'focus', onSelect: () => startEdit(a) })
    }
    // P54: the holder's own choice, whatever their role; a jar that uses it keeps it shared (P55).
    if (a.canChangeSharing && a.isPrivate) {
      actions.push({
        key: 'share',
        label: 'Share with household',
        ariaLabel: `Share ${a.name} with the household`,
        icon: <Users aria-hidden />,
        disabled: saving,
        onSelect: () => setSharing(a, false),
      })
    } else if (a.canChangeSharing && !a.sharingBlockedReason) {
      actions.push({
        key: 'private',
        label: 'Make private',
        ariaLabel: `Make ${a.name} private`,
        icon: <Lock aria-hidden />,
        disabled: saving,
        onSelect: () => setSharing(a, true),
      })
    }
    if (canWrite) {
      actions.push({
        key: 'delete',
        label: 'Delete',
        ariaLabel: `Delete ${a.name}`,
        icon: <Trash2 aria-hidden />,
        danger: true,
        disabled: saving,
        separatorBefore: actions.length > 0,
        after: 'dialog',
        onSelect: () => setConfirmDeleteId(a.id),
      })
    }
    return actions
  }

  function editorFor(a: AccountDto) {
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      cancelEdit(a.id)
    }
    return (
      // The native date picker's icon and the holders' tick boxes follow the theme (on this page
      // only: the app has no colour scheme of its own yet).
      <div className="flex flex-col gap-3 [color-scheme:light] dark:[color-scheme:dark]" onKeyDown={onKeyDown}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <div className="col-span-2 flex flex-col gap-1">
            <span aria-hidden className={CAPTION}>
              Name
            </span>
            <Input type="text" autoFocus value={eName} aria-label={`Name for ${a.name}`} onChange={(e) => setEName(e.target.value)} className={FIELD} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className={CAPTION}>
              Type
            </span>
            <Select value={eType} aria-label={`Type for ${a.name}`} onChange={(e) => setEType(Number(e.target.value))} className={FIELD}>
              {typeOptionsFor(a.type).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className={CAPTION}>
              Opening balance
            </span>
            <Input
              type="text"
              inputMode="decimal"
              {...selectOnFocusProps}
              value={eOpening}
              aria-label={`Opening balance for ${a.name}`}
              onChange={(e) => setEOpening(e.target.value)}
              className={`${FIELD} text-right tabular-nums`}
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <span aria-hidden className={CAPTION}>
              Opening date
            </span>
            <Input
              type="date"
              value={eOpeningDate}
              aria-label={`Opening date for ${a.name}`}
              onChange={(e) => setEOpeningDate(e.target.value)}
              className={`${FIELD} text-slate-700`}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span aria-hidden className={CAPTION}>
            Bank details
          </span>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {ID_FIELDS.map((f) => (
              <Input
                key={f.key}
                type="text"
                value={eIds[f.key]}
                placeholder={f.label}
                aria-label={`${f.label} for ${a.name}`}
                autoComplete="off"
                onChange={(e) => setEIds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className={FIELD}
              />
            ))}
          </div>
        </div>
        <HolderPicker members={members} value={eHolderIds} onChange={setEHolderIds} accountName={a.name} />
        {(multiCurrency || a.currency !== budgetCurrency) && (
          <p className="text-xs text-slate-500">
            Currency <span className="font-semibold text-slate-700">{a.currency}</span> — fixed once created.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => cancelEdit(a.id)} aria-label="Cancel edit" className="h-9">
            Cancel
          </Button>
          <Button size="sm" onClick={() => saveEdit(a.id)} disabled={savingId === a.id} aria-label={`Save ${a.name}`} className="h-9">
            Save
          </Button>
        </div>
      </div>
    )
  }

  return (
    <AppShell active="accounts" title="Accounts" actions={desktop ? addButton || undefined : undefined}>
      {/* No accounts (or none could be loaded): nothing to add up, so no KPI row above the empty
          card. With no jar figures the hero takes the whole row. */}
      {ready && accounts.length > 0 && (
        <KpiRow tiles={jarFigures ? 2 : 0} thirds wide>
          <KpiTile
            hero
            label="Total balance"
            hint={heroHint}
            value={money(netMinor)}
            valueLabel={`Total balance: ${money(netMinor)}`}
            sub={heroSub}
          />
          {jarFigures && (
            <KpiTile
              label="In jars"
              icon={<JarNavIcon strokeWidth={1.8} />}
              hue="teal"
              value={money(jarFigures.inJars)}
            />
          )}
          {jarFigures && (
            <KpiTile
              label="Not in jars"
              icon={<Landmark strokeWidth={1.8} />}
              iconColor="var(--color-steel)"
              value={money(jarFigures.notInJars)}
              // Below zero the jars hold more than the accounts have (a shortfall): red, as on the cards.
              valueTone={jarFigures.notInJars < 0 ? 'bad' : undefined}
            />
          )}
        </KpiRow>
      )}

      {!desktop && addButton && <div className="flex justify-end">{addButton}</div>}

      {error && !showAdd && <ErrorBanner>{error}</ErrorBanner>}

      {!ready && <p className="text-slate-500">Loading…</p>}

      {ready && (
        <section aria-labelledby={gridHeadingId} className="@container">
          {/* The cards say what they are; the heading names the list for assistive tech. */}
          <h2 id={gridHeadingId} className="sr-only">
            Your accounts
          </h2>
          {accounts.length === 0 ? (
            <EmptyState
              icon={<AccountsIcon className="h-6 w-6" />}
              title="No accounts yet"
              description="Use + Add account, then tag transactions to it to track its balance."
            />
          ) : (
            <div
              ref={gridRef}
              className={`dash-palette grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2 @min-[640px]:gap-6 @min-[900px]:grid-cols-3 @min-[1400px]:grid-cols-4 @min-[1800px]:grid-cols-5 @min-[2200px]:grid-cols-6 max-[699.98px]:flex max-[699.98px]:flex-col max-[699.98px]:gap-0 max-[699.98px]:rounded-[14px] max-[699.98px]:border max-[699.98px]:border-slate-200/70 max-[699.98px]:bg-surface max-[699.98px]:px-[18px] max-[699.98px]:py-0.5 max-[699.98px]:shadow-card`}
            >
              {accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  recon={reconById.get(a.id)}
                  reconOk={reconOk}
                  members={members}
                  budgetCurrency={budgetCurrency}
                  multiCurrency={multiCurrency}
                  phone={phone}
                  actions={actionsFor(a)}
                  editor={editingId === a.id && canWrite ? editorFor(a) : null}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {ready && canManageHousehold && unreachable.length > 0 && (
        // Quiet, under the cards: as wide as one card column where the grid has room.
        <div className="@container">
          <section
            data-testid="unreachable-accounts"
            aria-labelledby={unreachableHeadingId}
            className={`${DASH_CARD} @min-[640px]:w-[calc((100%-24px)/2)] @min-[900px]:w-[calc((100%-48px)/3)] @min-[1400px]:w-[calc((100%-72px)/4)] @min-[1800px]:w-[calc((100%-96px)/5)] @min-[2200px]:w-[calc((100%-120px)/6)]`}
          >
            <div className="flex items-center gap-1.5">
              <h2 id={unreachableHeadingId} className={CARD_TITLE}>
                Private accounts nobody can reach
              </h2>
              <InfoHint label="About private accounts nobody can reach" buttonClassName={TITLE_HINT} align="center">
                Each is private to a login that is no longer in the household. Nobody can see or change them. If that person won’t be
                back, you can erase one for good; you never see what is in it.
              </InfoHint>
            </div>
            <ul className="mt-1.5 -mb-2.5">
              {unreachable.map((a) => (
                <li
                  key={a.id}
                  className="flex min-h-12 items-center gap-3 border-t border-slate-200/70 py-2.5 text-sm first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-900">{a.name}</p>
                    <p className="text-[13px] text-slate-500">
                      {a.holderName ? `${a.holderName} · ` : ''}
                      {a.entryCount === 1 ? '1 entry' : `${a.entryCount} entries`} · {a.currency}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEraseError(null)
                      setEraseName('')
                      setEraseId(a.id)
                    }}
                    aria-label={`Erase ${a.name}`}
                    // A 40px target for a finger, as the page's other controls.
                    className="shrink-0 text-bad! hover:bg-bad-bg! hover:text-bad! max-[699.98px]:h-10 [@media(hover:none)]:h-10"
                  >
                    Erase…
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {showAdd && canWrite && (
        <Modal title="Add an account" onClose={() => setShowAdd(false)}>
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
                placeholder="e.g. Everyday current"
                aria-label="Account name"
                onChange={(e) => setName(e.target.value)}
                className="w-full"
              />
            </label>
            <HolderPicker members={members} value={holderIds} onChange={setHolderIds} />
            {ownPersonal && <PrivateCheckbox checked={keepPrivate} onChange={setKeepPrivate} />}
            <p className="text-xs text-slate-500">
              The account holds {budgetCurrency}, your budget currency.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Type
                <Select value={type} aria-label="Account type" onChange={(e) => setType(Number(e.target.value))} className="w-full">
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Opening balance
                <Input
                  type="text"
                  inputMode="decimal"
                  {...selectOnFocusProps}
                  value={opening}
                  placeholder="0.00"
                  aria-label="Opening balance"
                  onChange={(e) => setOpening(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addAccount()
                  }}
                  className="w-full text-right tabular-nums"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Opening date
              <Input
                type="date"
                value={openingDate}
                aria-label="Opening date"
                onChange={(e) => setOpeningDate(e.target.value)}
                className="w-full text-slate-700"
              />
              <span className="font-normal text-slate-400">
                The balance at the start of this day. Earlier transactions stay as history and don’t change it.
              </span>
            </label>
            <fieldset className="grid grid-cols-2 gap-3">
              <legend className="mb-1 text-xs font-medium text-slate-500">
                Bank details <span className="font-normal text-slate-400">(optional — a piggy bank has none)</span>
              </legend>
              {ID_FIELDS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                  {f.label}
                  <Input
                    type="text"
                    value={ids[f.key]}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    autoComplete="off"
                    onChange={(e) => setIds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full"
                  />
                </label>
              ))}
            </fieldset>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button onClick={addAccount} disabled={adding} aria-label="Add account">
                Add account
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && canWrite && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setConfirmDeleteId(null)}>
          <p className="text-sm text-slate-600">
            The account is removed, but its transactions are kept — they simply become
            unassigned from any account. An account that is a side of a transfer can’t be
            deleted until those transfers are removed. This can’t be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmDeleteId(null)
                remove(deleting.id)
              }}
              disabled={savingId === deleting.id}
              aria-label={`Confirm delete ${deleting.name}`}
            >
              Delete account
            </Button>
          </div>
        </Modal>
      )}

      {eraseId && canManageHousehold && (() => {
        const acct = unreachable.find((a) => a.id === eraseId)
        if (!acct) return null
        const matches = eraseName.trim().toLowerCase() === acct.name.trim().toLowerCase()
        return (
          <Modal
            title={`Erase ${acct.name}?`}
            onClose={() => {
              setEraseId(null)
              setEraseName('')
              setEraseError(null)
            }}
          >
            <p className="text-sm text-slate-600">
              This account is private to a login that is no longer in the household, so nobody can
              see it, change it or share it. Erasing removes the account and what only its holder could
              see for good ({acct.entryCount === 1 ? 'one entry' : `${acct.entryCount} entries`} touch it).
              Anything the household already saw stays and keeps counting without the account: an entry
              on a budget line, a refund of a shared purchase, and a shared account’s side of a transfer
              with it, with its bank reference and fee. Nothing in it is shown to you. This can’t be undone.
            </p>
            <label htmlFor="erase-name" className="mt-4 block text-sm font-medium text-slate-600">
              Type <span className="font-semibold text-slate-800">{acct.name}</span> to confirm
            </label>
            <Input
              id="erase-name"
              type="text"
              value={eraseName}
              autoComplete="off"
              onChange={(e) => setEraseName(e.target.value)}
              className="mt-1 w-full"
            />
            {eraseError && <ErrorBanner className="mt-3">{eraseError}</ErrorBanner>}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setEraseId(null)
                  setEraseName('')
                  setEraseError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => erase(acct.id, eraseName)}
                disabled={!matches || erasing}
                aria-label={`Confirm erase ${acct.name}`}
              >
                {erasing ? 'Erasing…' : 'Erase for good'}
              </Button>
            </div>
          </Modal>
        )
      })()}
    </AppShell>
  )
}

/**
 * What the ⋯'s note (and the phone sheet's description, or a read-only login's (i)) says about an
 * account, one fact a line and none the card already shows: its type (and that it is joint, and
 * its currency where the budget has several and the card shows none), who holds it by name (the
 * card's avatars show initials), its opening balance, why it has no balance (`balanceReason`, on a
 * phone, where the card's row has no room for the (i) beside "Not available"), the exact money its
 * jars hold (the bar only draws it), and who sees it when the holder chooses.
 */
function noteLines(
  a: AccountDto,
  recon: AccountReconciliationDto | undefined,
  budgetCurrency: string,
  multiCurrency: boolean,
  balanceReason?: string,
): string[] {
  const type = [ACCOUNT_TYPE_LABELS[a.type] ?? 'Other']
  if ((a.holders?.length ?? 0) > 1) type.push('joint')
  if (multiCurrency && a.currency === budgetCurrency) type.push(a.currency)
  const lines = [type.join(' · ')]
  if ((a.holders?.length ?? 0) > 0) lines.push(`Held by ${holderNames(a)}`)
  lines.push(`Opening ${formatMoney(fromAmount(a.openingBalance), a.currency)}${a.openingDate ? ` on ${formatDate(a.openingDate)}` : ''}`)
  if (balanceReason) lines.push(balanceReason)
  if (recon && recon.backedJarCount > 0) lines.push(`${formatMoney(fromAmount(recon.backedJarsTotal), a.currency)} in jars`)
  if (a.canChangeSharing) {
    if (a.isPrivate) lines.push('Only you can see this account.')
    // P55: the server's reason says which jar uses it and that it so stays visible to everyone.
    else if (a.sharingBlockedReason) lines.push(a.sharingBlockedReason)
  }
  return lines
}

/**
 * One account (restyle PR 6). Desktop and tablet: a card in the grid (the type's icon, the name
 * with who holds it under it and the ⋯ at the right; the balance; the status chips; the jar bar
 * and its caption). Phones: a row of the one list card (icon, name and holders, balance, ⋯ on one
 * line; the chips and the jar bar on lines of their own under the name). One element either way:
 * the layout switches in CSS, so no account is ever mounted twice. While it is being edited the
 * card holds the editor instead.
 */
function AccountCard({
  account: a,
  recon,
  reconOk,
  members,
  budgetCurrency,
  multiCurrency,
  phone,
  actions,
  editor,
}: {
  account: AccountDto
  /** The account's line of the reconciliation, once it has answered. */
  recon: AccountReconciliationDto | undefined
  /** A reconciliation answer is on screen: the link hands `recon` to the account's page. */
  reconOk: boolean
  members: HouseholdMemberDto[]
  budgetCurrency: string
  multiCurrency: boolean
  /** A phone: the ⋯ opens a bottom sheet instead of a menu. */
  phone: boolean
  /** None for a read-only login: no ⋯, only an (i) with the note. */
  actions: RowAction[]
  /** The inline editor, while this account is being edited. */
  editor: ReactNode
}) {
  const nameId = useId()
  const typeId = useId()
  const balanceId = useId()
  const [sheetOpen, setSheetOpen] = useState(false)
  if (editor) {
    return (
      <article
        aria-labelledby={nameId}
        data-account-id={a.id}
        className={`flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-200/70 bg-surface p-5 shadow-card max-[699.98px]:rounded-none max-[699.98px]:border-0 max-[699.98px]:bg-transparent max-[699.98px]:px-0 max-[699.98px]:py-3.5 max-[699.98px]:shadow-none max-[699.98px]:not-first:border-t max-[699.98px]:not-first:border-line`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <TypeTile type={a.type} small />
          <h3 id={nameId} className="min-w-0 truncate text-base font-[650] tracking-[-0.01em] text-slate-900">
            {a.name}
          </h3>
        </div>
        {editor}
      </article>
    )
  }

  const balanceMinor = a.currentBalance === null ? null : fromAmount(a.currentBalance)
  const holders = a.holders ?? []
  const otherCurrency = a.currency !== budgetCurrency
  const inTransitOut = fromAmount(a.inTransitOut ?? 0)
  const inTransitIn = fromAmount(a.inTransitIn ?? 0)
  const pendingReceipts = a.pendingReceiptCount ?? 0
  const chips: ReactNode[] = []
  if (inTransitOut > 0) {
    chips.push(
      <StatusChip key="out" tone="line">
        {formatMoney(inTransitOut, a.currency)} in transit out
      </StatusChip>,
    )
  }
  if (inTransitIn > 0) {
    chips.push(
      <StatusChip key="in" tone="line">
        {formatMoney(inTransitIn, a.currency)} in transit in
      </StatusChip>,
    )
  }
  if (pendingReceipts > 0) {
    chips.push(
      <StatusChip key="review" tone="warn">
        {pendingReceipts} receipt{pendingReceipts === 1 ? '' : 's'} pending review
      </StatusChip>,
    )
  } else if (a.requiresReview) {
    // The balance is flagged for review with no receipt counted: the flag still shows.
    chips.push(
      <StatusChip key="review" tone="warn">
        Pending review
      </StatusChip>,
    )
  }

  // The jars this account holds: what they hold of it (the bar) and the rest, or what they hold
  // beyond it (rule 70) in red.
  const jars = accountJars(a, recon, balanceMinor)
  let split: ReactNode = null
  if (jars) {
    const { pct, over, rest } = jars
    split = (
      <div data-testid="account-jars" className={`-mt-1 flex flex-col gap-[9px] max-[699.98px]:mt-0 max-[699.98px]:mr-2.5 max-[699.98px]:mb-0.5 max-[699.98px]:[grid-area:sp]`}>
        {balanceMinor !== null && <MiniBar pct={pct} hue="teal" over={over} size="lg" />}
        {/* One line where it fits; on the narrowest phones the right part moves under the jar
            count (still at the right) rather than running out of the card. */}
        <div
          className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] tabular-nums max-[699.98px]:text-xs ${
            over ? 'font-semibold text-bad' : 'text-slate-500'
          }`}
        >
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <JarNavIcon aria-hidden strokeWidth={1.8} className="size-3.5" style={over ? undefined : { color: hueColor('teal') }} />
            {jars.count} jar{jars.count === 1 ? '' : 's'}
          </span>
          {rest && (
            <span className="ml-auto inline-flex min-w-0 items-center gap-1 text-right">
              {rest.text}
              <InfoHint label={rest.label} buttonClassName={TITLE_HINT} align="end" className={HINT_WRAP}>
                {rest.hint}
              </InfoHint>
            </span>
          )}
        </div>
      </div>
    )
  }

  const balanceReason = a.openingDateMissing ? 'Set an opening date to calculate the balance.' : 'Before the opening date.'
  // On a phone the row has no room for an (i) beside "Not available": its reason is in the note.
  const lines = noteLines(a, recon, budgetCurrency, multiCurrency, phone && balanceMinor === null ? balanceReason : undefined)
  const note: ReactNode = (
    <>
      {lines.map((t, i) => (
        // The space between the lines keeps them apart in the text a screen reader reads. In the
        // ⋯ menu a long line wraps, so the menu stays about the width of its items.
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={phone ? 'block' : 'block max-w-[216px] text-balance'}>{t}</span>
        </Fragment>
      ))}
    </>
  )
  const menuLabel = `${a.name}: more actions`
  // Two accounts may share a name: the ⋯ is also described by the account's type and balance.
  const describedBy = `${typeId} ${balanceId}`
  const menu =
    actions.length > 0 ? (
      phone ? (
        <ActionSheet title={a.name} description={note} actions={actions} open={sheetOpen} onOpenChange={setSheetOpen}>
          <button type="button" data-row-trigger="" aria-label={menuLabel} aria-describedby={describedBy} className={ROW_MENU_TRIGGER}>
            <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
          </button>
        </ActionSheet>
      ) : (
        <RowMenu label={menuLabel} actions={actions} note={note} describedBy={describedBy} />
      )
    ) : (
      // A read-only login has no ⋯: what its note says sits behind an (i) in the same place.
      <span className="inline-grid size-8 place-items-center">
        <InfoHint label={`About ${a.name}`} buttonClassName={TITLE_HINT} align="end">
          {note}
        </InfoHint>
      </span>
    )

  // What sits on a line under the name (who holds it, Private, another currency's code).
  const nameLine = holders.length > 0 || a.isPrivate || otherCurrency
  // Phones lay the row out on a grid: the name's line, then a line for the chips and one for the
  // jar bar, each only when there is one (so no empty line adds its gap). With nothing under the
  // name, the icon reaches into the next line, so that line starts right under the name.
  const extra: string[] = []
  if (chips.length > 0) extra.push('ch')
  if (split) extra.push('sp')
  const areas = ["'ic nm bal more'", ...extra.map((x, i) => `'${i === 0 && !nameLine ? 'ic' : '.'} ${x} ${x} ${x}'`)].join(' ')

  return (
    <article
      aria-labelledby={nameId}
      data-account-id={a.id}
      style={phone ? { gridTemplateAreas: areas } : undefined}
      className={`group/acct relative flex min-w-0 flex-col gap-[18px] rounded-2xl border border-slate-200/70 bg-surface pt-5 pr-5 pb-[22px] pl-[22px] shadow-card transition-shadow hover:shadow-[var(--shadow-frame-lg)] max-[699.98px]:grid max-[699.98px]:grid-cols-[36px_minmax(0,1fr)_auto_40px] max-[699.98px]:items-center max-[699.98px]:gap-x-3 max-[699.98px]:gap-y-3 max-[699.98px]:rounded-none max-[699.98px]:border-0 max-[699.98px]:bg-transparent max-[699.98px]:px-0 max-[699.98px]:py-3.5 max-[699.98px]:shadow-none max-[699.98px]:hover:shadow-none max-[699.98px]:not-first:border-t max-[699.98px]:not-first:border-line`}
    >
      <div className={`flex min-w-0 items-center gap-3.5 max-[699.98px]:contents`}>
        <TypeTile type={a.type} id={typeId} />
        {/* As tall as a name with avatars under it, so a card with none keeps its name and balance
            in line with its neighbours'. */}
        <div
          className={`flex min-h-[50px] min-w-0 flex-1 flex-col items-start gap-1.5 max-[699.98px]:min-h-0 max-[699.98px]:gap-[5px] max-[699.98px]:self-start max-[699.98px]:[grid-area:nm]`}
        >
          {/* The name opens the account; its hit area stretches over the whole card. The heading
              is named by the name alone, the link by "View {name}". */}
          <h3 aria-labelledby={nameId} className={`max-w-full min-w-0 text-base leading-[1.25] font-[650] tracking-[-0.01em] text-slate-900 max-[699.98px]:text-sm`}>
            <Link
              to={`/accounts/${a.id}`}
              state={reconOk ? reconState(a.id, recon) : undefined}
              aria-label={`View ${a.name}`}
              className={`inline-flex max-w-full min-w-0 items-center gap-[3px] align-top after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring focus-visible:after:outline-solid max-[699.98px]:after:rounded-none`}
            >
              <span id={nameId} className="min-w-0 truncate">
                {a.name}
              </span>
              <ChevronRight
                aria-hidden
                strokeWidth={1.8}
                className={`size-[15px] shrink-0 text-slate-400 transition group-hover/acct:translate-x-0.5 group-hover/acct:text-slate-500 max-[699.98px]:size-3.5`}
              />
            </Link>
          </h3>
          {nameLine && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <HolderAvatars account={a} members={members} />
              {a.isPrivate && (
                <StatusChip tone="neutral">
                  <Lock aria-hidden strokeWidth={2} />
                  Private
                </StatusChip>
              )}
              {/* Another currency: why the account is left out of the totals. */}
              {otherCurrency && <StatusChip tone="line">{a.currency}</StatusChip>}
            </div>
          )}
        </div>
        {/* On a phone the ⋯ hangs below the name's line (its bottom margin), so a lone name sets
            the line's height. */}
        <div
          className={`relative z-[2] -mt-1 -mr-2 self-start has-[[role=tooltip]]:z-10 max-[699.98px]:-mt-[7px] max-[699.98px]:-mr-1.5 max-[699.98px]:-mb-4 max-[699.98px]:justify-self-end max-[699.98px]:[grid-area:more]`}
        >
          {menu}
        </div>
      </div>

      <div className={`max-[699.98px]:mt-px max-[699.98px]:self-start max-[699.98px]:justify-self-end max-[699.98px]:[grid-area:bal]`}>
        {balanceMinor === null ? (
          <p className={`flex items-center gap-1 text-base font-semibold whitespace-nowrap text-slate-500 max-[699.98px]:text-sm`}>
            <span id={balanceId}>Not available</span>
            {!phone && (
              <InfoHint label={`Why ${a.name} has no balance`} buttonClassName={TITLE_HINT} align="end" className={HINT_WRAP}>
                {balanceReason}
              </InfoHint>
            )}
          </p>
        ) : (
          <p
            id={balanceId}
            className={`text-[22px] leading-[1.15] font-bold tracking-[-0.02em] whitespace-nowrap tabular-nums max-[699.98px]:text-base max-[699.98px]:tracking-[-0.01em] ${
              balanceMinor < 0 ? 'text-bad' : 'text-slate-900'
            }`}
          >
            {formatMoney(balanceMinor, a.currency)}
          </p>
        )}
      </div>

      {chips.length > 0 && <div className={`-mt-2 flex flex-wrap gap-1.5 max-[699.98px]:mt-0 max-[699.98px]:[grid-area:ch]`}>{chips}</div>}

      {split}
    </article>
  )
}
