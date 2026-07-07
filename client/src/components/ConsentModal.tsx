import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { JarLogo } from './Jar'
import { Button } from './ui'

/**
 * A blocking prompt for logins that were created FOR someone (owner-set temporary password,
 * or any legacy account predating the terms checkbox): they must accept the Terms of Service
 * and Privacy Policy themselves before using the app. Registration and invite-link acceptance
 * record consent up front, so most users never see this. Deliberately not dismissible —
 * the only ways out are agreeing or signing out.
 */
export function ConsentModal() {
  const { needsConsent, confirmConsent, logout } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  if (!needsConsent) return null

  async function onAgree() {
    setBusy(true)
    setError(false)
    try {
      await confirmConsent()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="zb-consent-title"
        aria-describedby="zb-consent-body"
        className="relative w-full max-w-md rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card sm:p-7"
      >
        <JarLogo lg />

        <h2 id="zb-consent-title" className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
          One thing before you start
        </h2>
        <p id="zb-consent-body" className="mt-2 text-sm leading-relaxed text-slate-600">
          Your login was set up for you, so we need your own agreement to the{' '}
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
          </a>{' '}
          before you continue.
        </p>

        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-600">
            Something went wrong saving your agreement — please try again.
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={logout} disabled={busy}>
            Sign out
          </Button>
          <Button autoFocus onClick={onAgree} disabled={busy}>
            {busy ? 'Please wait…' : 'I agree'}
          </Button>
        </div>
      </div>
    </div>
  )
}
