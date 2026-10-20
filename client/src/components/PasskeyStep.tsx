import { useState, type FormEvent } from 'react'
import axios from 'axios'
import { KeyRound } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { AuthTitle } from './AuthFrame'
import { InfoHint } from './InfoHint'
import { Button, Input } from './ui'
import { passkeyError, type SecondStep } from '../lib/passkeys'
import { useSubmitFocusReturn } from '../lib/useSubmitFocusReturn'

/**
 * The second step of signing in, for a login with a passkey (fix 14): the password, Google or reset
 * link was right, and the device's passkey answers before a session starts. A recovery code stands
 * in when the passkey's device is lost. The button starts the device's prompt, as Safari only lets
 * a tap start it.
 */
export function PasskeyStep({
  step,
  onSignedIn,
  onRestart,
}: {
  step: SecondStep
  onSignedIn: () => void
  /** The ticket ran out (five minutes, or five wrong answers): back to the start of sign-in. */
  onRestart: () => void
}) {
  const { answerWithPasskey, answerWithRecoveryCode } = useAuth()
  const [usingCode, setUsingCode] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formRef = useSubmitFocusReturn(busy)

  function failed(err: unknown) {
    if (axios.isAxiosError(err) && (err.response?.data as { restart?: boolean } | undefined)?.restart) {
      onRestart()
      return
    }
    setError(passkeyError(err))
  }

  async function answerPasskey() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await answerWithPasskey(step)
      onSignedIn()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await answerWithRecoveryCode(step, code)
      onSignedIn()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  function switchMode() {
    setUsingCode((v) => !v)
    setError(null)
  }

  return (
    <div className="auth-form">
      <AuthTitle
        as="h2"
        focusOnMount
        hint={
          <InfoHint label="About this step" buttonClassName="auth-i" align="end">
            Your account has a passkey, so signing in asks for it too. Use your device's fingerprint, face or PIN, or
            the password manager that saved it.
          </InfoHint>
        }
      >
        {usingCode ? 'Enter a recovery code' : 'Confirm with your passkey'}
      </AuthTitle>

      {usingCode ? (
        <form ref={formRef} onSubmit={onSubmitCode} className="auth-form">
          <div className="auth-f">
            <label htmlFor="recovery-code" className="auth-label">
              Recovery code
            </label>
            <Input
              id="recovery-code"
              required
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="abcde-fghjk"
              className="auth-in"
            />
          </div>
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="auth-pill dark:bg-primary dark:hover:bg-brand-600">
            {busy ? 'Please wait…' : 'Continue'}
          </Button>
        </form>
      ) : (
        <>
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <Button
            type="button"
            onClick={() => void answerPasskey()}
            aria-disabled={busy || undefined}
            className="auth-pill gap-2 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:bg-primary dark:hover:bg-brand-600"
          >
            <KeyRound aria-hidden strokeWidth={1.8} className="size-4" />
            {busy ? 'Waiting for your passkey…' : 'Use passkey'}
          </Button>
        </>
      )}

      <div className="auth-foot">
        <button type="button" onClick={switchMode} className="auth-link">
          {usingCode ? 'Use your passkey instead' : 'Use a recovery code'}
        </button>
        <button type="button" onClick={onRestart} className="auth-quiet">
          Back to sign in
        </button>
      </div>
    </div>
  )
}
