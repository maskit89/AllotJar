import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { api } from '../../lib/api'
import { EVENTS, track } from '../../analytics'
import type { JarDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { serverErrors } from '../../lib/serverErrors'

export interface CompleteJarModalProps {
  /** A Goal jar (rule 55): a recurring jar is never completed, its cycle is marked paid instead. */
  jar: JarDto
  currency: string
  onClose: () => void
  /** Called with the jar as the server returns it once it is completed. */
  onCompleted: (jar: JarDto) => void
}

/**
 * Rules 55–56 (W04): completing a goal stops its planned contributions from this month on
 * and keeps whatever it holds until the user moves or spends it. The jar stays listed with
 * its history; nothing is deleted. The server refuses a recurring jar, an overdrawn balance
 * (rule 56) or one that cannot be read (rule 67), and says so in its own words; an overdrawn
 * balance already on screen is explained here with the amount to cover first (P41, O3a).
 */
export function CompleteJarModal({ jar, currency, onClose, onCompleted }: CompleteJarModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
  const target = fromAmount(jar.targetAmount)
  const short = balance !== null && target > balance ? target - balance : 0
  // P41, kept by O3a: an overdrawn Goal is not completed; the dialog says how much to cover first.
  const overdrawn = balance !== null && balance < 0 ? -balance : 0

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.post<JarDto>(`/jars/${jar.id}/complete`)
      track(EVENTS.fundCompleted)
      onCompleted(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not mark that jar completed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Mark ${jar.name} completed?`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {overdrawn > 0 ? (
        <p className="text-sm text-slate-600">
          {jar.name} is {formatMoney(overdrawn, currency)} overdrawn. Cover the {formatMoney(overdrawn, currency)} shortfall from
          another jar or unallocated funds first, then mark it completed.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {short > 0
              ? `${jar.name} holds ${formatMoney(balance ?? 0, currency)} of its ${formatMoney(target, currency)} target, ${formatMoney(short, currency)} short. `
              : balance === null
                ? ''
                : `${jar.name} holds ${formatMoney(balance, currency)}. `}
            Completing it stops the planned contributions from this month on
            {jar.plannedThisMonth > 0 ? `, so this month's line drops to what has already gone in` : ''}. The money stays in the jar until you
            move or spend it, and the jar keeps its history.
          </p>
          <p className="mt-2 text-sm text-slate-600">To stop saving without finishing, archive the jar from Edit instead.</p>
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} aria-label="Keep saving">
          {overdrawn > 0 ? 'Close' : 'Cancel'}
        </Button>
        {overdrawn === 0 && (
          <Button onClick={submit} disabled={saving} aria-label={`Confirm complete ${jar.name}`}>
            {saving ? 'Saving…' : 'Mark completed'}
          </Button>
        )}
      </div>
    </Modal>
  )
}
