import { useState, type FormEvent } from 'react'
import axios from 'axios'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { JarLogo } from './Jar'
import { Button, Input } from './ui'

/**
 * A blocking prompt for a login whose password was set by someone else (an owner's direct invite
 * with a temporary password). Until it chooses its own, the server refuses everything else, and
 * the owner who knows the temporary password could sign in as it (S-P2-3, P59). Not dismissible:
 * the only ways out are saving a new password or signing out. Changing it also ends any other
 * session opened with the temporary password.
 */
export function PasswordChangeModal() {
  const { mustChangePassword, changePassword, logout } = useAuth()
  const { pathname } = useLocation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!mustChangePassword) return null
  // Like the consent prompt, never cover the legal pages it may sit in front of.
  if (pathname === '/terms' || pathname === '/privacy') return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('Use a new password of at least 8 characters.')
      return
    }
    if (next === current) {
      setError('Choose a new password that is different from the temporary one.')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { errors?: string[]; error?: string } | undefined
        setError(data?.error ?? data?.errors?.join(' ') ?? 'Could not save your password.')
      } else {
        setError('Could not save your password.')
      }
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
          Your login was set up for you with a temporary password. Choose one only you know before you
          continue, so the accounts you keep private stay private.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="pwchange-current" className="mb-1 block text-sm font-medium text-slate-600">
              Temporary password
            </label>
            <Input
              id="pwchange-current"
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label htmlFor="pwchange-next" className="mb-1 block text-sm font-medium text-slate-600">
              New password
            </label>
            <Input
              id="pwchange-next"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full"
            />
          </div>
          <div>
            <label htmlFor="pwchange-confirm" className="mb-1 block text-sm font-medium text-slate-600">
              Confirm new password
            </label>
            <Input
              id="pwchange-confirm"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-rose-600">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={logout} disabled={busy}>
              Sign out
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save password'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
