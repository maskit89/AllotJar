import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { api } from '../../lib/api'
import type { JarDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { formatDate } from '../../lib/dates'
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
 */
export function DismissCycleModal({ jar, currency, onClose, onDismissed, onMarkPaidInstead }: DismissCycleModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
  const short = fromAmount(jar.shortfall ?? 0)

  async function submit() {
    if (!jar.deadline) return
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

  return (
    <Modal title={`Move ${jar.name} on to its next cycle?`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className="text-sm text-slate-600">
        {jar.status === 'FundedLate'
          ? `${jar.name} reached its target after the deadline on ${jar.deadline ? formatDate(jar.deadline) : 'its due date'}.`
          : `${jar.name} missed its deadline on ${jar.deadline ? formatDate(jar.deadline) : 'its due date'}${short > 0 ? ` — ${formatMoney(short, currency)} short` : ''}.`}{' '}
        Dismissing keeps {balance === null ? 'what it holds' : `the ${formatMoney(balance, currency)} it holds`} for the next cycle, records nothing as paid
        and makes up no shortfall; the jar simply saves toward its next due date.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Paid the bill?{' '}
        <button type="button" onClick={onMarkPaidInstead} className="font-semibold text-brand-700 underline dark:text-brand-200">
          Mark the cycle paid
        </button>{' '}
        and choose the payment instead.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} aria-label="Keep the missed deadline">
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving} aria-label={`Dismiss ${jar.name}'s missed deadline`}>
          {saving ? 'Saving…' : 'Move on'}
        </Button>
      </div>
    </Modal>
  )
}
