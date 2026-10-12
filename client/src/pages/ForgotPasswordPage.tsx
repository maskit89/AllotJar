import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { AuthFrame, AuthTitle } from '../components/AuthFrame'
import { useSubmitFocusReturn } from '../lib/useSubmitFocusReturn'
import { InfoHint } from '../components/InfoHint'
import { Button, Input } from '../components/ui'
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
  const formRef = useSubmitFocusReturn(busy)

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
    <AuthFrame>
      {sent ? (
        // Identical for every address (the server always 204s), so it can't reveal who has an account.
        <div role="status" className="auth-form">
          <AuthTitle
            focusOnMount
            hint={
              <InfoHint label="If nothing arrives" buttonClassName="auth-i" align="end">
                No email after a few minutes? Check your spam folder, or try again.
              </InfoHint>
            }
          >
            Check your inbox
          </AuthTitle>
          <p className="auth-sub">
            If an account exists for <b>{email}</b>, we've emailed it a link to choose a new password. The link
            is valid for 2 hours.
          </p>
        </div>
      ) : (
        <>
          <AuthTitle
            hint={
              <InfoHint label="About resetting" buttonClassName="auth-i" align="end">
                Enter your account's email address and we'll send you a link to choose a new password.
              </InfoHint>
            }
          >
            Reset your password
          </AuthTitle>
          <form ref={formRef} onSubmit={onSubmit} className="auth-form">
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

            {error && (
              <p role="alert" className="auth-error">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="auth-pill dark:bg-primary dark:hover:bg-brand-600">
              {busy ? 'Please wait…' : 'Email me a reset link'}
            </Button>
          </form>
        </>
      )}

      <div className="auth-foot">
        <Link to="/login" className="auth-link">
          Back to sign in
        </Link>
      </div>
    </AuthFrame>
  )
}
