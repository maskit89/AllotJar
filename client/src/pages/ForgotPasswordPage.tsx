import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { JarLogo } from '../components/Jar'
import { StagingBanner } from '../components/StagingBanner'
import { ThemeToggle } from '../components/ThemeToggle'
import { Button, Card, Input } from '../components/ui'
import { EVENTS, track } from '../analytics'

/**
 * Requests a password-reset email. The confirmation copy is identical whether or not an account
 * exists for the address (mirroring the server's always-204) so this page can't be used to probe
 * which emails have accounts.
 */
export function ForgotPasswordPage() {
  const { forgotPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await forgotPassword(email)
      track(EVENTS.passwordResetRequested)
      setSent(true)
    } catch {
      // Only transport-level failures land here (the endpoint 204s regardless) — say so plainly.
      setError("We couldn't send the email just now. Please try again in a moment.")
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
            <p className="mt-1 text-sm text-slate-500">Reset your password.</p>
          </div>

          <Card className="p-8">
            {sent ? (
              <div role="status" className="space-y-4 text-sm text-slate-600">
                <h2 className="text-base font-semibold text-slate-900">Check your inbox</h2>
                <p>
                  If an account exists for <span className="font-medium text-slate-900">{email}</span>,
                  we've emailed it a link to choose a new password. The link is valid for 2 hours.
                </p>
                <p>No email after a few minutes? Check your spam folder, or try again.</p>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <p className="text-sm text-slate-600">
                  Enter your account's email address and we'll send you a link to choose a new
                  password.
                </p>
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

                {error && (
                  <p role="alert" className="text-sm text-rose-600">
                    {error}
                  </p>
                )}

                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? 'Please wait…' : 'Email me a reset link'}
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
