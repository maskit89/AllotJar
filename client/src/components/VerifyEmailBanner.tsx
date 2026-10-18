import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Notice, NoticeAction } from './Notice'

/**
 * Persistent (non-dismissible) nudge shown across the app while the signed-in login's email is
 * unverified: one line on the warn tone, the address behind its (i), and a quiet Resend. Not shown
 * while the consent modal is up (that blocks the app anyway) or once confirmed. Resend re-sends
 * the confirmation email for the caller's own account; its outcome replaces the line (on the ok or
 * bad tone) rather than adding a second sentence.
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
    <Notice
      aria-live="polite"
      tone={state === 'sent' ? 'ok' : state === 'error' ? 'bad' : 'warn'}
      hint={
        email ? (
          <>
            The link went to <strong className="font-semibold text-slate-900">{email}</strong>. This line stays until
            you open it; Resend sends a fresh one.
          </>
        ) : (
          'This line stays until you open the link we emailed you; Resend sends a fresh one.'
        )
      }
      hintLabel="About confirming your email"
      action={
        <NoticeAction onClick={onResend} disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Resend'}
        </NoticeAction>
      }
    >
      {state === 'sent'
        ? 'A fresh link is on its way.'
        : state === 'error'
          ? "Couldn't resend, try again."
          : 'Confirm your email: check your inbox for the link.'}
    </Notice>
  )
}
