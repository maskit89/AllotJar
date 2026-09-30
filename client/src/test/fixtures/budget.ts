// Budget month fixtures the Dashboard, Transactions and Landing tests share: a line, a group
// and a month, each a full DTO (so the tests type-check) with the fields a test doesn't name
// filled in. A figure the test leaves out is derived: a line's `remaining` from its planned and
// actual amounts, a group's totals from its lines, a month's totals from its groups.
import type { BudgetCategoryDto, BudgetItemDto, BudgetMonthDto } from '../../types'

let lines = 0

/** A budget line; an ordinary expense line unless told otherwise. */
export function budgetItem(over: Partial<BudgetItemDto> = {}): BudgetItemDto {
  const plannedAmount = over.plannedAmount ?? 0
  const actualAmount = over.actualAmount ?? 0
  return {
    id: over.id ?? `item-${++lines}`,
    name: 'Line',
    displayOrder: 0,
    plannedAmount,
    actualAmount,
    remaining: plannedAmount - actualAmount,
    savingsId: null,
    savingsAvailable: null,
    dueDay: null,
    isPaid: false,
    ...over,
  }
}

/** A budget group; an expense group with no lines unless told otherwise. */
export function budgetCategory(over: Partial<BudgetCategoryDto> = {}): BudgetCategoryDto {
  const items = over.items ?? []
  return {
    id: 'cat-1',
    name: 'Group',
    kind: 'Expense',
    displayOrder: 0,
    totalPlanned: items.reduce((sum, i) => sum + i.plannedAmount, 0),
    totalActual: items.reduce((sum, i) => sum + i.actualAmount, 0),
    ...over,
    items,
  }
}

/** A budget month in euros; July 2026 with no groups unless told otherwise. */
export function budgetMonth(over: Partial<BudgetMonthDto> = {}): BudgetMonthDto {
  const year = over.year ?? 2026
  const month = over.month ?? 7
  const categories = over.categories ?? []
  const totalIncome = over.totalIncome
    ?? categories.filter((c) => c.kind === 'Income').reduce((sum, c) => sum + c.totalPlanned, 0)
  const totalPlanned = over.totalPlanned
    ?? categories.filter((c) => c.kind !== 'Income').reduce((sum, c) => sum + c.totalPlanned, 0)
  return {
    id: 'm1',
    key: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    baseCurrency: 'EUR',
    totalIncome,
    totalPlanned,
    remainingToBudget: totalIncome - totalPlanned,
    isBalanced: totalIncome > 0 && totalIncome === totalPlanned, // the server's rule: no income, not balanced
    categories,
    ...over,
  }
}
