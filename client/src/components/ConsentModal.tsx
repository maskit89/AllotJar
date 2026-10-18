import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Modal } from './Modal'
import { DIALOG_ACTIONS, DIALOG_CANCEL, DIALOG_PRIMARY } from './settings/parts'
import { Button, ErrorBanner } from './ui'

const LEGAL_LINK = 'font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-600 dark:text-brand-200'

/**
 * A blocking prompt for logins that were created FOR someone (owner-set temporary password,
 * or any legacy account predating the terms checkbox): they must accept the Terms of Service
 * and Privacy Policy themselves before using the app. Registration and invite-link acceptance
 * record consent up front, so most users never see this. Deliberately not dismissible —
 * the only ways out are agreeing or signing out.
 *
 * A sheet dialog (Modal `sheet`, `dismissible={false}`, restyle PR 17): a short title, the why
 * behind its (i), one line with the two legal links, "Sign out" and the one primary "I agree".
 * The links open the legal pages in a new tab, and on those pages the prompt steps aside.
 */
export function ConsentModal() {
  const { needsConsent, confirmConsent, logout } = useAuth()
  const { pathname } = useLocation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // The primary stays focusable while busy (aria-disabled), so a second press or Enter must be ignored here.
  const inFlight = useRef(false)

  if (!needsConsent) return null
  // The prompt links to the legal pages — never cover the very text being consented to.
  if (pathname === '/terms' || pathname === '/privacy') return null

  async function onAgree() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(false)
    try {
      await confirmConsent()
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      sheet
      dismissible={false}
      zIndex={70}
      title="Accept the terms"
      hint="Registering, or accepting an invite link, records your agreement up front. A login someone set up for you has never agreed, so it is asked once here; nothing else works until then, apart from signing out."
      hintLabel="Why you are asked"
      onClose={() => {}}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={logout} disabled={busy} className={DIALOG_CANCEL}>
            Sign out
          </Button>
          <Button data-sheet-focus="" onClick={onAgree} aria-disabled={busy || undefined} className={DIALOG_PRIMARY}>
            {busy ? 'Please wait…' : 'I agree'}
          </Button>
        </div>
      }
    >
      <p className="text-sm leading-relaxed text-slate-600">
        Your login was set up for you, so please agree to the{' '}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className={LEGAL_LINK}>
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className={LEGAL_LINK}>
          Privacy Policy
        </a>{' '}
        yourself.
      </p>
      {error && (
        <div className="mt-3">
          <ErrorBanner>Something went wrong saving your agreement — please try again.</ErrorBanner>
        </div>
      )}
    </Modal>
  )
}
