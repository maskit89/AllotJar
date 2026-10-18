import { useId, useState, type FormEvent } from 'react'
import axios from 'axios'
import { Modal } from '../Modal'
import { Button, Input } from '../ui'
import { useAuth } from '../../auth/AuthContext'
import { EVENTS, track } from '../../analytics'
import { DIALOG_CANCEL, DIALOG_PRIMARY, DIALOG_ACTIONS } from './parts'

const MISMATCH = 'The new passwords do not match.'
const TOO_SHORT = 'Use a new password of at least 8 characters.'

/**
 * The Account settings page's Change password dialog (restyle PR 12, account_password.py): a centred
 * card on a wide screen, a bottom sheet with a grab handle on a phone (Modal `sheet`). The page's
 * former form, unchanged: Current password, New password (at least 8 characters) and Confirm new
 * password, the same two checks in the same order with no request, then `POST /auth/change-password`
 * (the fresh session is adopted, so this device stays signed in and the others are signed out).
 *
 * Mounted only while open, so its fields start empty each time. A refused change keeps it open with
 * the reason under the fields and the values kept; a successful one is tracked once and closes it,
 * and the page says so on its Password row. While the change is saving, nothing closes it.
 *
 * Not `PasswordChangeModal`: that one is the app-wide "choose your own password" blocker.
 */
export function ChangePasswordDialog({
  onClose,
  onAttempt,
  onChanged,
}: {
  onClose: () => void
  /** A change is being tried: the page clears its earlier success line. */
  onAttempt: () => void
  /** The password was changed: the page closes the dialog and shows its success line. */
  onChanged: () => void
}) {
  const { changePassword } = useAuth()
  const formId = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    // The submit stays focusable while saving (see below), so a second press lands here: ignore it.
    if (busy) return
    setError(null)
    onAttempt()
    if (next !== confirm) {
      setError(MISMATCH)
      return
    }
    if (next.length < 8) {
      setError(TOO_SHORT)
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      track(EVENTS.passwordChanged)
      onChanged()
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { errors?: string[]; error?: string } | undefined
        setError(data?.error ?? data?.errors?.join(' ') ?? 'Could not change your password.')
      } else {
        setError('Could not change your password.')
      }
      setBusy(false)
    }
  }

  // The ✕, the grab handle, Escape and the backdrop do what Cancel does, and nothing while saving.
  const close = () => {
    if (!busy) onClose()
  }

  // The two checks belong to a field: it is marked invalid and described by the message.
  const errorId = `${formId}-error`
  const invalid = error === MISMATCH ? 'confirm' : error === TOO_SHORT ? 'next' : null
  const fieldError = (field: 'next' | 'confirm') =>
    invalid === field ? { 'aria-invalid': true, 'aria-describedby': errorId } : {}

  return (
    <Modal
      sheet
      title="Change password"
      onClose={close}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={close} disabled={busy} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          {/* Outside the form in the DOM (the sheet's footer stays put), joined to it by `form`, so
              Enter in a field and the fields' own required/minLength checks still submit through it.
              While saving it is aria-disabled, not disabled: it keeps the focus it was pressed with,
              so a refused change leaves the keyboard in the dialog (Tab trapped, Escape closing). */}
          <Button type="submit" form={formId} aria-disabled={busy || undefined} className={DIALOG_PRIMARY}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="auth-f">
          <div className="auth-lr">
            <label htmlFor="current" className="auth-label">
              Current password
            </label>
          </div>
          <Input
            id="current"
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="auth-in"
          />
        </div>
        <div className="grid grid-cols-2 gap-4 max-[699.98px]:grid-cols-1">
          <div className="auth-f">
            <div className="auth-lr">
              <label htmlFor="next" className="auth-label">
                New password
              </label>
            </div>
            <Input
              id="next"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="At least 8 characters"
              {...fieldError('next')}
              className="auth-in"
            />
          </div>
          <div className="auth-f">
            <div className="auth-lr">
              <label htmlFor="confirm" className="auth-label">
                Confirm new password
              </label>
            </div>
            <Input
              id="confirm"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              {...fieldError('confirm')}
              className="auth-in"
            />
          </div>
        </div>
        {/* One quiet line: the alert's own text is the message (the icon is drawn by CSS). */}
        {error && (
          <p id={errorId} role="alert" className="auth-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
