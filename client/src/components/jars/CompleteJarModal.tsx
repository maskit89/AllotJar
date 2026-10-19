import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { DIALOG_ACTIONS, DIALOG_BODY, DIALOG_CANCEL, DIALOG_PRIMARY } from '../settings/parts'
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
 *
 * A sheet dialog (Modal `sheet`, restyle PR 18): a short title, one line, the rules behind the
 * title's (i), Cancel and the one primary "Mark completed" in the footer. Overdrawn, the line says
 * what to cover and the footer offers only Close. The request (`POST /jars/{id}/complete`) is unchanged.
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
    if (saving) return
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

  // What the jar holds against its target, for the (i): the card behind says the same in figures.
  const holds =
    balance === null
      ? ''
      : short > 0
        ? `${jar.name} holds ${formatMoney(balance, currency)} of its ${formatMoney(target, currency)} target, ${formatMoney(short, currency)} short. `
        : `${jar.name} holds ${formatMoney(balance, currency)}. `

  return (
    <Modal
      sheet
      title={`Mark ${jar.name} completed`}
      hint={
        overdrawn > 0
          ? `${jar.name} is ${formatMoney(overdrawn, currency)} overdrawn. Cover the ${formatMoney(overdrawn, currency)} shortfall from another jar or unallocated funds first, then mark it completed.`
          : `${holds}Completing it stops the planned contributions from this month on${
              jar.plannedThisMonth > 0 ? ', so this month’s line drops to what has already gone in' : ''
            }; the money stays in the jar until you move or spend it, and the jar keeps its history. To stop saving without finishing, archive the jar from Edit instead.`
      }
      hintLabel="About completing a jar"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={onClose} aria-label="Keep saving" className={DIALOG_CANCEL}>
            {overdrawn > 0 ? 'Close' : 'Cancel'}
          </Button>
          {overdrawn === 0 && (
            <Button onClick={submit} aria-disabled={saving || undefined} aria-label={`Confirm complete ${jar.name}`} className={DIALOG_PRIMARY}>
              {saving ? 'Saving…' : 'Mark completed'}
            </Button>
          )}
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className={DIALOG_BODY}>
        {overdrawn > 0
          ? `Cover the ${formatMoney(overdrawn, currency)} it is below zero first.`
          : 'Planned contributions stop from this month; what it holds stays until you move it.'}
      </p>
    </Modal>
  )
}
