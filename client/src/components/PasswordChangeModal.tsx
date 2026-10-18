import { useRef, useState } from 'react'
import axios from 'axios'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { Modal } from './Modal'
import { DIALOG_ACTIONS, DIALOG_CANCEL, DIALOG_PRIMARY } from './settings/parts'
import { Button, ErrorBanner } from './ui'

/**
 * A blocking prompt for a login whose password was set by someone else (an owner's direct invite
 * with a temporary password). Until it chooses its own, the server refuses everything else, and
 * the owner who knows the temporary password could sign in as it (S-P2-3, P59). The new password
 * can only be chosen through the link emailed to the login's own address, so whoever set the
 * temporary one can't pick it on the person's behalf. Not dismissible: the ways out are the
 * emailed link or signing out.
 *
 * A sheet dialog (Modal `sheet`, `dismissible={false}`, restyle PR 17): a short title, the why
 * behind its (i), one line naming the address, "Sign out" and the one primary "Email me the link"
 * (POST /auth/password-link, as before); the outcome is one quiet line under the body.
 */
export function PasswordChangeModal() {
  const { mustChangePassword, email, logout } = useAuth()
  const { pathname } = useLocation()
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The primary stays focusable while busy (aria-disabled), so a second press or Enter must be ignored here.
  const inFlight = useRef(false)

  if (!mustChangePassword) return null
  // Like the consent prompt, never cover the legal pages it may sit in front of, nor the page the
  // emailed link opens to choose the password, which this prompt is waiting for.
  if (pathname === '/terms' || pathname === '/privacy' || pathname === '/reset-password') return null

  async function resend() {
    if (inFlight.current) return
    inFlight.current = true
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
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      sheet
      dismissible={false}
      zIndex={75}
      title="Choose a new password"
      hint="Your login was set up for you with a temporary password, which only opens this prompt. The new one is chosen through the link sent to your own address, so whoever set the temporary one cannot pick it for you and the accounts you keep private stay private. Each link is valid for 2 hours."
      hintLabel="Why you are asked"
      onClose={() => {}}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={logout} disabled={busy} className={DIALOG_CANCEL}>
            Sign out
          </Button>
          <Button data-sheet-focus="" onClick={resend} aria-disabled={busy || undefined} className={DIALOG_PRIMARY}>
            {busy ? 'Sending…' : 'Email me the link'}
          </Button>
        </div>
      }
    >
      <p className="text-sm leading-relaxed text-slate-600">
        Use the link we emailed to <strong className="font-semibold text-slate-900">{email}</strong> to choose it.
      </p>
      {resent && (
        <p role="status" className="mt-3 text-[13px] font-semibold text-ok">
          A new link is on its way, valid for 2 hours.
        </p>
      )}
      {error && (
        <div className="mt-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
    </Modal>
  )
}
