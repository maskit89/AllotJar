import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { GoogleSignInButton } from '../components/GoogleSignInButton'
import axios from 'axios'
import { JarLogo } from '../components/Jar'
import { StagingBanner } from '../components/StagingBanner'
import { ThemeToggle } from '../components/ThemeToggle'
import { Button, Card, Input, SegmentedControl, Select } from '../components/ui'
import { CURRENCY_OPTIONS, NUMBER_FORMAT_OPTIONS, currencyNoun, detectLocaleDefaults } from '../lib/money'
import { IS_STAGING } from '../lib/env'
import { safeInternalPath } from '../lib/returnUrl'
import { EVENTS, track } from '../analytics'

export function LoginPage() {
  const { login, register, loginWithGoogle } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Deep links from the landing page ("Create your free account" → /login?register=1)
  // open straight on the registration tab.
  const [mode, setMode] = useState<'login' | 'register'>(
    searchParams.has('register') ? 'register' : 'login',
  )
  // Where to go after signing in (e.g. back to an invite link) — internal paths only.
  const returnUrl = safeInternalPath(searchParams.get('returnUrl'))
  // Set when an expired/revoked session bounced the user here (lib/api.ts sessionExpired), so
  // the page can say WHY they're seeing it instead of looking like an unexplained sign-out.
  const wasExpired = searchParams.get('reason') === 'expired'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  // A welcoming first guess from the visitor's browser locale (fully overridable
  // below); euro / comma-dot stays the fallback. Computed once.
  const [localeDefaults] = useState(detectLocaleDefaults)
  const [currency, setCurrency] = useState(localeDefaults.currency)
  const [numberFormat, setNumberFormat] = useState<string>(localeDefaults.numberFormat)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  // Staging builds require a separate acknowledgment that data may be lost (see StagingBanner).
  const [acceptedStaging, setAcceptedStaging] = useState(false)
  // Opt-in: pre-fill the first month with example figures. Off by default — surprise
  // sample data reads as real data and confuses new users.
  const [includeSampleData, setIncludeSampleData] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Register hit an existing UNVERIFIED email → a claim link was emailed, no session created.
  const [claimPending, setClaimPending] = useState(false)
  // The "or" divider appears only once the Google button has actually rendered, so environments
  // without a client id (or with the script blocked) show the unchanged password-only card.
  const [googleReady, setGoogleReady] = useState(false)

  async function onGoogleCredential(credential: string) {
    setError(null)
    setBusy(true)
    try {
      const { isNewAccount } = await loginWithGoogle(credential)
      track(isNewAccount ? EVENTS.signUp : EVENTS.login, { method: 'google' })
      navigate(returnUrl ?? '/', { replace: true })
    } catch (err) {
      track(EVENTS.loginFailed, { method: 'google' })
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string } | undefined
        setError(data?.error ?? 'Google sign-in failed. Please try again.')
      } else {
        setError('Google sign-in failed. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: 'login' | 'register') {
    setMode(next)
    setError(null)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        const result = await register({
          email,
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          preferredCurrency: currency,
          numberFormat,
          acceptedTerms,
          includeSampleData,
        })
        // The email already had an UNVERIFIED account: no session was created; a claim link was
        // emailed to that address so its true owner can take it over. Show that, don't navigate.
        if (result.verificationPending) {
          setClaimPending(true)
          return
        }
      }
      if (mode === 'login') {
        track(EVENTS.login, { method: 'password' })
      } else {
        track(EVENTS.signUp, { method: 'password', sample_data: includeSampleData })
      }
      navigate(returnUrl ?? '/', { replace: true })
    } catch (err) {
      track(EVENTS.loginFailed, { method: 'password' })
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as
          | { error?: string; errors?: string[] | Record<string, string[]> }
          | undefined
        // `errors` is either an array (ASP.NET Identity composition rules) or an OBJECT of arrays
        // (ValidationProblemDetails, e.g. a required FirstName). Flatten the object shape so it
        // never throws `errors.join is not a function` and silently swallows the error.
        const errors = data?.errors
        const joined = Array.isArray(errors)
          ? errors.join(' ')
          : errors && typeof errors === 'object'
            ? Object.values(errors).flat().join(' ')
            : undefined
        setError(data?.error ?? joined ?? 'Something went wrong.')
      } else {
        setError('Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  const registering = mode === 'register'

  return (
    <>
      <StagingBanner />
      <div className="relative flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <JarLogo lg />
          <h1 className="mt-3 text-[26px] font-extrabold tracking-[-0.035em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">Zero-based budgeting, in your currency.</p>
        </div>

        <Card className="p-8">
          {wasExpired && mode === 'login' && (
            <p
              role="status"
              className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100"
            >
              Your session has expired, so we signed you out to keep your budget safe. Sign back
              in to pick up where you left off.
            </p>
          )}
          {claimPending ? (
            <div role="status" className="space-y-4 text-sm text-slate-600">
              <h2 className="text-base font-semibold text-slate-900">Check your inbox</h2>
              <p>
                An account with <span className="font-medium text-slate-900">{email}</span> already
                exists but hasn't been confirmed. We've emailed a link to that address so its owner
                can confirm it and set a password.
              </p>
              <p>If that's you, follow the link to take it over. If not, you can ignore this.</p>
            </div>
          ) : (
          <>
          {/* Segmented sign-in / register toggle. */}
          <div className="mb-6">
            <SegmentedControl
              ariaLabel="Sign in or create an account"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'login', label: 'Sign in' },
                { value: 'register', label: 'Create account' },
              ]}
            />
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {registering && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="firstName" className="mb-1 block text-sm font-medium text-slate-600">
                    First name
                  </label>
                  <Input
                    id="firstName"
                    type="text"
                    required
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full"
                  />
                </div>
                <div>
                  <label htmlFor="lastName" className="mb-1 block text-sm font-medium text-slate-600">
                    Last name
                  </label>
                  <Input
                    id="lastName"
                    type="text"
                    required
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-600">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full"
              />
            </div>
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <label htmlFor="password" className="block text-sm font-medium text-slate-600">
                  Password
                </label>
                {!registering && (
                  <Link
                    to="/forgot-password"
                    className="text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-500"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete={registering ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full"
              />
            </div>

            {registering && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="currency" className="mb-1 block text-sm font-medium text-slate-600">
                      Currency
                    </label>
                    <Select
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
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
                    <label htmlFor="numberFormat" className="mb-1 block text-sm font-medium text-slate-600">
                      Number format
                    </label>
                    <Select
                      id="numberFormat"
                      value={numberFormat}
                      onChange={(e) => setNumberFormat(e.target.value)}
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
                <p className="text-xs text-slate-500">
                  You can change your currency and number format anytime in account settings.
                </p>

                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={includeSampleData}
                    onChange={(e) => setIncludeSampleData(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
                  />
                  <span>
                    Start with sample figures to explore — example groups and amounts you can edit
                    or delete anytime. Leave unticked to start with an empty budget.
                  </span>
                </label>

                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    required
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
                  />
                  <span>
                    I agree to the{' '}
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand-600 underline hover:text-brand-700 dark:text-brand-500"
                    >
                      Terms of Service
                    </a>{' '}
                    and{' '}
                    <a
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand-600 underline hover:text-brand-700 dark:text-brand-500"
                    >
                      Privacy Policy
                    </a>
                    .
                  </span>
                </label>

                {IS_STAGING && (
                  <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
                    <input
                      type="checkbox"
                      required
                      checked={acceptedStaging}
                      onChange={(e) => setAcceptedStaging(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-2 focus:ring-amber-500/40"
                    />
                    <span>
                      I understand this is the AllotJar <strong className="font-semibold">staging</strong>{' '}
                      test environment, and that my data may be reset or permanently lost.
                    </span>
                  </label>
                )}
              </>
            )}

            {error && (
              <p role="alert" className="text-sm text-rose-600">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          {/* Google sign-in: one button serves both modes (it signs in, or creates the account). */}
          <div className={googleReady ? 'mt-6' : ''}>
            {googleReady && (
              <div className="mb-6 flex items-center gap-3" aria-hidden="true">
                <div className="h-px flex-1 bg-slate-300" />
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">or</span>
                <div className="h-px flex-1 bg-slate-300" />
              </div>
            )}
            <GoogleSignInButton onCredential={onGoogleCredential} onReady={() => setGoogleReady(true)} />
          </div>
          </>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-slate-500">
          Give every {currencyNoun(localeDefaults.currency)} a job.
        </p>
      </div>
      </div>
    </>
  )
}
