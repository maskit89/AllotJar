import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import axios from 'axios'
import { JarLogo } from '../components/Jar'
import { BetaBanner } from '../components/BetaBanner'
import { ThemeToggle } from '../components/ThemeToggle'
import { Button, Card, Input, SegmentedControl, Select } from '../components/ui'
import { CURRENCY_OPTIONS, NUMBER_FORMAT_OPTIONS } from '../lib/money'
import { IS_BETA } from '../lib/env'
import { EVENTS, track } from '../analytics'

export function LoginPage() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Deep links from the landing page ("Create your free account" → /login?register=1)
  // open straight on the registration tab.
  const [mode, setMode] = useState<'login' | 'register'>(
    searchParams.has('register') ? 'register' : 'login',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [numberFormat, setNumberFormat] = useState('comma-dot')
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  // Beta builds require a separate acknowledgment that data may be lost (see BetaBanner).
  const [acceptedBeta, setAcceptedBeta] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
        await register({
          email,
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          preferredCurrency: currency,
          numberFormat,
          acceptedTerms,
        })
      }
      track(mode === 'login' ? EVENTS.login : EVENTS.signUp, { method: 'password' })
      navigate('/', { replace: true })
    } catch (err) {
      track(EVENTS.loginFailed, { method: 'password' })
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string; errors?: string[] } | undefined
        setError(data?.error ?? data?.errors?.join(' ') ?? 'Something went wrong.')
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
      <BetaBanner />
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
          <p className="mt-1 text-sm text-slate-500">Zero-based budgeting, built for Europe.</p>
        </div>

        <Card className="p-8">
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
                placeholder="you@example.eu"
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-600">
                Password
              </label>
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

                {IS_BETA && (
                  <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
                    <input
                      type="checkbox"
                      required
                      checked={acceptedBeta}
                      onChange={(e) => setAcceptedBeta(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-2 focus:ring-amber-500/40"
                    />
                    <span>
                      I understand AllotJar is in <strong className="font-semibold">beta</strong> and under
                      active development, and that my data may be reset or permanently lost.
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
        </Card>

        <p className="mt-6 text-center text-xs text-slate-500">Give every euro a job.</p>
      </div>
      </div>
    </>
  )
}
