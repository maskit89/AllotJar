import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, ErrorBanner } from '../ui'
import { Modal } from '../Modal'
import { api } from '../../lib/api'
import type { JarDto, JarPaymentDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { formatDate } from '../../lib/dates'
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

/**
 * Rule 83: the user marks a Recurring jar's cycle paid by choosing the payment that settled the
 * bill — the app never guesses which payment belongs to which cycle. The list is the jar's own
 * payments (drawn from it in its account, rule 79) not yet linked to a cycle; "Show payments from
 * other accounts" widens it to every expense, for a bill paid elsewhere. Nothing moves money:
 * the payment already left the jar when it was recorded (rules 21–23).
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
    <Modal title={`Mark ${jar.name} paid`} onClose={onClose}>
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <p className="text-sm text-slate-600">
        Which payment settled the cycle due {formatDate(deadline)}?{' '}
        {isOpenCycle
          ? 'The jar then saves toward its next due date with whatever it still holds; nothing is moved.'
          : 'This only records the payment against that cycle; nothing is moved.'}
      </p>
      <label className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-500">
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
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        Show payments from other accounts
      </label>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200" role="radiogroup" aria-label="Payments">
        {payments === null ? (
          <p className="p-3 text-sm text-slate-500">Loading…</p>
        ) : payments.length === 0 ? (
          <p className="p-3 text-sm text-slate-500">
            {showAll ? 'No payments to choose from yet.' : `No payments from ${jar.name} yet.`} Record the payment on the{' '}
            <Link to="/transactions" className="font-semibold underline">
              Transactions
            </Link>{' '}
            page first{showAll ? '' : ', or show payments from other accounts'}.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {payments.map((p) => (
              <li key={p.id}>
                <label
                  className={`flex items-center gap-3 px-3 py-2 text-sm ${
                    p.fxPending ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5'
                  }`}
                >
                  <input
                    type="radio"
                    name="cycle-payment"
                    value={p.id}
                    checked={selected === p.id}
                    // A payment waiting for its budget-currency amount can't settle a cycle yet.
                    disabled={p.fxPending}
                    onChange={() => setSelected(p.id)}
                    aria-label={`${p.payee} on ${formatDate(p.date)}, ${formatMoney(fromAmount(p.amount), p.currency || currency)}`}
                    className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-900">{p.payee}</span>
                    <span className="block text-xs text-slate-500">
                      {formatDate(p.date)}
                      {p.accountName ? ` · ${p.accountName}` : ''}
                      {p.budgetItemName ? ` · ${p.budgetItemName}` : ''}
                      {p.fxPending ? ' · Needs its amount entered on Transactions first' : ''}
                    </span>
                  </span>
                  {p.fromJar && <Badge tone="teal">From this jar</Badge>}
                  <span className="tabular-nums font-semibold text-slate-900">{formatMoney(fromAmount(p.amount), p.currency || currency)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} aria-label="Cancel marking paid">
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving || !selected} aria-label={`Confirm ${jar.name} paid`}>
          {saving ? 'Saving…' : 'Mark paid'}
        </Button>
      </div>
    </Modal>
  )
}
