import { useState } from 'react'
import { Modal } from './Modal'
import { Button, ErrorBanner, Input } from './ui'
import { api } from '../lib/api'
import { fetchConversionSuggestion, formatForeign, suggestionHint } from '../lib/conversion'
import { fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { formatDate } from '../lib/dates'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { serverErrors } from '../lib/serverErrors'
import type { ConversionSuggestionDto, TransactionDto } from '../types'

/**
 * "Enter amount" for a transaction recorded in another currency (fxPending): the user types the
 * amount in the budget currency, or asks for a suggestion and edits it. Suggest saves nothing;
 * only Confirm amount does, and the row then counts like any other.
 */
export function ConvertedAmountModal({
  transaction: t,
  budgetCurrency,
  onClose,
  onConfirmed,
}: {
  transaction: TransactionDto
  budgetCurrency: string
  onClose: () => void
  onConfirmed: (updated: TransactionDto) => void
}) {
  const [amount, setAmount] = useState('')
  const [suggestion, setSuggestion] = useState<ConversionSuggestionDto | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function suggest() {
    setSuggesting(true)
    setError(null)
    try {
      const s = await fetchConversionSuggestion(t.currency, t.amount, t.date)
      setSuggestion(s)
      if (s.suggestedAmount !== null) setAmount(toEditString(fromAmount(s.suggestedAmount)))
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not get a suggestion. Enter the amount yourself.')
    } finally {
      setSuggesting(false)
    }
  }

  async function confirm() {
    if (saving) return // a second Enter while the first save is in flight
    const minor = parseMinor(amount)
    if (minor === null || minor <= 0) {
      setError(`Enter the amount in ${budgetCurrency}, greater than zero.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.put<TransactionDto>(`/transactions/${t.id}/converted-amount`, {
        amount: toAmount(minor),
      })
      onConfirmed(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not save that amount.')
      setSaving(false)
    }
  }

  return (
    <Modal title={`Amount in ${budgetCurrency}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{t.payee || 'This transaction'}</span> was{' '}
          {formatForeign(t.amount, t.currency)} on {formatDate(t.date)}. Enter what it cost in {budgetCurrency}.
          It isn’t counted anywhere until you confirm.
          {t.accountId && ` ${t.accountName ?? 'Its account'} keeps its ${t.currency} amount; the budget counts yours.`}
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
            Amount in {budgetCurrency}
            <Input
              type="text"
              inputMode="decimal"
              {...selectOnFocusProps}
              value={amount}
              placeholder="0.00"
              aria-label={`Amount in ${budgetCurrency}`}
              aria-describedby={suggestion ? 'converted-amount-hint' : undefined}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
              }}
              className="w-full text-right tabular-nums"
            />
          </label>
          <Button variant="secondary" onClick={suggest} disabled={suggesting || saving}>
            {suggesting ? 'Suggesting…' : 'Suggest'}
          </Button>
        </div>
        {suggestion && (
          <p id="converted-amount-hint" role="status" className="text-xs text-slate-500">
            {suggestionHint(suggestion)}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={saving || amount.trim() === ''}>
            {saving ? 'Saving…' : 'Confirm amount'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
