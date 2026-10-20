import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { DIALOG_ACTIONS_SPLIT, DIALOG_BODY, DIALOG_CANCEL, DIALOG_PRIMARY, DIALOG_QUIET } from '../settings/parts'
import { api } from '../../lib/api'
import type { JarDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { formatDate } from '../../lib/dates'
import { jarDate, nextCycleDeadline } from '../../lib/jarStatus'
import { serverErrors } from '../../lib/serverErrors'

export interface DismissCycleModalProps {
  /** A jar in the Deadline missed or Funded late state (its open cycle's deadline has passed). */
  jar: JarDto
  currency: string
  onClose: () => void
  /** Called with the jar as the server returns it after the notice was dismissed. */
  onDismissed: (jar: JarDto) => void
  /** Opens the mark-paid flow instead, for a bill that was in fact paid. */
  onMarkPaidInstead: () => void
}

/**
 * Rule 20: dismissing the Deadline-missed notice moves the jar on to its next due date. The
 * money it holds carries into that cycle (rule 19), nothing is recorded as paid and no
 * shortfall is made up; the cycle is closed as missed (or funded late, rule 57).
 *
 * A sheet dialog (restyle PR 18): a short title, one line naming the next due date, the
 * explanation behind the (i); "Mark the cycle paid" (the way out for a bill that was in fact
 * paid) as the quiet action at the footer's left, Cancel and the one primary "Move on". The
 * request (`POST /jars/{id}/cycles/dismiss { deadline }`) is unchanged.
 */
export function DismissCycleModal({ jar, currency, onClose, onDismissed, onMarkPaidInstead }: DismissCycleModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
  const short = fromAmount(jar.shortfall ?? 0)

  async function submit() {
    if (!jar.deadline || saving) return
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.post<JarDto>(`/jars/${jar.id}/cycles/dismiss`, { deadline: jar.deadline })
      onDismissed(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not dismiss the missed deadline.')
    } finally {
      setSaving(false)
    }
  }

  // A deadline given as just a month reads "its Mar 2027 deadline".
  const deadline = !jar.deadline
    ? 'its due date'
    : jar.monthOnly && jar.deadline.endsWith('-01')
      ? `its ${jarDate(jar.deadline, true)} deadline`
      : jar.status === 'FundedLate'
        ? `the deadline on ${formatDate(jar.deadline)}`
        : `its deadline on ${formatDate(jar.deadline)}`
  // The cycle the jar moves on to, as the server sets it: stepped from the jar's anchor date (rule 62).
  const step = jar.recurMonths && jar.recurMonths > 0 ? jar.recurMonths : 12
  const next =
    jar.deadline && jar.targetDate
      ? `the cycle due ${jarDate(nextCycleDeadline(jar.targetDate, jar.deadline, step), jar.monthOnly)}`
      : 'its next cycle'

  return (
    <Modal
      sheet
      title={`Move ${jar.name} to its next cycle`}
      hint={
        <>
          <p>
            {jar.status === 'FundedLate'
              ? `${jar.name} reached its target after ${deadline}.`
              : `${jar.name} missed ${deadline}${short > 0 ? ` — ${formatMoney(short, currency)} short` : ''}.`}{' '}
            Dismissing keeps {balance === null ? 'what it holds' : `the ${formatMoney(balance, currency)} it holds`} for the next cycle, records
            nothing as paid and makes up no shortfall; the jar simply saves toward its next due date.
          </p>
          <p className="mt-2">Paid the bill? Mark the cycle paid and choose the payment instead.</p>
        </>
      }
      hintLabel="About moving on"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS_SPLIT}>
          <Button variant="ghost" onClick={onMarkPaidInstead} disabled={saving} className={DIALOG_QUIET}>
            Mark the cycle paid
          </Button>
          <Button variant="ghost" onClick={onClose} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          <Button onClick={submit} aria-disabled={saving || undefined} className={DIALOG_PRIMARY}>
            {saving ? 'Saving…' : 'Move on'}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className={DIALOG_BODY}>What it holds carries to {next}; nothing is recorded as paid.</p>
    </Modal>
  )
}
