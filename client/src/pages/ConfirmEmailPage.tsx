import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { JarLogo } from '../components/Jar'
import { StagingBanner } from '../components/StagingBanner'
import { ThemeToggle } from '../components/ThemeToggle'
import { Card } from '../components/ui'

const buttonLink =
  'inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700'

/**
 * Redeems the emailed address-confirmation link (?email=&token=). Public — the person clicking it
 * may not be signed in on this device. Confirming just flips the verified flag server-side; the
 * app itself was always usable, so this is a lightweight "you're confirmed" acknowledgement with a
 * clear recovery path for a dead link.
 */
export function ConfirmEmailPage() {
  const [params] = useSearchParams()
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
      .then(() => setStatus('done'))
      .catch(() => setStatus('invalid'))
  }, [status, email, token])

  return (
    <>
      <StagingBanner />
      <div className="relative flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center text-center">
            <JarLogo lg />
            <h1 className="mt-3 text-[26px] font-extrabold tracking-[-0.035em] text-slate-900">
              Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
            </h1>
            <p className="mt-1 text-sm text-slate-500">Confirm your email.</p>
          </div>

          <Card className="p-8">
            {status === 'working' && (
              <p role="status" className="text-sm text-slate-600">
                Confirming your email…
              </p>
            )}
            {status === 'done' && (
              <div role="status" className="space-y-4 text-sm text-slate-600">
                <h2 className="text-base font-semibold text-slate-900">Email confirmed</h2>
                <p>Thanks — your email address is confirmed. You're all set.</p>
                <Link to="/" className={buttonLink}>
                  Go to AllotJar
                </Link>
              </div>
            )}
            {(status === 'invalid' || status === 'incomplete') && (
              <div className="space-y-4 text-sm text-slate-600">
                <h2 className="text-base font-semibold text-slate-900">
                  {status === 'incomplete' ? "This link isn't complete" : 'This link has expired'}
                </h2>
                <p>
                  {status === 'incomplete'
                    ? 'The confirmation link is missing some of its details — it may have been split across two lines in the email.'
                    : 'That confirmation link is invalid or has expired.'}{' '}
                  Sign in and use the “Resend” link in the banner to get a fresh one.
                </p>
                <Link to="/login" className={buttonLink}>
                  Sign in
                </Link>
              </div>
            )}
          </Card>

          <p className="mt-6 text-center text-sm">
            <Link
              to="/login"
              className="font-medium text-brand-600 hover:text-brand-700 dark:text-brand-500"
            >
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </>
  )
}
