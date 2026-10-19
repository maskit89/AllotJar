import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { StatusChip } from '../StatusChip'
import { DIALOG_ACTIONS, DIALOG_CANCEL, DIALOG_PANEL, DIALOG_PRIMARY } from '../settings/parts'
import { api } from '../../lib/api'
import type { JarDto, JarPaymentDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { formatDate } from '../../lib/dates'
import { jarDate } from '../../lib/jarStatus'
import { serverErrors } from '../../lib/serverErrors'

export interface MarkCyclePaidModalProps {
  jar: JarDto
  /** The cycle being marked paid: the jar's open cycle (`jar.deadline`), or the last closed one when it has no payment yet. */
  deadline: string
  currency: string
  onClose: () => void
  /** Called with the jar as the server returns it after the cycle was marked paid. */
  onMarked: (jar: JarDto) => void
}

/** The empty list's quiet way out: a text button to the Transactions page. */
const QUIET_LINK =
  'inline-flex h-9 items-center rounded-[10px] px-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-500/10 max-[699.98px]:h-10'

/**
 * Rule 83: the user marks a Recurring jar's cycle paid by choosing the payment that settled the
 * bill — the app never guesses which payment belongs to which cycle. The list is the jar's own
 * payments (drawn from it in its account, rule 79) not yet linked to a cycle; "Show payments from
 * other accounts" widens it to every expense, for a bill paid elsewhere. Nothing moves money:
 * the payment already left the jar when it was recorded (rules 21–23).
 *
 * A sheet dialog (restyle PR 18): the question behind the title's (i), the candidates as styled
 * radio rows (the amount at the right, "From this jar" a status chip), the widening checkbox under
 * them, an empty list as one line with a quiet "Record the payment first", Cancel and the one
 * primary "Mark paid". The requests (`GET /jars/{id}/payments[?all=true]`, `POST /jars/{id}/cycles/paid
 * { deadline, paymentTransactionId }`) are unchanged.
 */
export function MarkCyclePaidModal({ jar, deadline, currency, onClose, onMarked }: MarkCyclePaidModalProps) {
  const [payments, setPayments] = useState<JarPaymentDto[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<JarPaymentDto[]>(`/jars/${jar.id}/payments${showAll ? '?all=true' : ''}`)
      .then(({ data }) => {
        if (!cancelled) setPayments(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        if (!cancelled) {
          setPayments([])
          setError('Could not load the payments.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [jar.id, showAll])

  const isOpenCycle = jar.deadline === deadline

  async function submit() {
    if (saving) return
    if (!selected) {
      setError('Choose the payment that settled this cycle.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.post<JarDto>(`/jars/${jar.id}/cycles/paid`, { deadline, paymentTransactionId: selected })
      onMarked(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not mark the cycle paid.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      sheet
      title={`Mark ${jar.name} paid`}
      hint={`Which payment settled the cycle due ${jarDate(deadline, jar.monthOnly)}? ${
        isOpenCycle
          ? 'The jar then saves toward its next due date with whatever it still holds; nothing is moved.'
          : 'This only records the payment against that cycle; nothing is moved.'
      }`}
      hintLabel="About marking paid"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={onClose} aria-label="Cancel marking paid" className={DIALOG_CANCEL}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selected} aria-disabled={saving || undefined} aria-label={`Confirm ${jar.name} paid`} className={DIALOG_PRIMARY}>
            {saving ? 'Saving…' : 'Mark paid'}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <div role="radiogroup" aria-label="Payments" className={`${DIALOG_PANEL} overflow-hidden`}>
        {payments === null ? (
          <p className="px-3.5 py-3 text-sm text-slate-500">Loading…</p>
        ) : payments.length === 0 ? (
          <div className="flex flex-col items-start gap-1.5 px-3.5 py-3">
            <p className="text-sm text-slate-500">{showAll ? 'No payments to choose from yet.' : `No payments from ${jar.name} yet.`}</p>
            <Link to="/transactions" className={`${QUIET_LINK} -ml-2.5`}>
              Record the payment first
            </Link>
          </div>
        ) : (
          // Capped, so "Show payments from other accounts" stays in reach under a long list.
          <ul className="max-h-72 overflow-y-auto overscroll-contain">
            {payments.map((p) => {
              const chosen = selected === p.id
              return (
                <li key={p.id} className="not-first:border-t not-first:border-line">
                  <label
                    className={`dlg-check flex min-h-14 items-center gap-3 px-3.5 py-2.5 max-[699.98px]:gap-[11px] max-[699.98px]:px-3 ${
                      p.fxPending ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                    } ${chosen ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)]' : ''}`}
                  >
                    <input
                      type="radio"
                      name="cycle-payment"
                      value={p.id}
                      checked={chosen}
                      // A payment waiting for its budget-currency amount can't settle a cycle yet.
                      disabled={p.fxPending}
                      onChange={() => setSelected(p.id)}
                      aria-label={`${p.payee} on ${formatDate(p.date)}, ${formatMoney(fromAmount(p.amount), p.currency || currency)}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm text-slate-900 ${chosen ? 'font-semibold' : 'font-medium'}`}>{p.payee}</span>
                      <span className="block text-[13px] leading-snug text-slate-500">
                        {formatDate(p.date)}
                        {p.accountName ? ` · ${p.accountName}` : ''}
                        {p.budgetItemName ? ` · ${p.budgetItemName}` : ''}
                        {p.fxPending ? ' · Needs its amount entered on Transactions first' : ''}
                      </span>
                    </span>
                    {p.fromJar && <StatusChip tone="line">From this jar</StatusChip>}
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                      {formatMoney(fromAmount(p.amount), p.currency || currency)}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <label className="dlg-check mt-3 flex min-h-10 cursor-pointer items-center gap-2.5 text-[13px] font-medium text-slate-500 max-[699.98px]:min-h-11">
        <input
          type="checkbox"
          checked={showAll}
          aria-label="Show payments from other accounts"
          onChange={(e) => {
            // The list is re-asked for; show it loading rather than the old rows.
            setShowAll(e.target.checked)
            setPayments(null)
            setSelected(null)
          }}
        />
        Show payments from other accounts
      </label>
    </Modal>
  )
}
