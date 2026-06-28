import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { JarLogo } from '../components/Jar'
import { ThemeToggle } from '../components/ThemeToggle'
import { Button, Card, Input } from '../components/ui'
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
  const { acceptInvite, isAuthenticated, email } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const code = params.get('code') ?? ''

  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await acceptInvite(code, password, displayName || undefined)
      track(EVENTS.inviteAccepted)
      navigate('/', { replace: true })
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
      // Full reload so /auth/me picks the new household up in the switcher.
      window.location.assign('/people')
    } catch (err) {
      setError(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <JarLogo lg />
          <h1 className="mt-3 text-[26px] font-bold tracking-tight text-slate-900">AllotJar</h1>
          <p className="mt-1 text-sm text-slate-500">Zero-based budgeting, built for Europe.</p>
        </div>

        <Card className="p-8">
          {code === '' ? (
            <p role="alert" className="text-sm text-rose-600">
              This invite link is missing its code. Ask the household owner to send you a fresh link.
            </p>
          ) : (
            <>
              <div className="mb-5 text-center">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-brand-600 dark:text-brand-300">
                  Household invite
                </p>
                <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-900">Join the household</h2>
                <p className="mx-auto mt-2 max-w-xs text-sm text-slate-500">
                  You’ve been invited to share a budget on AllotJar — pool income, split shared costs, and each
                  keep your own savings.
                </p>
              </div>

              {isAuthenticated ? (
                <div className="space-y-4">
                  <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    You’re signed in as <span className="font-medium text-slate-800">{email}</span>. Joining adds
                    this household to your account — your own budget stays exactly as it is, and you can switch
                    between them.
                  </p>
                  {error && (
                    <p role="alert" className="text-sm text-rose-600">
                      {error}
                    </p>
                  )}
                  <Button type="button" onClick={joinExisting} disabled={busy} className="w-full">
                    {busy ? 'Please wait…' : 'Accept invite'}
                  </Button>
                </div>
              ) : (
                <form onSubmit={onSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="displayName" className="mb-1 block text-sm font-medium text-slate-600">
                      Your name <span className="text-slate-500">(optional)</span>
                    </label>
                    <Input
                      id="displayName"
                      type="text"
                      autoComplete="name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="e.g. Liza"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-600">
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
                      className="w-full"
                    />
                  </div>

                  {error && (
                    <p role="alert" className="text-sm text-rose-600">
                      {error}
                    </p>
                  )}

                  <Button type="submit" disabled={busy} className="w-full">
                    {busy ? 'Please wait…' : 'Accept invite'}
                  </Button>
                </form>
              )}

              <button
                type="button"
                onClick={() => navigate(isAuthenticated ? '/' : '/login')}
                className="mt-3 w-full text-center text-sm font-medium text-slate-500 transition hover:text-slate-700"
              >
                Not now
              </button>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
