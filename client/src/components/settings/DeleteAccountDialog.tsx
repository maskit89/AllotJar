import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from '../Modal'
import { Button } from '../ui'
import {
  DIALOG_ACTIONS,
  DIALOG_ACTIONS_SPLIT,
  DIALOG_BAD,
  DIALOG_BODY,
  DIALOG_CANCEL,
  DIALOG_FIELD_LABEL,
  DIALOG_QUIET,
} from './parts'

/** What deleting the login takes with it (GET /auth/delete-preview). */
export interface DeletePreview {
  ownsHousehold: boolean
  /** Other logins with access to the login's own budget: the delete waits until they're removed. */
  othersInHousehold: number
}

/** How the login proves it's them: its password, or (Google only) its email typed. */
export type DeleteProof = { password: string } | { confirmEmail: string }

/**
 * Account settings' Delete account dialog (compliance fix 5): a centred card on a wide screen, a
 * bottom sheet on a phone. One line says what goes; "Delete for good" works once the login's
 * password is entered (or, for a Google-only login, its email typed). While others share the
 * login's budget it says to remove them in People first, and offers nothing to delete. `onDownload`
 * (the data export, fix 4) adds a quiet "Download my data first" at the footer's left. While it
 * deletes, nothing closes it.
 */
export function DeleteAccountDialog({
  email,
  hasPassword,
  preview,
  busy,
  error,
  onDelete,
  onClose,
  onDownload,
}: {
  email: string
  hasPassword: boolean
  /** Null until known (the line then names only the login). */
  preview: DeletePreview | null
  busy: boolean
  error: string | null
  onDelete: (proof: DeleteProof) => void
  onClose: () => void
  onDownload?: () => void
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const ready = hasPassword ? typed.length > 0 : typed.trim().toLowerCase() === email.trim().toLowerCase()
  const shared = (preview?.othersInHousehold ?? 0) > 0
  const close = () => {
    if (!busy) onClose()
  }
  const submit = () => {
    if (!busy && ready && !shared) onDelete(hasPassword ? { password: typed } : { confirmEmail: typed })
  }

  return (
    <Modal
      sheet
      title="Delete your account?"
      hint={
        <>
          Everything only you can see is deleted. In a household you joined, what the others already saw stays as
          it is, so their figures don’t change. Copies in our backups are deleted when those backups expire.
        </>
      }
      hintLabel="What gets deleted"
      onClose={close}
      footer={
        shared ? (
          <div className={DIALOG_ACTIONS}>
            <Button variant="ghost" onClick={close} className={DIALOG_CANCEL}>
              Close
            </Button>
          </div>
        ) : (
          <div className={onDownload ? DIALOG_ACTIONS_SPLIT : DIALOG_ACTIONS}>
            {onDownload && (
              <Button variant="ghost" onClick={onDownload} disabled={busy} className={DIALOG_QUIET}>
                Download my data first
              </Button>
            )}
            <Button variant="ghost" onClick={close} disabled={busy} className={DIALOG_CANCEL}>
              Cancel
            </Button>
            {/* aria-disabled, not disabled: it keeps its focus, so a refused delete leaves the keyboard in the dialog. */}
            <button type="button" onClick={submit} aria-disabled={busy || !ready || undefined} className={DIALOG_BAD}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
          </div>
        )
      }
    >
      {shared ? (
        <p className={DIALOG_BODY}>
          Others share your budget. Remove them in{' '}
          <Link to="/people" className="font-semibold text-slate-900 underline underline-offset-2">
            People
          </Link>{' '}
          first.
        </p>
      ) : (
        <>
          <p className={DIALOG_BODY}>
            {preview?.ownsHousehold ? 'Your sign-in and your budget go for good.' : 'Your sign-in goes for good.'}
          </p>
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor={id} className={DIALOG_FIELD_LABEL}>
              {hasPassword ? 'Your password' : 'Type your email to confirm'}
            </label>
            <label className="dlg-in">
              <input
                id={id}
                type={hasPassword ? 'password' : 'email'}
                autoComplete={hasPassword ? 'current-password' : 'off'}
                spellCheck={false}
                value={typed}
                // The amount fields' frame, holding text: from the left, the field's whole width.
                className="w-full! text-left! font-medium! [field-sizing:fixed]!"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
              />
            </label>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="auth-error mt-4">
          {error}
        </p>
      )}
    </Modal>
  )
}
