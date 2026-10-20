import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Check, ChevronDown, ChevronRight, Ellipsis, House, Lock, LogOut, Pencil, Trash2, X } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, Input, Select } from '../components/ui'
import { InfoHint } from '../components/InfoHint'
import { Skeleton } from '../components/ui/skeleton'
import { MemberAvatar } from '../components/MemberAvatar'
import { StatusChip } from '../components/StatusChip'
import { ActionSheet, ROW_MENU_TRIGGER, RowMenu, type RowAction } from '../components/RowActions'
import { CARD_TITLE, DASH_CARD } from '../components/budget/card'
import { ChangePasswordDialog } from '../components/settings/ChangePasswordDialog'
import { LeaveHouseholdDialog } from '../components/settings/LeaveHouseholdDialog'
import { DeleteAccountDialog, type DeletePreview, type DeleteProof } from '../components/settings/DeleteAccountDialog'
import { DownloadDataCard } from '../components/settings/DownloadDataCard'
import { DevicesCard } from '../components/settings/DevicesCard'
import { PasskeyRows } from '../components/settings/PasskeyRows'
import { GoogleMark, OUTLINE_SM, ROW, ROW_HINT, ROW_TITLE, SAVE_BUTTON, Tile } from '../components/settings/parts'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { CURRENCY_OPTIONS, NUMBER_FORMAT_OPTIONS } from '../lib/money'
import { memberHue } from '../lib/categoryColors'
import { useMediaQuery } from '../lib/useMediaQuery'
import { HOUSEHOLD_ROLE_HINTS, HOUSEHOLD_ROLE_LABELS } from '../types'
import { api, downloadMyData } from '../lib/api'

/** The neutral steel of a sign-in not linked to a person (as the People page draws one). */
const STEEL = 'var(--color-steel)'

/** A small ghost icon button (the pencil, its ✕): 32px, 40px for a finger on a phone. */
const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 max-[699.98px]:size-10 dark:hover:bg-foreground/7 [&_svg]:size-[18px]'

/** A quiet success line (the mock-ups' ok text): 13px, a check before it. */
const OK_LINE = 'flex items-center gap-1.5 text-[13px] leading-[1.45] font-semibold text-ok [&_svg]:size-3.5 [&_svg]:shrink-0'

/** The sentence behind the Currency (i), today's Preferences intro (the part the fields need). */
const SETTINGS_HINT =
  'Your currency is the one your budget and all its accounts use; number format controls the decimal and grouping separators.'
const LOCK_NOTE = 'Your budget currency is fixed once your budget has accounts, months or transactions.'

/**
 * Account settings (/account, the account menu's "Account settings"; restyle PR 12, the approved
 * mock-ups account*.py). No figures, so no KPI row. Wide screens: two columns on the Dashboard's
 * proportions. On the left one card for you and one form, as before: the profile (the avatar as
 * People draws you, the name with a pencil, the access level as a line chip with what it allows
 * behind its (i), the email), then under a hairline Preferences (Currency and Number format, the
 * lock and why behind the Currency (i), and Save). The pencil turns the name into the First name and
 * Last name fields of the same form. On the right: Household (who shares the budget, "Just you"
 * when alone, "Your own budget" for someone with none, Leave household behind the ⋯) and Sign-in
 * (the password, changed in a dialog or set by the forgot-password flow; Google, disconnected from
 * its ⋯) and Your data (Download my data, a zip of all you can see; Delete account, which asks in a
 * dialog for the password, or the email typed). Phones: the same cards in one column.
 *
 * Nothing here is role-gated: every access level edits its own preferences and password, starts a
 * budget of its own and leaves a household it joined.
 */
export function AccountPage() {
  const {
    email,
    displayName,
    role,
    firstName,
    lastName,
    preferredCurrency,
    ownBudgetCurrency,
    currencyLocked,
    numberFormat,
    households,
    ownsHousehold,
    memberId,
    startOwnBudget,
    leaveHousehold,
    deleteAccount,
    updatePreferences,
    hasPassword,
    hasGoogle,
    unlinkGoogle,
  } = useAuth()
  const { isShared, members, loading: householdLoading } = useHousehold()
  const navigate = useNavigate()
  // Phones take a row's actions in a bottom sheet; wider screens in the ⋯ menu.
  const phone = useMediaQuery('(max-width: 699.98px)')

  // The household currently in view. When it's one the user joined (not their own), they can
  // leave it; when they don't own a household at all, they can start one.
  const activeHousehold = households.find((h) => h.isActive)
  const viewingJoined = activeHousehold ? !activeHousehold.isOwn : false
  // A joined household is labelled with its owner's name, or the generic "Household" when the owner
  // has none (AuthController's /auth/me). Only a name reads as "Alex’s household".
  const ownerName = activeHousehold?.label && activeHousehold.label !== 'Household' ? activeHousehold.label : null

  // --- Your own budget ---
  const [startBusy, setStartBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  async function onStartOwnBudget() {
    setStartError(null)
    setStartBusy(true)
    try {
      await startOwnBudget()
    } catch {
      setStartError('Could not start your budget. Please try again.')
      setStartBusy(false)
    }
    // On success the app re-bootstraps (full navigation), so no need to reset busy.
  }

  // --- Leave household (asks first, in a dialog) ---
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  // D4: how many of this login's accounts there are private (null until known). Leaving makes them
  // reachable by nobody, and the owner may then erase them, so the dialog says how many.
  const [leavePrivate, setLeavePrivate] = useState<number | null>(null)

  async function askToLeave() {
    if (!activeHousehold) return
    setLeaveError(null)
    setLeavePrivate(null)
    setConfirmLeave(true)
    const ownerId = activeHousehold.ownerId
    try {
      const { data } = await api.get<{ privateAccounts: number }>(
        `/households/leave-preview?ownerId=${encodeURIComponent(ownerId)}`,
      )
      if (typeof data?.privateAccounts === 'number') setLeavePrivate(data.privateAccounts)
    } catch {
      // The leave itself is refused with the count if this read failed and there are some.
    }
  }

  async function onLeaveHousehold() {
    if (!activeHousehold) return
    setLeaveError(null)
    setLeaveBusy(true)
    try {
      await leaveHousehold(activeHousehold.ownerId, leavePrivate ?? 0)
    } catch (err) {
      const data = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string; privateAccounts?: number } | undefined)
        : undefined
      if (axios.isAxiosError(err) && err.response?.status === 409 && typeof data?.privateAccounts === 'number') {
        // More private accounts than the warning said (or the count couldn't be read): show it.
        setLeavePrivate(data.privateAccounts)
      } else {
        setLeaveError('Could not leave this household. Please try again.')
      }
      setLeaveBusy(false)
    }
  }

  function closeLeave() {
    setLeaveError(null)
    setConfirmLeave(false)
  }

  // --- Delete account (asks first, in a dialog; the password, or the email typed, guards it) ---
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null)

  async function askToDelete() {
    setDeleteError(null)
    setDeletePreview(null)
    setConfirmDelete(true)
    try {
      const { data } = await api.get<DeletePreview>('/auth/delete-preview')
      if (data && typeof data.ownsHousehold === 'boolean') setDeletePreview(data)
    } catch {
      // The dialog then names only the sign-in; the delete itself doesn't depend on this read.
    }
  }

  // The dialog's "Download my data first" (fix 4's zip), one at a time.
  const downloading = useRef(false)
  async function onDownloadFirst() {
    if (downloading.current) return
    downloading.current = true
    setDeleteError(null)
    try {
      await downloadMyData()
    } catch {
      setDeleteError('Could not prepare your download. Please try again.')
    } finally {
      downloading.current = false
    }
  }

  async function onDeleteAccount(proof: DeleteProof) {
    setDeleteError(null)
    setDeleteBusy(true)
    try {
      await deleteAccount(proof)
      // On success the app leaves for the sign-in page (full navigation).
    } catch (err) {
      setDeleteError(deleteRefusal(err) ?? 'Could not delete your account. Please try again.')
      setDeleteBusy(false)
    }
  }

  // --- Preferences (name + money display) ---
  const [pfFirst, setPfFirst] = useState(firstName ?? '')
  const [pfLast, setPfLast] = useState(lastName ?? '')
  const [pfCurrency, setPfCurrency] = useState(preferredCurrency)
  const [pfFormat, setPfFormat] = useState(numberFormat)
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)
  const [prefDone, setPrefDone] = useState(false)
  // The pencil: the name becomes the First name and Last name fields of the same form.
  const [editingName, setEditingName] = useState(false)
  const pencilRef = useRef<HTMLButtonElement>(null)
  const namesRef = useRef<HTMLDivElement>(null)
  // Where focus goes once the name editor has opened or closed (it unmounts what held focus).
  const focusAfter = useRef<'first' | 'pencil' | null>(null)

  // Hydrate the form once /auth/me resolves the saved preferences into the auth context.
  useEffect(() => {
    setPfFirst(firstName ?? '')
    setPfLast(lastName ?? '')
    setPfCurrency(preferredCurrency)
    setPfFormat(numberFormat)
  }, [firstName, lastName, preferredCurrency, numberFormat])

  useLayoutEffect(() => {
    const to = focusAfter.current
    if (!to) return
    focusAfter.current = null
    if (to === 'first') document.getElementById('pf-first')?.focus()
    else pencilRef.current?.focus()
  }, [editingName])

  function editName() {
    focusAfter.current = 'first'
    setEditingName(true)
  }

  function cancelEditName() {
    setPfFirst(firstName ?? '')
    setPfLast(lastName ?? '')
    focusAfter.current = 'pencil'
    setEditingName(false)
  }

  async function savePreferences(e: FormEvent) {
    e.preventDefault()
    setPrefError(null)
    setPrefDone(false)
    setPrefBusy(true)
    try {
      await updatePreferences({
        firstName: pfFirst.trim(),
        lastName: pfLast.trim(),
        preferredCurrency: currencyLocked ? preferredCurrency : pfCurrency,
        numberFormat: pfFormat,
      })
      setPrefDone(true)
      // Saved: the heading shows the new name again. Focus left in a name field goes to the pencil.
      if (editingName) {
        if (namesRef.current?.contains(document.activeElement)) focusAfter.current = 'pencil'
        setEditingName(false)
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { errors?: string[]; error?: string } | undefined
        setPrefError(data?.error ?? data?.errors?.join(' ') ?? 'Could not save your preferences.')
      } else {
        setPrefError('Could not save your preferences.')
      }
    } finally {
      setPrefBusy(false)
    }
  }

  // --- Change password (a dialog) ---
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordDone, setPasswordDone] = useState(false)

  // --- Disconnect Google ---
  const [unlinkBusy, setUnlinkBusy] = useState(false)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [unlinkDone, setUnlinkDone] = useState(false)
  const unlinkLine = useRef<HTMLParagraphElement>(null)

  async function onUnlinkGoogle() {
    setUnlinkError(null)
    setUnlinkDone(false)
    setUnlinkBusy(true)
    try {
      await unlinkGoogle()
      setUnlinkDone(true)
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string } | undefined
        setUnlinkError(data?.error ?? 'Could not disconnect Google. Please try again.')
      } else {
        setUnlinkError('Could not disconnect Google. Please try again.')
      }
    } finally {
      setUnlinkBusy(false)
    }
  }

  // The Google row (and its ⋯, which held focus) goes once Google is disconnected: focus moves to
  // the line that says so, at the foot of the Sign-in card.
  useEffect(() => {
    if (unlinkDone && !hasGoogle && (!document.activeElement || document.activeElement === document.body)) {
      unlinkLine.current?.focus()
    }
  }, [unlinkDone, hasGoogle])

  // --- Who you are ---
  const name = displayName || email || ''
  const meIndex = memberId ? members.findIndex((m) => m.id === memberId) : -1
  // Your colour is your place among the household's people, so it waits for /members (a login not
  // linked to a person is steel at once). If /members fails, steel too: no colour can be known.
  const avatarPending = householdLoading && !!memberId
  const roleLabel = HOUSEHOLD_ROLE_LABELS[role] ?? 'Member'
  const roleHint = HOUSEHOLD_ROLE_HINTS[role]
  const lockedLabel = CURRENCY_OPTIONS.find((o) => o.value === ownBudgetCurrency)?.label ?? ownBudgetCurrency

  // The Household card shows once it has something to show: the sharing row waits for /members,
  // "Your own budget" and the ⋯ (Leave household) do not.
  const showHousehold = !householdLoading || !ownsHousehold || viewingJoined

  const householdActions: RowAction[] = viewingJoined
    ? [
        {
          key: 'leave',
          label: 'Leave household',
          icon: <LogOut aria-hidden strokeWidth={1.8} />,
          danger: true,
          after: 'dialog',
          onSelect: () => void askToLeave(),
        },
      ]
    : []

  const googleOnlyWayIn = !hasPassword
  const googleActions: RowAction[] = [
    {
      key: 'disconnect',
      label: 'Disconnect',
      icon: <X aria-hidden strokeWidth={1.8} />,
      // Disabled reads grey, not red: it can't be done yet.
      danger: !googleOnlyWayIn && !unlinkBusy,
      disabled: googleOnlyWayIn || unlinkBusy,
      note: googleOnlyWayIn ? "Google is your only way to sign in, so it can't be disconnected yet. Set a password first." : undefined,
      onSelect: () => void onUnlinkGoogle(),
    },
  ]

  return (
    <AppShell active="account" title="Account settings">
      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          {/* You: one card, one form (the profile's name fields and the preferences save together). */}
          <section aria-label="Your account" className={`${DASH_CARD} p-0!`}>
            <form onSubmit={savePreferences}>
              {editingName ? (
                <div className="flex items-end gap-5 px-6 pt-6 pb-[22px] max-[699.98px]:gap-2 max-[699.98px]:px-[18px] max-[699.98px]:pt-[18px] max-[699.98px]:pb-4">
                  {/* A phone needs the width for the fields: the avatar steps aside while editing. */}
                  <div className="self-center max-[699.98px]:hidden">
                    <ProfileAvatar name={name} hue={meIndex} pending={avatarPending} />
                  </div>
                  <div
                    ref={namesRef}
                    className="grid min-w-0 flex-1 grid-cols-2 gap-4 max-[699.98px]:gap-2.5"
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return
                      e.preventDefault()
                      cancelEditName()
                    }}
                  >
                    <div className="auth-f">
                      <div className="auth-lr">
                        <label htmlFor="pf-first" className="auth-label">
                          First name
                        </label>
                      </div>
                      <Input
                        id="pf-first"
                        type="text"
                        autoComplete="given-name"
                        value={pfFirst}
                        onChange={(e) => setPfFirst(e.target.value)}
                        className="auth-in"
                      />
                    </div>
                    <div className="auth-f">
                      <div className="auth-lr">
                        <label htmlFor="pf-last" className="auth-label">
                          Last name
                        </label>
                      </div>
                      <Input
                        id="pf-last"
                        type="text"
                        autoComplete="family-name"
                        value={pfLast}
                        onChange={(e) => setPfLast(e.target.value)}
                        className="auth-in"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={cancelEditName}
                    aria-label="Cancel edit"
                    className={`${ICON_BUTTON} -mr-2 mb-1.5 max-[699.98px]:mr-[-10px] max-[699.98px]:mb-0.5 max-[699.98px]:self-start`}
                  >
                    <X aria-hidden strokeWidth={1.8} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-5 px-6 pt-6 pb-[22px] max-[699.98px]:gap-4 max-[699.98px]:px-[18px] max-[699.98px]:pt-[18px] max-[699.98px]:pb-4">
                  <ProfileAvatar name={name} hue={meIndex} pending={avatarPending} />
                  <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                    {/* Never cut: a name too long for the line takes it whole and the access level drops
                        under it; a name longer than the line wraps. */}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 max-[699.98px]:gap-x-2">
                      <h2 className="min-w-0 text-[22px] leading-[1.2] font-bold tracking-[-0.02em] [overflow-wrap:anywhere] text-slate-900 max-[699.98px]:text-lg">
                        {/* No name yet: the email is who you are (shown once, so no line under it). */}
                        {displayName || <Email address={email} />}
                      </h2>
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-slate-500">
                        {/* The role in its own element, so its text is exactly the role. */}
                        <StatusChip tone="line">
                          <span className="sr-only">Access level: </span>
                          <span>{roleLabel}</span>
                        </StatusChip>
                        {roleHint && (
                          <InfoHint label="About access level" buttonClassName={ROW_HINT}>
                            {roleHint}
                          </InfoHint>
                        )}
                      </span>
                    </div>
                    {displayName && (
                      <span className="text-sm [overflow-wrap:anywhere] text-slate-500">
                        <Email address={email} />
                      </span>
                    )}
                  </div>
                  <button
                    ref={pencilRef}
                    type="button"
                    onClick={editName}
                    aria-label="Edit name"
                    className={`${ICON_BUTTON} -mr-2 max-[699.98px]:-mt-2 max-[699.98px]:mr-[-10px] max-[699.98px]:self-start`}
                  >
                    <Pencil aria-hidden strokeWidth={1.8} />
                  </button>
                </div>
              )}

              <div className="border-t border-line px-6 pt-5 pb-6 max-[699.98px]:px-[18px] max-[699.98px]:pt-4 max-[699.98px]:pb-[18px]">
                <h2 className={`mb-3.5 flex min-h-8 items-center ${CARD_TITLE}`}>Preferences</h2>
                <div className="flex flex-col gap-5 max-[699.98px]:gap-[18px]">
                  <div className="grid grid-cols-2 gap-4 max-[699.98px]:gap-2.5">
                    <div className="auth-f">
                      <div className="auth-lr">
                        <span className="auth-lt">
                          <label htmlFor="pf-currency" className="auth-label">
                            Currency
                          </label>
                          {/* Outside the label and named without the field's word, so Currency keeps one label. */}
                          {/* Raised over the field just below, which would otherwise take the bottom of its 40px hit area. */}
                          <InfoHint label={currencyLocked ? 'About the lock' : 'About these settings'} buttonClassName={`${ROW_HINT} z-[1]`}>
                            {currencyLocked ? (
                              <>
                                {LOCK_NOTE} {SETTINGS_HINT}
                              </>
                            ) : (
                              SETTINGS_HINT
                            )}
                          </InfoHint>
                        </span>
                      </div>
                      {currencyLocked ? (
                        // The login's own budget already has accounts, months or transactions in this
                        // currency, and the app never converts amounts, so the currency is shown but can't
                        // be changed. It shows that household's budget currency (its first month's, rule
                        // 85), which the note names; on older data that can differ from the login's saved
                        // preference. Read-only: no fill and muted text, a field's edge, and a lock.
                        <LockedCurrency code={ownBudgetCurrency} label={lockedLabel} />
                      ) : (
                        <div className="auth-sel">
                          <Select id="pf-currency" value={pfCurrency} onChange={(e) => setPfCurrency(e.target.value)} className="auth-in">
                            {CURRENCY_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                          <ChevronDown aria-hidden strokeWidth={1.8} />
                        </div>
                      )}
                    </div>
                    <div className="auth-f">
                      <div className="auth-lr">
                        <label htmlFor="pf-format" className="auth-label">
                          Number format
                        </label>
                      </div>
                      <div className="auth-sel">
                        <Select id="pf-format" value={pfFormat} onChange={(e) => setPfFormat(e.target.value)} className="auth-in">
                          {NUMBER_FORMAT_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                        <ChevronDown aria-hidden strokeWidth={1.8} />
                      </div>
                    </div>
                  </div>

                  {prefError && (
                    <p role="alert" className="auth-error">
                      {prefError}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2.5 max-[699.98px]:flex-col max-[699.98px]:items-stretch">
                    {prefDone && (
                      <p role="status" className={`${OK_LINE} max-[699.98px]:justify-center`}>
                        <Check aria-hidden strokeWidth={2} />
                        Your preferences have been saved.
                      </p>
                    )}
                    {/* Visible "Save", heard as "Save preferences" (the card's title says what it saves). */}
                    <Button type="submit" disabled={prefBusy} aria-label={prefBusy ? undefined : 'Save preferences'} className={SAVE_BUTTON}>
                      {prefBusy ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          </section>

          <div className="flex min-w-0 flex-col gap-4 min-[700px]:gap-6">
            {showHousehold && (
              <section aria-labelledby="as-household" className={DASH_CARD}>
                <div className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
                  <h2 id="as-household" className={CARD_TITLE}>
                    Household
                  </h2>
                  {householdActions.length > 0 && (
                    <span className="-mr-2 max-[699.98px]:-mr-3">
                      <RowActionsMenu
                        phone={phone}
                        label="Household: more actions"
                        title={ownerName ? `${ownerName}’s household` : 'This household'}
                        actions={householdActions}
                      />
                    </span>
                  )}
                </div>
                <div className="flex flex-col">
                  {householdLoading ? (
                    // The people are still loading: a quiet row holds the sharing row's place, so the
                    // rows under it (Start) don't move when it arrives.
                    <div aria-hidden className={ROW}>
                      <Skeleton className="size-8 shrink-0 rounded-full" />
                      <Skeleton className="h-3.5 w-24 rounded-full" />
                    </div>
                  ) : isShared ? (
                    // Who shares the budget: their faces and names. The whole row is one link to People.
                    <div className={`${ROW} group relative`}>
                      <Faces names={members.map((m) => m.name)} label={`Shared between ${members.length} people`} />
                      <span className={`${ROW_TITLE} min-w-0 flex-1`}>{joinNames(members.map((m) => m.name))}</span>
                      <Link
                        to="/people"
                        aria-label="Manage people"
                        className="-mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 transition group-hover:text-slate-500 after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:outline-none! focus-visible:after:shadow-[0_0_0_2px_var(--color-ring)] max-[699.98px]:mr-[-10px]"
                      >
                        <ChevronRight aria-hidden strokeWidth={1.8} className="size-[18px] transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </div>
                  ) : (
                    <div className={ROW}>
                      <Faces
                        names={members.length > 0 ? members.map((m) => m.name) : [name]}
                        // No person yet (a brand-new budget): you, as the profile draws you.
                        steel={members.length === 0}
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-1">
                        <span className={ROW_TITLE}>Just you</span>
                        <InfoHint label="About sharing" buttonClassName={ROW_HINT} align="end" fixed>
                          You’re budgeting on your own. If you share money with a partner or housemate, you can add
                          them to split shared costs and divide savings between you.
                        </InfoHint>
                      </span>
                      <button type="button" onClick={() => navigate('/people')} className={OUTLINE_SM}>
                        Share this budget
                      </button>
                    </div>
                  )}
                  {/* Members who only ever joined someone else's household can start a budget of their own. */}
                  {!ownsHousehold && (
                    <div className={`${ROW} flex-wrap`}>
                      <Tile color="var(--color-cat-emerald)">
                        <House strokeWidth={1.8} />
                      </Tile>
                      <span className="flex min-w-0 flex-1 items-center gap-1">
                        <h3 className={ROW_TITLE}>Your own budget</h3>
                        <InfoHint label="About your own budget" buttonClassName={ROW_HINT} align="end" fixed>
                          You’re a member of a shared household. Want a budget of your own too? We’ll create it and you can
                          build your first month — blank or from a template — and switch between them anytime. The shared
                          budget stays exactly as it is.
                        </InfoHint>
                      </span>
                      <button
                        type="button"
                        onClick={onStartOwnBudget}
                        disabled={startBusy}
                        // Visible "Start", heard as the full action; while busy the visible words are the name.
                        aria-label={startBusy ? undefined : 'Start my own budget'}
                        className={OUTLINE_SM}
                      >
                        {startBusy ? 'Setting up…' : 'Start'}
                      </button>
                      {startError && (
                        <p role="alert" className="auth-error basis-full pl-11">
                          {startError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            <section aria-labelledby="as-signin" className={DASH_CARD}>
              <h2 id="as-signin" className={`mb-3.5 flex min-h-8 items-center ${CARD_TITLE}`}>
                Sign-in
              </h2>
              <div className="flex flex-col">
                {/* At the narrowest widths (320px) the action drops to its own line rather than cut the title. */}
                <div className={`${ROW} flex-wrap`}>
                  <Tile color={STEEL}>
                    <Lock strokeWidth={1.8} />
                  </Tile>
                  <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1">
                      <h3 className={ROW_TITLE}>Password</h3>
                      {!hasPassword && (
                        // A Google-created login has no password to "change". The forgot-password flow SETS
                        // one (reset works for passwordless accounts), which also keeps password sign-in
                        // usable if the Google account is ever lost.
                        <InfoHint label="About the password" buttonClassName={ROW_HINT} align="end" fixed>
                          You sign in with Google, so this account has no password yet. To add one, use Forgot password
                          with this account's email — the emailed link lets you set a password. Signing in with Google
                          keeps working either way.
                        </InfoHint>
                      )}
                    </span>
                    {passwordDone && (
                      // Takes the column's width without widening it, so only the title decides the wrap.
                      <p role="status" className={`${OK_LINE} w-0 min-w-full`}>
                        <Check aria-hidden strokeWidth={2} />
                        Your password has been changed.
                      </p>
                    )}
                  </div>
                  {hasPassword ? (
                    <button type="button" onClick={() => setChangingPassword(true)} aria-label="Change password" className={`${OUTLINE_SM} ml-auto`}>
                      Change
                    </button>
                  ) : (
                    <Link to="/forgot-password" className={`${OUTLINE_SM} ml-auto`}>
                      Set a password
                    </Link>
                  )}
                </div>
                {hasGoogle && (
                  <div className={ROW}>
                    <Tile color={STEEL} tint="10%">
                      <GoogleMark />
                    </Tile>
                    <h3 className={`${ROW_TITLE} min-w-0 flex-1`}>Google</h3>
                    {unlinkBusy ? (
                      <StatusChip tone="neutral">Disconnecting…</StatusChip>
                    ) : (
                      <StatusChip tone="ok">
                        <Check aria-hidden strokeWidth={2} />
                        Connected
                      </StatusChip>
                    )}
                    <span className="-mr-2 max-[699.98px]:-mr-3">
                      <RowActionsMenu phone={phone} label="Google: more actions" title="Google" actions={googleActions} />
                    </span>
                  </div>
                )}
                <PasskeyRows />
              </div>
              {/* Disconnecting's outcome, outside the Google row, which goes once Google is disconnected. */}
              {unlinkError && (
                <p role="alert" className="auth-error mt-2">
                  {unlinkError}
                </p>
              )}
              {unlinkDone && (
                <p ref={unlinkLine} tabIndex={-1} role="status" className={`${OK_LINE} mt-2 outline-none!`}>
                  <Check aria-hidden strokeWidth={2} />
                  Google has been disconnected.
                </p>
              )}
            </section>

            <DevicesCard />

            <DownloadDataCard>
              <div className={ROW}>
                <Tile color="var(--color-bad)" tint="10%">
                  <Trash2 strokeWidth={1.8} />
                </Tile>
                <h3 className={`${ROW_TITLE} min-w-0 flex-1`}>Delete account</h3>
                <button type="button" onClick={() => void askToDelete()} aria-label="Delete account" className={`${OUTLINE_SM} ml-auto text-bad!`}>
                  Delete
                </button>
              </div>
            </DownloadDataCard>
          </div>
        </div>
      </div>

      {changingPassword && (
        <ChangePasswordDialog
          onClose={() => setChangingPassword(false)}
          onAttempt={() => setPasswordDone(false)}
          onChanged={() => {
            setPasswordDone(true)
            setChangingPassword(false)
          }}
        />
      )}

      {confirmDelete && email && (
        <DeleteAccountDialog
          email={email}
          hasPassword={hasPassword}
          preview={deletePreview}
          busy={deleteBusy}
          error={deleteError}
          onDelete={(proof) => void onDeleteAccount(proof)}
          onClose={() => setConfirmDelete(false)}
          onDownload={() => void onDownloadFirst()}
        />
      )}

      {confirmLeave && viewingJoined && (
        <LeaveHouseholdDialog
          ownerName={ownerName}
          privateAccounts={leavePrivate}
          busy={leaveBusy}
          error={leaveError}
          onLeave={onLeaveHousehold}
          onClose={closeLeave}
        />
      )}
    </AppShell>
  )
}

/**
 * You, as People draws you: your colour when the login is a person of the household, else steel.
 * `pending`: the people are still loading, so a quiet placeholder holds the place (no colour yet).
 */
function ProfileAvatar({ name, hue, pending = false }: { name: string; hue: number; pending?: boolean }) {
  if (pending) return <Skeleton aria-hidden className="size-16 shrink-0 rounded-full max-[699.98px]:size-14" />
  return (
    <MemberAvatar
      name={name || '?'}
      hue={memberHue(Math.max(hue, 0))}
      color={hue < 0 ? STEEL : undefined}
      className="size-16 shrink-0 text-[22px] max-[699.98px]:size-14 max-[699.98px]:text-lg"
    />
  )
}

/**
 * The locked currency, read-only (no picker can show more of it): its name ("New Zealand dollar
 * (NZ$)") when that fits the field, else its code and symbol ("NZD (NZ$)"), so a phone's half-width
 * field never cuts the symbol off. Measured against the field's own font whenever its width changes.
 */
function LockedCurrency({ code, label }: { code: string; label: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [short, setShort] = useState(false)
  const symbol = /\(([^)]+)\)\s*$/.exec(label)?.[1]
  const brief = symbol && symbol !== code ? `${code} (${symbol})` : code

  useLayoutEffect(() => {
    const input = wrap.current?.querySelector('input')
    if (!input) return
    let ctx: CanvasRenderingContext2D | null = null
    function measure() {
      if (!input) return
      const cs = getComputedStyle(input)
      const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      // Nothing laid out to measure against (a test's DOM): the name, as the field always showed.
      if (!(room > 0)) return setShort(false)
      ctx ??= document.createElement('canvas').getContext('2d')
      if (!ctx) return
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      setShort(ctx.measureText(label).width > room)
    }
    let live = true
    measure()
    // Again once the page's font has loaded (the fallback drawn until then is wider).
    void document.fonts?.ready.then(() => live && measure())
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(input)
    return () => {
      live = false
      observer?.disconnect()
    }
  }, [label])

  return (
    <div ref={wrap} className="relative">
      <Input
        id="pf-currency"
        readOnly
        value={short ? brief : label}
        aria-describedby="pf-currency-note"
        className="auth-in cursor-default! border-[color-mix(in_srgb,var(--color-slate-400)_80%,var(--color-card))]! bg-transparent! pr-[38px]! text-ellipsis text-slate-500!"
      />
      <Lock aria-hidden strokeWidth={1.8} className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-500" />
      {/* The note the (i) shows, kept as the field's description for a screen reader. */}
      <span id="pf-currency-note" className="sr-only">
        {LOCK_NOTE}
      </span>
    </div>
  )
}

/** An email that, when it needs two lines, breaks after its "@" (else anywhere, as its line allows). */
function Email({ address }: { address: string | null }) {
  const at = address?.lastIndexOf('@') ?? -1
  if (!address || at < 0) return <>{address}</>
  return (
    <>
      {address.slice(0, at + 1)}
      <wbr />
      {address.slice(at + 1)}
    </>
  )
}

/** "Alex & Sam", "Alex, Sam & Robin": who shares the budget, by name. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

/** Who shares the budget: overlapping faces (each later one ringed in the card's colour). */
function Faces({ names, label, steel = false }: { names: string[]; label?: string; steel?: boolean }) {
  return (
    <span className="flex shrink-0" {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {names.map((n, i) => (
        <span key={i} className="flex rounded-full not-first:-ml-[9px] not-first:shadow-[0_0_0_2px_var(--color-card)]">
          <MemberAvatar name={n} hue={memberHue(i)} color={steel ? STEEL : undefined} className="size-8 text-[13px]" />
        </span>
      ))}
    </span>
  )
}

/** A row's rarely used actions: a ⋯ menu on wider screens, a bottom sheet on a phone (as People's rows). */
function RowActionsMenu({ phone, label, title, actions }: { phone: boolean; label: string; title: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false)
  if (!phone) return <RowMenu label={label} actions={actions} />
  return (
    <ActionSheet title={title} actions={actions} open={open} onOpenChange={setOpen}>
      <button type="button" data-row-trigger="" aria-label={label} className={ROW_MENU_TRIGGER}>
        <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
      </button>
    </ActionSheet>
  )
}

/**
 * The server's own words for a refused delete: `error` (a wrong password, others still sharing the
 * budget), or the first of a validation body's `errors` (a list, or lists by field).
 */
function deleteRefusal(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null
  const data = err.response?.data as { error?: string; errors?: string[] | Record<string, string[]> } | undefined
  if (typeof data?.error === 'string') return data.error
  const errors = data?.errors
  if (Array.isArray(errors)) return errors[0] ?? null
  if (errors && typeof errors === 'object') return Object.values(errors).flat()[0] ?? null
  return null
}
