import { api } from './api'
import { formatPlain, formatRate, fromAmount } from './money'
import type { ConversionSuggestionDto } from '../types'

/**
 * Ask the server for a SUGGESTED budget-currency amount for a figure paid in another currency
 * (ECB reference rate, rounded to 2 decimals by the server). Asking saves nothing: the user
 * must confirm the amount, and an unconfirmed suggestion has no monetary effect.
 */
export async function fetchConversionSuggestion(
  currency: string,
  amount: number,
  date: string,
): Promise<ConversionSuggestionDto> {
  const { data } = await api.get<ConversionSuggestionDto>('/transactions/conversion-suggestion', {
    params: { currency, amount, date },
  })
  return data
}

/** A foreign figure labelled with its ISO code, e.g. "USD 12.50", so it never reads as budget money. */
export function formatForeign(amount: number, currency: string): string {
  return `${currency} ${formatPlain(fromAmount(amount))}`
}

/** The hint shown under a suggested amount: the rate and where it came from. */
export function suggestionHint(s: ConversionSuggestionDto): string {
  if (s.rate === null || s.suggestedAmount === null) {
    return `No suggestion is available for ${s.currency} on this date. Enter the amount in ${s.budgetCurrency} yourself.`
  }
  const source = s.source || 'ECB reference rate'
  return `Suggested from the ${source}: 1 ${s.currency} = ${formatRate(s.rate)} ${s.budgetCurrency}. Check it matches what you paid.`
}
