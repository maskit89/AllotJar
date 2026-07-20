import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { AppShell } from '../components/AppShell'
import { Button, Card, ErrorBanner, Input, PageHeader, Select } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { CURRENCY_OPTIONS, NUMBER_FORMAT_OPTIONS } from '../lib/money'
import { EVENTS, track } from '../analytics'
import { HOUSEHOLD_ROLE_LABELS } from '../types'

export function AccountPage() {
  const {
    email,
    displayName,
    role,
    firstName,
    lastName,
    preferredCurrency,
    numberFormat,
    households,
    ownsHousehold,
    startOwnBudget,
    leaveHousehold,
    changePassword,
    updatePreferences,
    hasPassword,
    hasGoogle,
    unlinkGoogle,
  } = useAuth()
  const { isShared, members, loading: householdLoading } = useHousehold()
  const navigate = useNavigate()

  // The household currently in view. When it's one the user joined (not their own), they can
  // leave it; when they don't own a household at all, they can start one.
  const activeHousehold = households.find((h) => h.isActive)
  const viewingJoined = activeHousehold ? !activeHousehold.isOwn : false

  const [startBusy, setStartBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

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

  async function onLeaveHousehold() {
    if (!activeHousehold) return
    setLeaveError(null)
    setLeaveBusy(true)
    try {
      await leaveHousehold(activeHousehold.ownerId)
    } catch {
      setLeaveError('Could not leave this household. Please try again.')
      setLeaveBusy(false)
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

  // Hydrate the form once /auth/me resolves the saved preferences into the auth context.
  useEffect(() => {
    setPfFirst(firstName ?? '')
    setPfLast(lastName ?? '')
    setPfCurrency(preferredCurrency)
    setPfFormat(numberFormat)
  }, [firstName, lastName, preferredCurrency, numberFormat])

  async function savePreferences(e: FormEvent) {
    e.preventDefault()
    setPrefError(null)
    setPrefDone(false)
    setPrefBusy(true)
    try {
      await updatePreferences({
        firstName: pfFirst.trim(),
        lastName: pfLast.trim(),
        preferredCurrency: pfCurrency,
        numberFormat: pfFormat,
      })
      setPrefDone(true)
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

  // --- Change password ---
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // --- Disconnect Google ---
  const [unlinkBusy, setUnlinkBusy] = useState(false)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [unlinkDone, setUnlinkDone] = useState(false)

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

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setDone(false)
    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('Use a new password of at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      track(EVENTS.passwordChanged)
      setDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { errors?: string[]; error?: string } | undefined
        setError(data?.error ?? data?.errors?.join(' ') ?? 'Could not change your password.')
      } else {
        setError('Could not change your password.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell maxWidth="4xl">
      <PageHeader title="Account" subtitle="Your details, preferences and password." />

      <Card className="p-5">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Email</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{email}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Name</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{displayName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Access level</dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">{HOUSEHOLD_ROLE_LABELS[role] ?? 'Member'}</dd>
          </div>
        </dl>
      </Card>

      {/* Members who only ever joined someone else's household can start a budget of their own. */}
      {!ownsHousehold && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Your own budget</h2>
          <p className="mb-4 text-sm text-slate-500">
            You’re a member of a shared household. Want a budget of your own too? We’ll create it and
            you can build your first month — blank or from a template — and switch between them
            anytime. The shared budget stays exactly as it is.
          </p>
          {startError && (
            <div className="mb-3">
              <ErrorBanner>{startError}</ErrorBanner>
            </div>
          )}
          <Button onClick={onStartOwnBudget} disabled={startBusy}>
            {startBusy ? 'Setting up…' : 'Start my own budget'}
          </Button>
        </Card>
      )}

      {!householdLoading && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Sharing</h2>
          {isShared ? (
            <>
              <p className="mb-4 text-sm text-slate-500">
                This budget is shared between {members.length}{' '}
                {members.length === 1 ? 'person' : 'people'}. Manage their incomes, savings, sign-ins
                and access on the People page.
              </p>
              <Link
                to="/people"
                className="text-sm font-semibold text-brand-700 hover:text-brand-800 dark:text-brand-200"
              >
                Manage people →
              </Link>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-slate-500">
                You’re budgeting on your own. If you share money with a partner or housemate, you can
                add them to split shared costs and divide savings between you.
              </p>
              <Button onClick={() => navigate('/people')}>Share this budget</Button>
            </>
          )}
        </Card>
      )}

      {/* Self-service "leave" for a household the user joined (never their own). */}
      {viewingJoined && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Leave this household</h2>
          <p className="mb-4 text-sm text-slate-500">
            Remove your access to {activeHousehold?.label ?? 'this household'}. You’ll no longer see its
            budget, and the owner isn’t needed to do this. You can be invited back anytime.
          </p>
          {leaveError && (
            <div className="mb-3">
              <ErrorBanner>{leaveError}</ErrorBanner>
            </div>
          )}
          {confirmLeave ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Are you sure?</span>
              <Button variant="danger" onClick={onLeaveHousehold} disabled={leaveBusy}>
                {leaveBusy ? 'Leaving…' : 'Yes, leave'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setLeaveError(null)
                  setConfirmLeave(false)
                }}
                disabled={leaveBusy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setLeaveError(null)
                setConfirmLeave(true)
              }}
            >
              Leave household
            </Button>
          )}
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">Preferences</h2>
        <p className="mb-4 text-sm text-slate-500">
          Your name and how money is shown across the app. Your currency sets the app-wide default;
          number format controls the decimal and grouping separators.
        </p>
        <form onSubmit={savePreferences} className="max-w-sm space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pf-first" className="mb-1 block text-sm font-medium text-slate-600">
                First name
              </label>
              <Input
                id="pf-first"
                type="text"
                autoComplete="given-name"
                value={pfFirst}
                onChange={(e) => setPfFirst(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="pf-last" className="mb-1 block text-sm font-medium text-slate-600">
                Last name
              </label>
              <Input
                id="pf-last"
                type="text"
                autoComplete="family-name"
                value={pfLast}
                onChange={(e) => setPfLast(e.target.value)}
                className="w-full"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pf-currency" className="mb-1 block text-sm font-medium text-slate-600">
                Currency
              </label>
              <Select
                id="pf-currency"
                value={pfCurrency}
                onChange={(e) => setPfCurrency(e.target.value)}
                className="w-full"
              >
                {CURRENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="pf-format" className="mb-1 block text-sm font-medium text-slate-600">
                Number format
              </label>
              <Select
                id="pf-format"
                value={pfFormat}
                onChange={(e) => setPfFormat(e.target.value)}
                className="w-full"
              >
                {NUMBER_FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {prefError && <ErrorBanner>{prefError}</ErrorBanner>}
          {prefDone && (
            <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              Your preferences have been saved.
            </p>
          )}

          <Button type="submit" disabled={prefBusy}>
            {prefBusy ? 'Saving…' : 'Save preferences'}
          </Button>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold text-slate-700">
          {hasPassword ? 'Change password' : 'Password'}
        </h2>
        {!hasPassword ? (
          // A Google-created login has no password to "change". The forgot-password flow SETS one
          // (reset works for passwordless accounts), which also keeps password login usable if the
          // Google account is ever lost.
          <p className="max-w-sm text-sm text-slate-600">
            You sign in with Google, so this account has no password yet. To add one, use{' '}
            <Link
              to="/forgot-password"
              className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-500"
            >
              Forgot password
            </Link>{' '}
            with this account's email — the emailed link lets you set a password. Signing in with
            Google keeps working either way.
          </p>
        ) : (
        <form onSubmit={onSubmit} className="max-w-sm space-y-4">
          <div>
            <label htmlFor="current" className="mb-1 block text-sm font-medium text-slate-600">
              Current password
            </label>
            <Input
              id="current"
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label htmlFor="next" className="mb-1 block text-sm font-medium text-slate-600">
              New password
            </label>
            <Input
              id="next"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-slate-600">
              Confirm new password
            </label>
            <Input
              id="confirm"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full"
            />
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}
          {done && (
            <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              Your password has been changed.
            </p>
          )}

          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </form>
        )}
      </Card>

      {hasGoogle && (
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Connected accounts</h2>
          <div className="flex max-w-sm items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800">Google</p>
              <p className="text-sm text-slate-500">You can sign in with Google.</p>
            </div>
            <Button
              variant="secondary"
              disabled={unlinkBusy || !hasPassword}
              onClick={onUnlinkGoogle}
              title={
                hasPassword
                  ? undefined
                  : 'Set a password first — Google is currently your only way to sign in.'
              }
            >
              {unlinkBusy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
          {!hasPassword && (
            <p className="mt-3 max-w-sm text-sm text-slate-500">
              Google is your only way to sign in, so it can't be disconnected yet. Add a password
              first via{' '}
              <Link
                to="/forgot-password"
                className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-500"
              >
                Forgot password
              </Link>
              .
            </p>
          )}
          {unlinkError && <ErrorBanner>{unlinkError}</ErrorBanner>}
          {unlinkDone && (
            <p role="status" className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              Google has been disconnected.
            </p>
          )}
        </Card>
      )}
    </AppShell>
  )
}
