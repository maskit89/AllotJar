import { useId, useState } from 'react'
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
  othersInHousehold: number
  privateAccountsElsewhere: number
}

/**
 * Account settings' Delete account dialog (compliance fix 5): a centred card on a wide screen, a
 * bottom sheet on a phone. One line says what goes, and "Delete for good" works only once the
 * login's email is typed. `onDownload` (the data export, fix 4) adds a quiet "Download my data
 * first" at the footer's left. While it deletes, nothing closes it.
 */
export function DeleteAccountDialog({
  email,
  preview,
  busy,
  error,
  onDelete,
  onClose,
  onDownload,
}: {
  email: string
  /** Null until known (the line then names only the login). */
  preview: DeletePreview | null
  busy: boolean
  error: string | null
  onDelete: (typedEmail: string) => void
  onClose: () => void
  onDownload?: () => void
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase()
  const close = () => {
    if (!busy) onClose()
  }
  const submit = () => {
    if (!busy && matches) onDelete(typed)
  }
  const others = preview?.othersInHousehold ?? 0
  const goes = preview?.ownsHousehold
    ? others > 0
      ? `Your sign-in and your budget go for good, and ${others} ${others === 1 ? 'person loses' : 'people lose'} access to it.`
      : 'Your sign-in and your budget go for good.'
    : 'Your sign-in goes for good.'

  return (
    <Modal
      sheet
      title="Delete your account?"
      hint={
        <>
          Everything only you can see is deleted. In a household you joined, what the others already saw stays as
          it is, so their figures don’t change. Copies in backups expire on their own within 35 days.
        </>
      }
      hintLabel="What gets deleted"
      onClose={close}
      footer={
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
          <button
            type="button"
            onClick={submit}
            aria-disabled={busy || !matches || undefined}
            className={DIALOG_BAD}
          >
            {busy ? 'Deleting…' : 'Delete for good'}
          </button>
        </div>
      }
    >
      <p className={DIALOG_BODY}>{goes}</p>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor={id} className={DIALOG_FIELD_LABEL}>
          Type your email to confirm
        </label>
        <label className="dlg-in">
          <input
            id={id}
            type="email"
            autoComplete="off"
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
      {error && (
        <p role="alert" className="auth-error mt-4">
          {error}
        </p>
      )}
    </Modal>
  )
}
