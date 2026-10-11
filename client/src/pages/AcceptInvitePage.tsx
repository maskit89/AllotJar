import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { AuthFrame, AuthTitle } from '../components/AuthFrame'
import { useSubmitFocusReturn } from '../lib/useSubmitFocusReturn'
import { InfoHint } from '../components/InfoHint'
import { Button, Input } from '../components/ui'
import { EVENTS, track } from '../analytics'

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { title?: string; error?: string; errors?: Record<string, string[]> } | undefined
    const fieldError = data?.errors ? Object.values(data.errors).flat().join(' ') : undefined
    return fieldError ?? data?.error ?? data?.title ?? 'This invite link is invalid or has expired.'
  }
  return 'Something went wrong.'
}

/**
 * Public landing for a one-time invite link (/accept-invite?code=…). A new person sets their own
 * password and is signed in; someone who's already signed in joins the household with their existing
 * login (keeping their own budget) and can switch to it.
 */
export function AcceptInvitePage() {
  const { acceptInvite, isAuthenticated, email, emailConfirmed, resendVerification } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const code = params.get('code') ?? ''

  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  const formRef = useSubmitFocusReturn(busy)

  // An existing account must sign in before accepting; bounce through /login and come back here.
  const signInHref = `/login?returnUrl=${encodeURIComponent(`/accept-invite?code=${code}`)}`

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await acceptInvite(code, password, displayName || undefined, acceptedTerms)
      track(EVENTS.inviteAccepted)
      // The server made the joined household active — land on its dashboard with a welcome note.
      navigate('/?joined=1', { replace: true })
    } catch (err) {
      setError(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  async function joinExisting() {
    setError(null)
    setBusy(true)
    try {
      // No password — the signed-in user joins with their existing login (backend matches by email).
      await api.post('/auth/accept-invite', { token: code })
      track(EVENTS.inviteAccepted)
      // Full reload so /auth/me picks up the joined household, which the server made active —
      // the accepter lands in the budget they just joined, not back in their own.
      window.location.assign('/?joined=1')
    } catch (err) {
      setError(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  // A signed-in login joins only once its email is confirmed (the server refuses otherwise, D3).
  async function resendConfirmation() {
    setError(null)
    setBusy(true)
    try {
      await resendVerification()
      setResent(true)
    } catch (err) {
      setError(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    // No staging banner here: this page never had one.
    <AuthFrame staging={false}>
      {code === '' ? (
        <>
          <AuthTitle eyebrow="Household invite">Join the household</AuthTitle>
          <p role="alert" className="auth-error">
            This invite link is missing its code. Ask the household owner to send you a fresh link.
          </p>
        </>
      ) : (
        <>
          <AuthTitle
            eyebrow="Household invite"
            hint={
              <InfoHint label="About this invite" buttonClassName="auth-i" align="end">
                You’ve been invited to share a budget on AllotJar — pool income, split shared costs, and each keep
                your own savings.
              </InfoHint>
            }
          >
            Join the household
          </AuthTitle>

          {isAuthenticated ? (
            <div className="auth-form">
              <p className="auth-sub">
                You’re signed in as <b>{email}</b>. Joining adds this household to your account — your own budget
                stays exactly as it is, and you can switch between them.
              </p>
              {!emailConfirmed && (
                <div role="status" className="auth-note">
                  <div className="auth-note-body">
                    <p>
                      Confirm your email first: open the link we emailed you (or sign in with Google), then open this
                      invite again.
                    </p>
                    {resent ? (
                      <p className="font-semibold">We've sent the confirmation email again.</p>
                    ) : (
                      <Button type="button" variant="secondary" onClick={resendConfirmation} disabled={busy} className="auth-note-btn">
                        Send the confirmation email again
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {error && (
                <p role="alert" className="auth-error">
                  {error}
                </p>
              )}
              <Button
                type="button"
                onClick={joinExisting}
                disabled={busy || !emailConfirmed}
                className="auth-pill dark:bg-primary dark:hover:bg-brand-600"
              >
                {busy ? 'Please wait…' : 'Accept invite'}
              </Button>
            </div>
          ) : (
            <form ref={formRef} onSubmit={onSubmit} className="auth-form">
              <div className="auth-f">
                <label htmlFor="displayName" className="auth-label">
                  Your name <span>(optional)</span>
                </label>
                <Input
                  id="displayName"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Sam"
                  className="auth-in"
                />
              </div>
              <div className="auth-f">
                <label htmlFor="password" className="auth-label">
                  Password
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

              {error && (
                <p role="alert" className="auth-error">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy} className="auth-pill dark:bg-primary dark:hover:bg-brand-600">
                {busy ? 'Please wait…' : 'Accept invite'}
              </Button>
            </form>
          )}

          <div className="auth-foot">
            {!isAuthenticated && (
              <p>
                Already have an account?{' '}
                <button type="button" onClick={() => navigate(signInHref)} className="auth-link">
                  Sign in to accept
                </button>
              </p>
            )}
            <button
              type="button"
              onClick={() => navigate(isAuthenticated ? '/' : '/login')}
              className="auth-quiet"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </AuthFrame>
  )
}
