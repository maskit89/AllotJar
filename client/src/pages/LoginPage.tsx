import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, KeyRound } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { GoogleSignInButton } from '../components/GoogleSignInButton'
import { PasskeyStep } from '../components/PasskeyStep'
import { passkeyError, passkeysSupported, type SecondStep } from '../lib/passkeys'
import axios from 'axios'
import { AuthFrame, AuthTitle } from '../components/AuthFrame'
import { useSubmitFocusReturn } from '../lib/useSubmitFocusReturn'
import { InfoHint } from '../components/InfoHint'
import { Button, Input, SegmentedControl, Select } from '../components/ui'
import { CURRENCY_OPTIONS, NUMBER_FORMAT_OPTIONS, detectLocaleDefaults } from '../lib/money'
import { IS_STAGING } from '../lib/env'
import { safeInternalPath } from '../lib/returnUrl'
import { EVENTS, track } from '../analytics'

export function LoginPage() {
  const { login, register, loginWithGoogle, signInWithPasskey } = useAuth()
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
  // Set after the login deleted itself (AuthContext deleteAccount).
  const wasDeleted = searchParams.get('reason') === 'deleted'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  // Euro preselected; the number format guessed from the visitor's browser locale
  // (both fully overridable below). Computed once.
  const [localeDefaults] = useState(detectLocaleDefaults)
  const [currency, setCurrency] = useState(localeDefaults.currency)
  const [numberFormat, setNumberFormat] = useState<string>(localeDefaults.numberFormat)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  // Staging builds require a separate acknowledgment that data may be lost (see StagingBanner).
  const [acceptedStaging, setAcceptedStaging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Register hit an existing UNVERIFIED email → a claim link was emailed, no session created.
  const [claimPending, setClaimPending] = useState(false)
  // The "or" divider appears only once the Google button has actually rendered, so environments
  // without a client id (or with the script blocked) show the unchanged password-only card.
  const [googleReady, setGoogleReady] = useState(false)
  // The submit is disabled while busy, which drops keyboard focus; it comes back when an error shows.
  const formRef = useSubmitFocusReturn(busy)
  // The password or Google was right, and the login's passkey answers next (fix 14).
  const [secondStep, setSecondStep] = useState<{ step: SecondStep; method: 'password' | 'google' } | null>(null)
  // Only where the browser can use a passkey at all; computed once.
  const [canUsePasskey] = useState(passkeysSupported)

  function signedIn(method: 'password' | 'google' | 'passkey') {
    track(EVENTS.login, { method })
    navigate(returnUrl ?? '/', { replace: true })
  }

  async function onPasskeySignIn() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await signInWithPasskey()
      signedIn('passkey')
    } catch (err) {
      const message = passkeyError(err)
      if (message) {
        track(EVENTS.loginFailed, { method: 'passkey' })
        setError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function onGoogleCredential(credential: string) {
    setError(null)
    setBusy(true)
    try {
      const { isNewAccount, secondStep: step } = await loginWithGoogle(credential)
      if (step) {
        setSecondStep({ step, method: 'google' })
        return
      }
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
        const { secondStep: step } = await login(email, password)
        if (step) {
          setSecondStep({ step, method: 'password' })
          return
        }
      } else {
        const result = await register({
          email,
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          preferredCurrency: currency,
          numberFormat,
          acceptedTerms,
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
        track(EVENTS.signUp, { method: 'password' })
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

  function chooseDifferentEmail() {
    setClaimPending(false)
    // The form is back on the next render: put the caret where the new address goes.
    requestAnimationFrame(() => document.getElementById('email')?.focus())
  }

  return (
    <AuthFrame srTitle={registering ? 'Create your AllotJar account' : 'Sign in to AllotJar'} dense={registering}>
      {wasExpired && mode === 'login' && (
        // One quiet line; why it happened is behind the (i) (the line's own words stay the status).
        <div className="auth-note auth-note-line">
          <p role="status">Your session has expired.</p>
          <InfoHint label="Why you were signed out" buttonClassName="auth-i" align="end">
            Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where
            you left off.
          </InfoHint>
        </div>
      )}
      {wasDeleted && mode === 'login' && (
        <div className="auth-note auth-note-line">
          <p role="status">Your account has been deleted.</p>
        </div>
      )}
      {secondStep ? (
        <PasskeyStep
          step={secondStep.step}
          onSignedIn={() => signedIn(secondStep.method)}
          onRestart={() => {
            setSecondStep(null)
            setPassword('')
          }}
        />
      ) : claimPending ? (
        <div role="status" className="auth-form">
          <AuthTitle
            as="h2"
            focusOnMount
            hint={
              <InfoHint label="What to do next" buttonClassName="auth-i" align="end">
                If that's you, follow the link to take it over. If not, you can ignore this.
              </InfoHint>
            }
          >
            Check your inbox
          </AuthTitle>
          <p className="auth-sub">
            An account with <b>{email}</b> already exists but hasn't been confirmed. We've emailed a link to
            that address so its owner can confirm it and set a password.
          </p>
          <div className="auth-foot">
            <button type="button" onClick={chooseDifferentEmail} className="auth-link">
              Use a different email
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* The two modes, one tap apart. Switching keeps what was typed and leaves the URL alone. */}
          <SegmentedControl
            variant="quiet"
            fill
            ariaLabel="Sign in or create an account"
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'login', label: 'Sign in' },
              { value: 'register', label: 'Create account' },
            ]}
          />

          <form ref={formRef} onSubmit={onSubmit} className="auth-form">
            {registering && (
              <div className="auth-2">
                <div className="auth-f">
                  <label htmlFor="firstName" className="auth-label">
                    First name
                  </label>
                  <Input
                    id="firstName"
                    type="text"
                    required
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="auth-in"
                  />
                </div>
                <div className="auth-f">
                  <label htmlFor="lastName" className="auth-label">
                    Last name
                  </label>
                  <Input
                    id="lastName"
                    type="text"
                    required
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="auth-in"
                  />
                </div>
              </div>
            )}

            <div className="auth-f">
              <label htmlFor="email" className="auth-label">
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
                className="auth-in"
              />
            </div>
            <div className="auth-f">
              <div className="auth-lr">
                <label htmlFor="password" className="auth-label">
                  Password
                </label>
                {!registering && (
                  <Link to="/forgot-password" className="auth-link">
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
                className="auth-in"
              />
            </div>

            {registering && (
              <>
                <div className="auth-2">
                  <div className="auth-f">
                    <div className="auth-lr">
                      <span className="auth-lt">
                        <label htmlFor="currency" className="auth-label">
                          Currency
                        </label>
                        {/* Outside the label, and named without the field's own words, so the
                            Currency field keeps its one label. */}
                        <InfoHint label="About these settings" buttonClassName="auth-i">
                          Your budget and its accounts use this currency. You can change it in account settings
                          until you add your first account, month or transaction; the number format any time.
                        </InfoHint>
                      </span>
                    </div>
                    <div className="auth-sel">
                      <Select
                        id="currency"
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        className="auth-in"
                      >
                        {CURRENCY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <ChevronDown aria-hidden strokeWidth={1.8} />
                    </div>
                  </div>
                  <div className="auth-f">
                    <div className="auth-lr">
                      <label htmlFor="numberFormat" className="auth-label">
                        Number format
                      </label>
                    </div>
                    <div className="auth-sel">
                      <Select
                        id="numberFormat"
                        value={numberFormat}
                        onChange={(e) => setNumberFormat(e.target.value)}
                        className="auth-in"
                      >
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

                <label className="auth-check">
                  <input
                    type="checkbox"
                    required
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                  />
                  <span>
                    I agree to the{' '}
                    <a href="/terms" target="_blank" rel="noopener noreferrer">
                      Terms of Service
                    </a>{' '}
                    and{' '}
                    <a href="/privacy" target="_blank" rel="noopener noreferrer">
                      Privacy Policy
                    </a>
                    .
                  </span>
                </label>

                {IS_STAGING && (
                  <label className="auth-check auth-check-staging">
                    <input
                      type="checkbox"
                      required
                      checked={acceptedStaging}
                      onChange={(e) => setAcceptedStaging(e.target.checked)}
                    />
                    <span>
                      I understand this is the AllotJar <strong className="font-semibold">staging</strong> test
                      environment, and that my data may be reset or permanently lost.
                    </span>
                  </label>
                )}
              </>
            )}

            {error && (
              <p role="alert" className="auth-error">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="auth-pill dark:bg-primary dark:hover:bg-brand-600">
              {busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          {/* Google sign-in: one button serves both modes (it signs in, or creates the account). The
              "or" shows only once Google's button is on the page. */}
          <div className={`auth-gwrap${googleReady || (canUsePasskey && !registering) ? ' is-ready' : ''}`}>
            {(googleReady || (canUsePasskey && !registering)) && (
              <div className="auth-or" aria-hidden="true">
                or
              </div>
            )}
            <GoogleSignInButton onCredential={onGoogleCredential} onReady={() => setGoogleReady(true)} />
            {/* A passkey signs in on its own (it is two factors in one); none is made at sign-up. */}
            {canUsePasskey && !registering && (
              <Button type="button" variant="secondary" onClick={() => void onPasskeySignIn()} disabled={busy} className="auth-pill gap-2">
                <KeyRound aria-hidden strokeWidth={1.8} className="size-4" />
                Sign in with a passkey
              </Button>
            )}
          </div>
        </>
      )}
    </AuthFrame>
  )
}
