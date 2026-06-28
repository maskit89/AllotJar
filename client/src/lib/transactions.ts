import type { BudgetMonthDto, TransactionDto } from '../types'
import { TransactionType } from '../types'

export interface ItemOptionGroup {
  category: string
  items: { id: string; name: string }[]
}

/**
 * Build grouped <optgroup> options (category -> lines) for the assign dropdown.
 * Pass a transaction type to restrict the options to the lines it can target:
 * income transactions offer only income lines, while an expense can be assigned
 * to an expense OR a savings line — a savings line is drawn down by expense
 * transactions, just like an everyday-spending envelope.
 */
export function buildItemOptions(
  month: BudgetMonthDto | null,
  forType?: number,
): ItemOptionGroup[] {
  if (!month) return []
  return month.categories
    .filter((c) => {
      if (forType === undefined) return true
      return forType === TransactionType.Income ? c.kind === 'Income' : c.kind !== 'Income'
    })
    .map((c) => ({
      category: c.name,
      items: c.items.map((i) => ({ id: i.id, name: i.name })),
    }))
    .filter((g) => g.items.length > 0)
}

export function transactionTypeLabel(type: number): 'Income' | 'Expense' {
  return type === TransactionType.Income ? 'Income' : 'Expense'
}

/** Income should read as a positive inflow, an expense as a negative outflow. */
export function signedAmountMinorFromAmount(t: Pick<TransactionDto, 'amount' | 'type'>): number {
  const magnitude = Math.round(t.amount * 10_000)
  return t.type === TransactionType.Income ? magnitude : -magnitude
}
