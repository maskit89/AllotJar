import { useId, useState } from 'react'
import { Modal } from './Modal'
import { Button, ErrorBanner } from './ui'
import { DIALOG_ACTIONS, DIALOG_BODY, DIALOG_CANCEL, DIALOG_FIELD_LABEL, DIALOG_PRIMARY } from './settings/parts'
import { api } from '../lib/api'
import { fetchConversionSuggestion, formatForeign, suggestionHint } from '../lib/conversion'
import { currencySymbol, fromAmount, parseMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { formatDate } from '../lib/dates'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { serverErrors } from '../lib/serverErrors'
import type { ConversionSuggestionDto, TransactionDto } from '../types'

/** The quiet Suggest beside the field: a text button at the field's height. */
const SUGGEST_BUTTON = 'h-10 shrink-0 rounded-[10px]! px-3! text-slate-500! max-[699.98px]:h-11 dark:hover:bg-foreground/7'

/**
 * "Enter amount" for a transaction recorded in another currency (fxPending): the user types the
 * amount in the budget currency, or asks for a suggestion and edits it. Suggest saves nothing;
 * only Save does, and the row then counts like any other.
 *
 * A sheet dialog (restyle PR 18): one line saying what was paid, the explanation behind the
 * title's (i), the amount as the dialogs' amount field with the quiet Suggest beside it and the
 * suggestion's note under it, Cancel and the one primary "Save". The requests
 * (`GET /transactions/conversion-suggestion`, `PUT /transactions/{id}/converted-amount { amount }`)
 * are unchanged.
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
  const id = useId()
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
    if (tooPrecise(amount)) {
      setError(TOO_MANY_DECIMALS)
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

  const hintId = `${id}-hint`

  return (
    <Modal
      sheet
      title={`Amount in ${budgetCurrency}`}
      hint={`Enter what it cost in ${budgetCurrency}. It isn’t counted anywhere until you save it.${
        t.accountId ? ` ${t.accountName ?? 'Its account'} keeps its ${t.currency} amount; the budget counts yours.` : ''
      } Suggest fills in the European Central Bank reference rate for that day, for you to check; it saves nothing.`}
      hintLabel="About the amount"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={onClose} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={amount.trim() === ''} aria-disabled={saving || undefined} className={DIALOG_PRIMARY}>
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
      <p className={DIALOG_BODY}>
        <span className="font-semibold text-slate-900">{t.payee || 'This transaction'}</span> was {formatForeign(t.amount, t.currency)} on{' '}
        {formatDate(t.date)}.
      </p>
      <div className="mt-4 flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={id} className={DIALOG_FIELD_LABEL}>
            Amount in {budgetCurrency}
          </label>
          {/* The whole field is a target: a press beside the figure still reaches the input. */}
          <label className="dlg-in">
            <span aria-hidden>{currencySymbol(budgetCurrency)}</span>
            <input
              id={id}
              type="text"
              inputMode="decimal"
              {...selectOnFocusProps}
              value={amount}
              placeholder="0.00"
              aria-label={`Amount in ${budgetCurrency}`}
              aria-describedby={suggestion ? hintId : undefined}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
              }}
            />
          </label>
        </div>
        <Button variant="ghost" onClick={suggest} disabled={suggesting || saving} className={SUGGEST_BUTTON}>
          {suggesting ? 'Suggesting…' : 'Suggest'}
        </Button>
      </div>
      {suggestion && (
        <p id={hintId} role="status" className="mt-2 text-[13px] leading-normal text-slate-500">
          {suggestionHint(suggestion)}
        </p>
      )}
    </Modal>
  )
}
