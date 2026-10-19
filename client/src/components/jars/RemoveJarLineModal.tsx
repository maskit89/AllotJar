import { useEffect, useRef, useState } from 'react'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { DIALOG_ACTIONS_SPLIT, DIALOG_BAD, DIALOG_BODY, DIALOG_CANCEL, DIALOG_PANEL, DIALOG_PRIMARY, DIALOG_QUIET } from '../settings/parts'
import { api } from '../../lib/api'
import { EVENTS, track } from '../../analytics'
import type { ItemVM } from '../../budgetModel'
import { AccrualMethod, type BudgetMonthDto, type JarScheduleDto } from '../../types'
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
  /**
   * What the user chose to open the dialog with: "Skip this month" (the default) or "Archive jar",
   * which opens it on its archive step (one more press archives).
   */
  intent?: 'skip' | 'archive'
}

/** How many later months the preview lists in full. */
const LISTED = 6

/**
 * Rule 60 (W04): a jar's line cannot simply be deleted from a month, because the jar's plan
 * would only put it back. The user chooses instead: skip this month's contribution (the
 * remainder is spread over the months that are left, rule 61) or archive the jar, which stops
 * every future contribution (rule 25). The skip preview comes from the server — the same
 * planner that will replant the later months — so what is shown is what will happen.
 *
 * A sheet dialog with two steps (restyle PR 18), one per entry point: "Skip {jar} this month"
 * shows the server's preview in a compact panel, with Cancel and the one primary "Skip this
 * month"; "Archive {jar}" is one line with Cancel and "Archive jar" (the bad tone). Each step's
 * other way out is the quiet action at the footer's left ("Archive jar" / "Skip this month
 * instead"), which only switches steps: archiving is still one deliberate press after the
 * choice, as the armed button was. The explanation sits behind the title's (i). The requests
 * (`GET …/skip-preview`, `PUT …/skip { skipped: true }`, `PUT /jars/{id}/archive { archived: true }`)
 * are unchanged.
 */
export function RemoveJarLineModal({ item, month, currency, onClose, onSkipped, onArchived, intent = 'skip' }: RemoveJarLineModalProps) {
  const [preview, setPreview] = useState<JarScheduleDto | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'skip' | 'archive' | null>(null)
  const [mode, setMode] = useState<'skip' | 'archive'>(intent)
  // The step's primary (`data-step-primary`): focused when the user switches steps (on open the
  // dialog places focus itself).
  const footRef = useRef<HTMLDivElement>(null)
  const switched = useRef(false)

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

  useEffect(() => {
    if (switched.current) footRef.current?.querySelector<HTMLElement>('[data-step-primary]')?.focus()
  }, [mode])

  function switchTo(next: 'skip' | 'archive') {
    switched.current = true
    setError(null)
    setMode(next)
  }

  async function skip() {
    if (saving) return
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
    if (!item.savingsId || saving) return
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
  const archiving = mode === 'archive'

  return (
    <Modal
      sheet
      title={archiving ? `Archive ${item.name}` : `Skip ${item.name} this month`}
      hint={
        archiving
          ? `Archiving stops every future contribution and hides the jar; it needs an empty jar and keeps its history. To keep saving and only set nothing aside this month, skip the month instead.`
          : `${item.name} is a jar’s monthly contribution, so it can’t just be deleted: the jar’s plan would put it back. Skipping sets nothing aside this month and spreads what is left over the months that remain; the line stays in the month at zero, marked Skipped, and Plan it again puts it back. To stop saving into the jar, archive it instead.`
      }
      hintLabel={archiving ? 'About archiving a jar' : 'About skipping a month'}
      onClose={onClose}
      footer={
        <div ref={footRef} className={DIALOG_ACTIONS_SPLIT}>
          {archiving ? (
            <Button
              variant="ghost"
              onClick={() => switchTo('skip')}
              disabled={saving !== null}
              aria-label={`Skip ${item.name} this month instead`}
              className={DIALOG_QUIET}
            >
              Skip this month instead
            </Button>
          ) : item.savingsId ? (
            <Button variant="ghost" onClick={() => switchTo('archive')} disabled={saving !== null} aria-label={`Archive ${item.name}`} className={DIALOG_QUIET}>
              Archive jar
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} aria-label={archiving ? `Keep ${item.name}` : `Keep ${item.name} this month`} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          {archiving ? (
            // One deliberate press: the step itself was the choice.
            <button
              data-step-primary=""
              type="button"
              onClick={archive}
              aria-disabled={saving !== null || undefined}
              aria-label={`Confirm archive ${item.name}`}
              className={DIALOG_BAD}
            >
              {saving === 'archive' ? 'Archiving…' : 'Archive jar'}
            </button>
          ) : (
            <Button
              data-step-primary=""
              onClick={skip}
              disabled={previewError !== null}
              aria-disabled={saving !== null || undefined}
              aria-label={`Skip ${item.name} this month`}
              className={DIALOG_PRIMARY}
            >
              {saving === 'skip' ? 'Saving…' : 'Skip this month'}
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
      {archiving ? (
        <p className={DIALOG_BODY}>Future contributions stop and the jar is hidden; it must be empty, and it keeps its history.</p>
      ) : (
        <div
          aria-live="polite"
          data-testid="skip-preview"
          className={`${DIALOG_PANEL} px-3.5 py-3 text-[13px] leading-normal font-medium text-slate-500 tabular-nums max-[699.98px]:px-3`}
        >
          {previewError ? (
            <p role="status" className="text-bad">
              {previewError}
            </p>
          ) : !preview ? (
            <p>Working out the later months…</p>
          ) : preview.isOngoing ? (
            <p className="text-slate-900">Skipping {thisMonth} sets nothing aside this month; the jar carries on from next month.</p>
          ) : later.length === 0 ? (
            <p className="text-slate-900">
              {preview.unplanned > 0
                ? `Skipping ${thisMonth} leaves ${money(preview.unplanned)} unplanned: no month is left to spread it over${preview.deadline ? ' before the deadline' : ''}.`
                : `Skipping ${thisMonth} sets nothing aside this month; nothing more is planned for the jar.`}
            </p>
          ) : (
            <>
              <p className="text-slate-900">
                {preview.accrual === AccrualMethod.FixedMonthly
                  ? // A fixed monthly amount stays as it is; the goal is reached a month later (rules 16, 18).
                    `Skipping ${thisMonth} keeps the monthly amount and adds about one more month to reach the target:`
                  : `Skipping ${thisMonth} spreads this month’s ${formatMoney(item.plannedMinor, currency)} over the months that are left:`}
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {later.slice(0, LISTED).map((m) => (
                  <li key={`${m.year}-${m.month}`} className="flex gap-1.5">
                    <span>{monthYear(monthIso(m.year, m.month))}</span>
                    <span className="text-slate-900">{money(m.planned)}</span>
                  </li>
                ))}
                {later.length > LISTED && <li>… and {later.length - LISTED} more months</li>}
              </ul>
              {preview.unplanned > 0 && (
                <p role="status" className="mt-1.5 text-bad">
                  {money(preview.unplanned)} of the target would stay unplanned{preview.deadline ? ' by the deadline' : ''}.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
