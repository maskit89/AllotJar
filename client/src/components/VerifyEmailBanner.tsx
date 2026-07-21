import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'

/**
 * Persistent (non-dismissible) nudge shown across the app while the signed-in login's email is
 * unverified. Not shown while the consent modal is up (that blocks the app anyway) or once
 * confirmed. Resend re-sends the confirmation email for the caller's own account.
 */
export function VerifyEmailBanner() {
  const { isAuthenticated, emailConfirmed, needsConsent, email, resendVerification } = useAuth()
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  if (!isAuthenticated || emailConfirmed || needsConsent) return null

  async function onResend() {
    setState('sending')
    try {
      await resendVerification()
      setState('sent')
    } catch {
      setState('error')
    }
  }

  return (
    // aria-live (not role="status") so the resend feedback is announced without adding a second
    // `status` role to the page — journey/e2e specs query getByRole('status') for page banners and
    // a persistent nag here would collide with every one of them.
    <div
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <span>
        Please confirm your email{email ? <> (<span className="font-medium">{email}</span>)</> : null} — check
        your inbox for the link.{' '}
        {state === 'sent' && <span className="font-medium">We've sent a fresh link.</span>}
        {state === 'error' && (
          <span className="font-medium">Couldn't resend just now — please try again.</span>
        )}
      </span>
      <button
        type="button"
        onClick={onResend}
        disabled={state === 'sending'}
        className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending…' : 'Resend'}
      </button>
    </div>
  )
}
