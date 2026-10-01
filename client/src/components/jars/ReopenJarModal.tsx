import { useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
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
 */
export function ReopenJarModal({ jar, currency, onClose, onReopened }: ReopenJarModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)

  async function submit() {
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
    <Modal title={`Reopen ${jar.name}?`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className="text-sm text-slate-600">
        {balance === null ? '' : `${jar.name} holds ${formatMoney(balance, currency)}. `}
        Reopening makes it active again and plans its contributions from this month on, starting from the money still in
        the jar. No money moves.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} aria-label="Keep it completed">
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving} aria-label={`Confirm reopen ${jar.name}`}>
          {saving ? 'Saving…' : 'Reopen'}
        </Button>
      </div>
    </Modal>
  )
}
