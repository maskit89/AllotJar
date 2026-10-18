import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { AuthFrame, AuthTitle } from '../components/AuthFrame'
import { InfoHint } from '../components/InfoHint'

/** The recovery line of a link that cannot be redeemed (the banner in the app has a Resend). */
const RECOVER = 'Sign in and use Resend in the banner to get a fresh one.'

/** The page's one primary: the sign-in form's green pill (the ui Button's primary classes, as the
 *  landing's "Create your free account" draws it), as a react-router link. */
function Pill({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="auth-pill inline-flex items-center justify-center rounded-lg bg-brand-600 font-semibold text-white transition hover:bg-brand-700 dark:bg-primary dark:hover:bg-brand-600"
    >
      {children}
    </Link>
  )
}

/**
 * Redeems the emailed address-confirmation link (?email=&token=). Public — the person clicking it
 * may not be signed in on this device. Confirming just flips the verified flag server-side; the
 * app itself was always usable, so this is a lightweight "you're confirmed" acknowledgement with a
 * clear recovery path for a dead link.
 *
 * Restyle PR 16: the card inside the signed-out frame (AuthFrame, restyle PR 9; `short`, so on a
 * desktop the card ends under its content), one short state at a time with one primary each. Working: the title only, the quiet way back under it. Done: the
 * title (it takes focus and is announced), "You're all set." and "Go to AllotJar", which leads out,
 * so no foot link. Expired or incomplete: the title, the one recovery line and "Sign in", which is
 * the way back itself, so no second link to /login under it; the incomplete link's why (it may have
 * been split across two lines in the email) sits behind the (i) on its title.
 */
export function ConfirmEmailPage() {
  const [params] = useSearchParams()
  const { markEmailConfirmed } = useAuth()
  const email = params.get('email') ?? ''
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'working' | 'done' | 'invalid' | 'incomplete'>(
    email && token ? 'working' : 'incomplete',
  )
  // React StrictMode double-invokes effects in dev; confirm exactly once.
  const started = useRef(false)

  useEffect(() => {
    if (status !== 'working' || started.current) return
    started.current = true
    api
      .post('/auth/confirm-email', { email, token })
      .then(() => {
        // Clear the banner live: if this is the same browser that's signed in, the "Go to
        // AllotJar" link is a client-side nav (no reload), so state must update here — /auth/me
        // only re-runs on a token change, which confirming doesn't cause.
        markEmailConfirmed()
        setStatus('done')
      })
      .catch(() => setStatus('invalid'))
  }, [status, email, token, markEmailConfirmed])

  return (
    <AuthFrame short>
      {status === 'working' && (
        <div role="status" className="auth-form">
          <AuthTitle>Confirming your email…</AuthTitle>
        </div>
      )}
      {status === 'done' && (
        // The title takes focus, which reads it (#352 P3-2): the live region holds only the line under
        // it, so the title is not announced twice.
        <div className="auth-form">
          <AuthTitle focusOnMount sub={<span role="status">You're all set.</span>}>
            Email confirmed
          </AuthTitle>
          <Pill to="/">Go to AllotJar</Pill>
        </div>
      )}
      {status === 'invalid' && (
        <div className="auth-form">
          <AuthTitle sub={RECOVER}>This link has expired</AuthTitle>
          <Pill to="/login">Sign in</Pill>
        </div>
      )}
      {status === 'incomplete' && (
        <div className="auth-form">
          <AuthTitle
            sub={RECOVER}
            hint={
              <InfoHint label="Why" buttonClassName="auth-i" align="end">
                The confirmation link is missing some of its details — it may have been split across two
                lines in the email.
              </InfoHint>
            }
          >
            This link isn't complete
          </AuthTitle>
          <Pill to="/login">Sign in</Pill>
        </div>
      )}

      {status === 'working' && (
        <div className="auth-foot">
          <Link to="/login" className="auth-link">
            Back to sign in
          </Link>
        </div>
      )}
    </AuthFrame>
  )
}
