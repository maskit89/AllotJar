import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { AuthFrame, AuthTitle } from '../components/AuthFrame'
import { useSubmitFocusReturn } from '../lib/useSubmitFocusReturn'
import { InfoHint } from '../components/InfoHint'
import { Button, Input } from '../components/ui'
import { EVENTS, track } from '../analytics'
import { PasskeyStep } from '../components/PasskeyStep'
import type { SecondStep } from '../lib/passkeys'

const MISMATCH = "Those passwords don't match."

/**
 * Redeems the emailed reset link (?email=…&token=…). A successful reset signs this device
 * straight in — the user just proved control of the account's email. A dead/mangled link gets a
 * clear path to requesting a fresh one instead of a dead end. A login with a passkey answers it
 * after the reset before it signs in (the inbox alone never gets past it).
 */
export function ResetPasswordPage() {
  // A signed-in visitor (a direct-invite login opening its emailed link) is still restoring its
  // session here. Submitting before that settles lets the restore land after the reset and put
  // back the session the reset just revoked, which signs the visitor out; so wait for it.
  const { resetPassword, bootstrapping } = useAuth()
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
  const [secondStep, setSecondStep] = useState<SecondStep | null>(null)
  const formRef = useSubmitFocusReturn(busy)
  // The mismatch belongs to the confirm field: it is marked invalid and described by the message.
  const mismatch = error === MISMATCH

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError(MISMATCH)
      return
    }
    setBusy(true)
    try {
      const { secondStep: step } = await resetPassword(email, token, password)
      track(EVENTS.passwordResetCompleted)
      // The new password is set; a login with a passkey answers it before this device signs in.
      if (step) {
        setSecondStep(step)
        return
      }
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
    <AuthFrame>
      {secondStep ? (
        <PasskeyStep
          step={secondStep}
          onSignedIn={() => navigate('/', { replace: true })}
          // The password is already changed: starting over is signing in with it.
          onRestart={() => navigate('/login', { replace: true })}
        />
      ) : !linkComplete ? (
        <>
          <AuthTitle
            hint={
              <InfoHint label="About this link" buttonClassName="auth-i" align="end">
                The reset link is missing some of its details — it may have been split across two lines in the
                email. You can request a fresh one below.
              </InfoHint>
            }
          >
            This link isn't complete
          </AuthTitle>
          <Button
            onClick={() => navigate('/forgot-password')}
            className="auth-pill dark:bg-primary dark:hover:bg-brand-600"
          >
            Request a new link
          </Button>
        </>
      ) : (
        <>
          <AuthTitle
            sub={
              <>
                Setting a new password for <b>{email}</b>. This signs you out everywhere else.
              </>
            }
          >
            Choose a new password
          </AuthTitle>
          <form ref={formRef} onSubmit={onSubmit} className="auth-form">
            <div className="auth-f">
              <label htmlFor="password" className="auth-label">
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
                className="auth-in"
              />
            </div>
            <div className="auth-f">
              <label htmlFor="confirm" className="auth-label">
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
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'reset-error' : undefined}
                className="auth-in"
              />
            </div>

            {error && (
              <p id="reset-error" role="alert" className="auth-error">
                {error}
              </p>
            )}
            {linkDead && (
              <Button onClick={() => navigate('/forgot-password')} variant="secondary" className="auth-pill">
                Request a new link
              </Button>
            )}

            <Button
              type="submit"
              disabled={busy || bootstrapping}
              className="auth-pill dark:bg-primary dark:hover:bg-brand-600"
            >
              {busy ? 'Please wait…' : 'Set new password'}
            </Button>
          </form>
        </>
      )}

      {!secondStep && (
        <div className="auth-foot">
          <Link to="/login" className="auth-link">
            Back to sign in
          </Link>
        </div>
      )}
    </AuthFrame>
  )
}
