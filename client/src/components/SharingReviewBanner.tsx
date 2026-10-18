import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { serverErrors } from '../lib/serverErrors'
import type { SharingReviewDto } from '../types'
import { Modal } from './Modal'
import { Notice, NoticeAction } from './Notice'
import { DIALOG_ACTIONS, DIALOG_CANCEL, DIALOG_PRIMARY } from './settings/parts'
import { Button, ErrorBanner } from './ui'

/**
 * Rule 32 (P58): a login newly linked to a person who already holds accounts, or for whom someone
 * else added one, is asked once to choose which of those accounts the household sees. Nothing
 * changes until they answer: every listed account starts as it is now.
 *
 * One line on the info tone with a quiet "Review sharing" (restyle PR 17); the dialog is a sheet
 * (Modal `sheet`) whose explanation sits behind its (i), one styled checkbox row per account, and
 * "Not now" / "Save" in its footer. The requests are unchanged: GET /accounts/sharing-review on
 * open, POST /accounts/sharing-review { privateAccountIds } on Save.
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

  // Nothing closes the dialog while it saves.
  const close = () => {
    if (!saving) setReview(null)
  }

  return (
    <>
      <Notice tone="info" action={<NoticeAction onClick={open}>Review sharing</NoticeAction>}>
        Review who sees your accounts.
      </Notice>
      {error && !review && <ErrorBanner>{error}</ErrorBanner>}
      {review && (
        <Modal
          sheet
          title="Who sees your accounts"
          hint="A private account is seen only by you: its balance, its transactions and its name. Money you put on a budget line still shows there. An account a jar uses stays visible to everyone."
          hintLabel="About private accounts"
          onClose={close}
          footer={
            <div className={DIALOG_ACTIONS}>
              <Button variant="ghost" onClick={close} disabled={saving} className={DIALOG_CANCEL}>
                Not now
              </Button>
              <Button onClick={save} aria-disabled={saving || undefined} className={DIALOG_PRIMARY}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          {/* The list's one word: what a tick means (each row's box is named "Keep … private"). */}
          <p className="mb-1 text-xs font-semibold tracking-[0.04em] text-slate-500 uppercase">Keep private</p>
          <ul>
            {review.accounts.map((a) => {
              const blocked = !a.isPrivate && !!a.sharingBlockedReason
              return (
                <li key={a.id} className="border-t border-line first:border-t-0">
                  <label
                    className={`dlg-check flex min-h-14 items-center gap-3 py-2.5 max-[699.98px]:gap-[11px] ${blocked ? '' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      checked={privateIds.includes(a.id)}
                      disabled={blocked}
                      aria-label={`Keep ${a.name} private`}
                      onChange={(e) =>
                        setPrivateIds((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{a.name}</span>
                      {blocked && <span className="block text-[13px] text-slate-500">{a.sharingBlockedReason}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </Modal>
      )}
    </>
  )
}
