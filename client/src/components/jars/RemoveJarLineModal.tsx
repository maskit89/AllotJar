import { useEffect, useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { api } from '../../lib/api'
import { EVENTS, track } from '../../analytics'
import type { ItemVM } from '../../budgetModel'
import type { BudgetMonthDto, JarScheduleDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { monthYear } from '../../lib/dates'
import { monthIso } from '../../lib/jarForm'
import { serverErrors } from '../../lib/serverErrors'

export interface RemoveJarLineModalProps {
  /** The jar's contribution line in the viewed month (rule 60). */
  item: ItemVM
  /** The viewed month, as "YYYY-MM-01". */
  month: string
  currency: string
  onClose: () => void
  /** The month as the server returns it after this month's contribution was skipped. */
  onSkipped: (month: BudgetMonthDto) => void
  /** The jar was archived (rule 25): this month's and later contributions are gone. */
  onArchived: () => void
}

/** How many later months the preview lists in full. */
const LISTED = 6

/**
 * Rule 60 (W04): a jar's line cannot simply be deleted from a month, because the jar's plan
 * would only put it back. The user chooses instead: skip this month's contribution (the
 * remainder is spread over the months that are left, rule 61) or archive the jar, which stops
 * every future contribution (rule 25). The skip preview comes from the server — the same
 * planner that will replant the later months — so what is shown is what will happen.
 */
export function RemoveJarLineModal({ item, month, currency, onClose, onSkipped, onArchived }: RemoveJarLineModalProps) {
  const [preview, setPreview] = useState<JarScheduleDto | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'skip' | 'archive' | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<JarScheduleDto>(`/budget/items/${item.id}/skip-preview`)
      .then(({ data }) => !cancelled && setPreview(data))
      .catch((err) => !cancelled && setPreviewError(serverErrors(err) ?? 'Could not work out what skipping this month would do.'))
    return () => {
      cancelled = true
    }
  }, [item.id])

  async function skip() {
    setSaving('skip')
    setError(null)
    try {
      const { data } = await api.put<BudgetMonthDto>(`/budget/items/${item.id}/skip`, { skipped: true })
      track(EVENTS.fundMonthSkipped)
      onSkipped(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not skip this month’s contribution.')
    } finally {
      setSaving(null)
    }
  }

  async function archive() {
    if (!item.savingsId) return
    setSaving('archive')
    setError(null)
    try {
      await api.put(`/jars/${item.savingsId}/archive`, { archived: true })
      track(EVENTS.fundArchived)
      onArchived()
    } catch (err) {
      // Archiving needs a zero balance (rule 26): the server says what the jar still holds.
      setError(serverErrors(err) ?? 'Could not archive that jar.')
    } finally {
      setSaving(null)
    }
  }

  const money = (amount: number) => formatMoney(fromAmount(amount), currency)
  const later = preview ? preview.months.filter((m) => !m.skipped && m.planned > 0) : []
  const thisMonth = monthYear(month)

  return (
    <Modal title={`Remove ${item.name} from ${thisMonth}?`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className="text-sm text-slate-600">
        {item.name} is a jar&rsquo;s monthly contribution, so it can&rsquo;t just be deleted: the jar&rsquo;s plan would put it back.
        Skip this month instead, or archive the jar to stop saving into it.
      </p>

      <div
        aria-live="polite"
        data-testid="skip-preview"
        className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] font-medium tabular-nums text-slate-600"
      >
        {previewError ? (
          <p role="status" className="text-rose-600 dark:text-rose-400">
            {previewError}
          </p>
        ) : !preview ? (
          <p>Working out the later months…</p>
        ) : preview.isOngoing ? (
          <p className="text-slate-900">Skipping {thisMonth} sets nothing aside this month; the jar carries on from next month.</p>
        ) : later.length === 0 ? (
          <p className="text-slate-900">
            Skipping {thisMonth} leaves {money(preview.unplanned)} unplanned: no month is left to spread it over
            {preview.deadline ? ' before the deadline' : ''}.
          </p>
        ) : (
          <>
            <p className="text-slate-900">
              Skipping {thisMonth} spreads this month&rsquo;s {formatMoney(item.plannedMinor, currency)} over the
              months that are left:
            </p>
            <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
              {later.slice(0, LISTED).map((m) => (
                <li key={`${m.year}-${m.month}`} className="flex justify-between gap-2">
                  <span>{monthYear(monthIso(m.year, m.month))}</span>
                  <span>{money(m.planned)}</span>
                </li>
              ))}
              {later.length > LISTED && <li className="col-span-full text-slate-500">… and {later.length - LISTED} more months</li>}
            </ul>
            {preview.unplanned > 0 && (
              <p role="status" className="mt-1.5 text-rose-600 dark:text-rose-400">
                {money(preview.unplanned)} of the target would stay unplanned{preview.deadline ? ' by the deadline' : ''}.
              </p>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-sm text-slate-600">
        Archiving stops every future contribution and hides the jar; it needs an empty jar and keeps its history.
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        {item.savingsId ? (
          // Two clicks to archive: the first arms the button, the second acts.
          <button
            type="button"
            onClick={() => (confirmArchive ? archive() : setConfirmArchive(true))}
            disabled={saving !== null}
            aria-label={confirmArchive ? `Confirm archive ${item.name}` : `Archive ${item.name}`}
            className={`rounded-lg px-2 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
              confirmArchive ? 'bg-rose-50 text-rose-600 hover:bg-rose-100' : 'text-slate-500 hover:bg-rose-50 hover:text-rose-600'
            }`}
          >
            {saving === 'archive' ? 'Archiving…' : confirmArchive ? 'Really archive?' : 'Archive the jar'}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} aria-label={`Keep ${item.name} this month`}>
            Cancel
          </Button>
          <Button onClick={skip} disabled={saving !== null || previewError !== null} aria-label={`Skip ${item.name} this month`}>
            {saving === 'skip' ? 'Saving…' : 'Skip this month'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
