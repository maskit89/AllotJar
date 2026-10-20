import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { DIALOG_ACTIONS, DIALOG_BODY, DIALOG_CANCEL, DIALOG_PRIMARY } from '../settings/parts'
import { api } from '../../lib/api'
import type { JarDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { serverErrors } from '../../lib/serverErrors'

export interface ReopenJarModalProps {
  /** A completed Goal (rule 55). */
  jar: JarDto
  currency: string
  onClose: () => void
  /** Called with the jar as the server returns it once it is reopened. */
  onReopened: (jar: JarDto) => void
}

/**
 * O3c (answered 1 October 2026): reopening a completed Goal makes it active again and restarts
 * its plan from the money still in the jar, for this month and later ones, as an edit would.
 * Nothing is paid or moved. The server refuses an archived jar and says so in its own words.
 *
 * A sheet dialog (restyle PR 18): a short title, one line, the explanation behind the (i), Cancel
 * and the one primary "Reopen". The request (`POST /jars/{id}/reopen`) is unchanged.
 */
export function ReopenJarModal({ jar, currency, onClose, onReopened }: ReopenJarModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)

  async function submit() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.post<JarDto>(`/jars/${jar.id}/reopen`)
      onReopened(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not reopen that jar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      sheet
      title={`Reopen ${jar.name}`}
      hint={`${
        balance === null ? '' : `${jar.name} holds ${formatMoney(balance, currency)}. `
      }Reopening makes it active again and plans its contributions from this month on, starting from the money still in the jar. No money moves.`}
      hintLabel="About reopening a jar"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={onClose} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          <Button onClick={submit} aria-disabled={saving || undefined} className={DIALOG_PRIMARY}>
            {saving ? 'Saving…' : 'Reopen'}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className={DIALOG_BODY}>Contributions are planned again from this month, starting from what it holds.</p>
    </Modal>
  )
}
