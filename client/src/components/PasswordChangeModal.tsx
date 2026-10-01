import { useState } from 'react'
import axios from 'axios'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { JarLogo } from './Jar'
import { Button } from './ui'

/**
 * A blocking prompt for a login whose password was set by someone else (an owner's direct invite
 * with a temporary password). Until it chooses its own, the server refuses everything else, and
 * the owner who knows the temporary password could sign in as it (S-P2-3, P59). The new password
 * can only be chosen through the link emailed to the login's own address, so whoever set the
 * temporary one can't pick it on the person's behalf. Not dismissible: the ways out are the
 * emailed link or signing out.
 */
export function PasswordChangeModal() {
  const { mustChangePassword, email, logout } = useAuth()
  const { pathname } = useLocation()
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!mustChangePassword) return null
  // Like the consent prompt, never cover the legal pages it may sit in front of, nor the page the
  // emailed link opens to choose the password, which this prompt is waiting for.
  if (pathname === '/terms' || pathname === '/privacy' || pathname === '/reset-password') return null

  async function resend() {
    setError(null)
    setResent(false)
    setBusy(true)
    try {
      // Sent to this login's own address; the answer says whether the email really went out.
      await api.post('/auth/password-link')
      setResent(true)
    } catch (err) {
      const data = axios.isAxiosError(err) ? (err.response?.data as { error?: string } | undefined) : undefined
      setError(data?.error ?? "We couldn't send the email just now. Try again later.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="zb-pwchange-title"
        aria-describedby="zb-pwchange-body"
        className="relative w-full max-w-md rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card sm:p-7"
      >
        <JarLogo lg />

        <h2 id="zb-pwchange-title" className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
          Choose your own password
        </h2>
        <p id="zb-pwchange-body" className="mt-2 text-sm leading-relaxed text-slate-600">
          Your login was set up for you with a temporary password. Before you continue, choose one only
          you know with the link we emailed to <strong className="text-slate-900">{email}</strong>, so
          the accounts you keep private stay private.
        </p>

        {resent && (
          <p role="status" className="mt-3 text-sm text-emerald-700">
            We've sent a new link. It's valid for 2 hours.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-600">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 pt-5 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={logout} disabled={busy}>
            Sign out
          </Button>
          <Button type="button" onClick={resend} disabled={busy}>
            {busy ? 'Sending…' : 'Email me the link again'}
          </Button>
        </div>
      </div>
    </div>
  )
}
