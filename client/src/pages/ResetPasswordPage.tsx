import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { JarLogo } from '../components/Jar'
import { StagingBanner } from '../components/StagingBanner'
import { ThemeToggle } from '../components/ThemeToggle'
import { Button, Card, Input } from '../components/ui'
import { EVENTS, track } from '../analytics'

/**
 * Redeems the emailed reset link (?email=…&token=…). A successful reset signs this device
 * straight in — the user just proved control of the account's email. A dead/mangled link gets a
 * clear path to requesting a fresh one instead of a dead end.
 */
export function ResetPasswordPage() {
  const { resetPassword } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const email = searchParams.get('email') ?? ''
  const token = searchParams.get('token') ?? ''
  const linkComplete = email !== '' && token !== ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The server said the token is dead — offer a fresh link instead of a retry loop.
  const [linkDead, setLinkDead] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError("Those passwords don't match.")
      return
    }
    setBusy(true)
    try {
      await resetPassword(email, token, password)
      track(EVENTS.passwordResetCompleted)
      navigate('/', { replace: true })
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as
          | { error?: string; errors?: string[] | Record<string, string[]> }
          | undefined
        // `errors` is an array (Identity composition rules) or an OBJECT of arrays
        // (ValidationProblemDetails) — flatten so it can never throw and swallow the error.
        const errors = data?.errors
        const joined = Array.isArray(errors)
          ? errors.join(' ')
          : errors && typeof errors === 'object'
            ? Object.values(errors).flat().join(' ')
            : undefined
        const message = data?.error ?? joined ?? 'Something went wrong.'
        setLinkDead(message.includes('invalid or has expired'))
        setError(message)
      } else {
        setError('Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

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
            <p className="mt-1 text-sm text-slate-500">Choose a new password.</p>
          </div>

          <Card className="p-8">
            {!linkComplete ? (
              <div className="space-y-4 text-sm text-slate-600">
                <h2 className="text-base font-semibold text-slate-900">This link isn't complete</h2>
                <p>
                  The reset link is missing some of its details — it may have been split across two
                  lines in the email. You can request a fresh one below.
                </p>
                <Button onClick={() => navigate('/forgot-password')} className="w-full">
                  Request a new link
                </Button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <p className="text-sm text-slate-600">
                  Setting a new password for{' '}
                  <span className="font-medium text-slate-900">{email}</span>. This signs you out
                  everywhere else.
                </p>
                <div>
                  <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-600">
                    New password
                  </label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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

                {error && (
                  <p role="alert" className="text-sm text-rose-600">
                    {error}
                  </p>
                )}
                {linkDead && (
                  <Button
                    onClick={() => navigate('/forgot-password')}
                    variant="secondary"
                    className="w-full"
                  >
                    Request a new link
                  </Button>
                )}

                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? 'Please wait…' : 'Set new password'}
                </Button>
              </form>
            )}
          </Card>

          <p className="mt-6 text-center text-sm">
            <Link
              to="/login"
              className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-500"
            >
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </>
  )
}
