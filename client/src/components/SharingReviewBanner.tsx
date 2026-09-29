import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { serverErrors } from '../lib/serverErrors'
import type { SharingReviewDto } from '../types'
import { Modal } from './Modal'
import { Button, ErrorBanner } from './ui'

/**
 * Rule 32 (P58): a login newly linked to a person who already holds accounts, or for whom someone
 * else added one, is asked once to choose which of those accounts the household sees. Nothing
 * changes until they answer: every listed account starts as it is now.
 */
export function SharingReviewBanner() {
  const { isAuthenticated, sharingReviewPending, clearSharingReview } = useAuth()
  const [review, setReview] = useState<SharingReviewDto | null>(null)
  const [privateIds, setPrivateIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isAuthenticated || !sharingReviewPending) return null

  async function open() {
    setError(null)
    try {
      const { data } = await api.get<SharingReviewDto>('/accounts/sharing-review')
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      setReview({ pending: data?.pending === true, accounts })
      setPrivateIds(accounts.filter((a) => a.isPrivate).map((a) => a.id))
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not load your accounts.')
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.post<SharingReviewDto>('/accounts/sharing-review', { privateAccountIds: privateIds })
      setReview(null)
      clearSharingReview()
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not save your choices.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
        <span>You hold accounts in this household. Choose which ones the others can see.</span>
        <button
          type="button"
          onClick={open}
          className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80"
        >
          Review sharing
        </button>
      </div>
      {error && !review && <ErrorBanner>{error}</ErrorBanner>}
      {review && (
        <Modal title="Who sees your accounts" onClose={() => setReview(null)}>
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <p className="text-sm text-slate-600">
            A private account is seen only by you: its balance, its transactions and its name. Money you put on a budget
            line still shows there. An account a jar uses stays visible to everyone.
          </p>
          <ul className="mt-3 space-y-2">
            {review.accounts.map((a) => {
              const blocked = !a.isPrivate && !!a.sharingBlockedReason
              return (
                <li key={a.id}>
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={privateIds.includes(a.id)}
                      disabled={blocked}
                      aria-label={`Keep ${a.name} private`}
                      onChange={(e) =>
                        setPrivateIds((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
                    />
                    <span>
                      <span className="font-medium">{a.name}</span>: {privateIds.includes(a.id) ? 'private' : 'shared with the household'}
                      {blocked && <span className="block text-xs text-slate-500">{a.sharingBlockedReason}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReview(null)}>
              Not now
            </Button>
            <Button onClick={save} disabled={saving}>
              Save choices
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
