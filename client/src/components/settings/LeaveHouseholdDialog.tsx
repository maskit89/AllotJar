import { TriangleAlert } from 'lucide-react'
import { Modal } from '../Modal'
import { Button } from '../ui'
import { DIALOG_ACTIONS, DIALOG_BUTTON, DIALOG_CANCEL } from './parts'

/** "Yes, leave": a leave, not a delete, so the bad tone tinted (not solid) keeps the sheet calm. */
const LEAVE_BUTTON =
  'inline-flex min-w-[104px] items-center justify-center px-[18px] text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-50 bg-bad-bg text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-bad)_28%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-bad)_10%,var(--color-bad-bg))]'

/**
 * The Account settings page's Leave household dialog (restyle PR 12, account_leave.py), opened from
 * the Household card's ⋯: a centred card on a wide screen, a bottom sheet on a phone. It asks first,
 * as the page's former confirm step did, with the same words: what leaving does, and (D4) how many
 * of the login's accounts there are private, which nobody can see once it leaves and the owner may
 * erase. "Yes, leave" (Leaving…) leaves; the page owns the requests and passes their state in.
 * While it leaves, nothing closes it.
 */
export function LeaveHouseholdDialog({
  ownerName,
  privateAccounts,
  busy,
  error,
  onLeave,
  onClose,
}: {
  /** The joined household's owner's name, or null when they have none (the server's "Household"). */
  ownerName: string | null
  /** How many of the login's accounts there are private (null until known). */
  privateAccounts: number | null
  busy: boolean
  error: string | null
  onLeave: () => void
  onClose: () => void
}) {
  const close = () => {
    if (!busy) onClose()
  }
  const n = privateAccounts ?? 0
  const it = n === 1 ? 'it' : 'them'
  return (
    <Modal
      sheet
      title={ownerName ? `Leave ${ownerName}’s household?` : 'Leave this household?'}
      onClose={close}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={close} disabled={busy} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          {/* aria-disabled while leaving, not disabled: it keeps its focus, so a refused leave leaves
              the keyboard in the dialog (Tab trapped, Escape closing). */}
          <button
            type="button"
            onClick={() => {
              if (!busy) onLeave()
            }}
            aria-disabled={busy || undefined}
            className={`${DIALOG_BUTTON} ${LEAVE_BUTTON}`}
          >
            {busy ? 'Leaving…' : 'Yes, leave'}
          </button>
        </div>
      }
    >
      <p className="-mt-1 text-sm leading-normal text-slate-500">
        You’ll no longer see its budget, and the owner isn’t needed to do this. You can be invited back anytime.
      </p>
      {n > 0 && (
        <div
          role="alert"
          className="mt-[18px] flex items-start gap-2.5 rounded-[10px] bg-warn-bg px-3.5 py-3 text-[13px] leading-normal text-warn"
        >
          <TriangleAlert aria-hidden strokeWidth={1.8} className="mt-0.5 size-4 shrink-0" />
          <p>
            <b className="font-[650]">
              You keep {n} private {n === 1 ? 'account' : 'accounts'} in this household.
            </b>{' '}
            Once you leave, nobody can see {it}, and the owner can erase {it} for good. To keep {it} visible, share {it} on
            the Accounts page first.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="auth-error mt-4">
          {error}
        </p>
      )}
    </Modal>
  )
}
