// Client-side view-model. The wire DTOs (types.ts) carry amounts as JSON
// numbers; we map them once into integer minor units so every calculation the
// UI performs is exact and provably identical to the server's domain logic.

import type { BudgetMonthDto } from './types'
import { fromAmount, sumMinor, type Minor } from './lib/money'

export type CategoryKind = 'income' | 'expense' | 'savings'

export interface ItemVM {
  id: string
  name: string
  displayOrder: number
  plannedMinor: Minor
  /** Spent (or, for income, received) — always derived from the line's assigned transactions. */
  actualMinor: Minor
  /** For a fund line, the rolled-over available balance (minor units); null otherwise. */
  savingsAvailableMinor: Minor | null
  /** The jar this line is the monthly contribution of (rule 73); null for any other line. */
  savingsId: string | null
  /** Rule 60: a jar line whose contribution the user skipped this month. */
  isSkipped: boolean
  /** Day of the month (1–31) this bill is due; null when the line isn't a bill. */
  dueDay: number | null
  /** Whether this month's bill has been paid. */
  isPaid: boolean
  /** Who earns this income line; null = whole-household (and always null off income lines). */
  memberId: string | null
}

export interface CategoryVM {
  id: string
  name: string
  kind: CategoryKind
  displayOrder: number
  /** Allocation-output category (pocket money, personal savings) — see BudgetCategoryDto. */
  excludeFromAllocation: boolean
  items: ItemVM[]
}

export interface MonthVM {
  id: string
  key: string
  year: number
  month: number
  currency: string
  /** Transactions this month awaiting an exchange rate — excluded from every actual, so >0 marks the totals incomplete. */
  fxPendingCount: number
  categories: CategoryVM[]
}

/** Map an API DTO into the integer-minor view-model. */
export function fromDto(dto: BudgetMonthDto): MonthVM {
  return {
    id: dto.id,
    key: dto.key,
    year: dto.year,
    month: dto.month,
    currency: dto.baseCurrency,
    fxPendingCount: dto.fxPendingCount ?? 0,
    categories: dto.categories.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind === 'Income' ? 'income' : c.kind === 'Savings' ? 'savings' : 'expense',
      displayOrder: c.displayOrder,
      excludeFromAllocation: c.excludeFromAllocation ?? false,
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        displayOrder: i.displayOrder,
        plannedMinor: fromAmount(i.plannedAmount),
        actualMinor: fromAmount(i.actualAmount),
        savingsAvailableMinor: i.savingsAvailable == null ? null : fromAmount(i.savingsAvailable),
        savingsId: i.savingsId ?? null,
        isSkipped: i.isSkipped ?? false,
        dueDay: i.dueDay ?? null,
        isPaid: i.isPaid ?? false,
        memberId: i.memberId ?? null,
      })),
    })),
  }
}

// --- Derived selectors (mirror AllotJar.Domain) ---------------------------
// These are the single source of truth for the UI's totals. Because they sum
// integers, an optimistic edit recomputes the exact same numbers the server
// would return — the banner can never drift.

export const isIncome = (c: CategoryVM): boolean => c.kind === 'income'

export const isSavings = (c: CategoryVM): boolean => c.kind === 'savings'

export const itemRemaining = (i: ItemVM): Minor => i.plannedMinor - i.actualMinor

export const categoryPlanned = (c: CategoryVM): Minor =>
  sumMinor(c.items.map((i) => i.plannedMinor))

export const categoryActual = (c: CategoryVM): Minor =>
  sumMinor(c.items.map((i) => i.actualMinor))

/** The pool to allocate: the sum of the income groups' planned lines. */
export const totalIncome = (m: MonthVM): Minor =>
  sumMinor(m.categories.filter(isIncome).map(categoryPlanned))

/**
 * Income that has been given a job: the sum of every non-income group's planned
 * lines — expense spending AND fund contributions (funding a sinking fund is
 * giving money a job too), so the budget only balances once funds are funded.
 */
export const monthPlanned = (m: MonthVM): Minor =>
  sumMinor(m.categories.filter((c) => !isIncome(c)).map(categoryPlanned))

export const remainingToBudget = (m: MonthVM): Minor => totalIncome(m) - monthPlanned(m)

/**
 * Balanced = some income is planned AND every unit of it has a job. A month
 * with no income and nothing planned has nothing to balance — it is empty,
 * not balanced (mirrors AllotJar.Domain BudgetMonth.IsBalanced).
 */
export const isBalanced = (m: MonthVM): boolean =>
  totalIncome(m) > 0 && remainingToBudget(m) === 0

export interface BillsSummary {
  /** How many lines are bills (have a due day). */
  total: number
  /** How many of those are marked paid. */
  paid: number
  /** Planned total of the unpaid bills (minor units) — what's left to pay. */
  unpaidMinor: Minor
}

/** Roll the month's bills up into a small progress summary. */
export function billsSummary(m: MonthVM): BillsSummary {
  const bills = m.categories.flatMap((c) => c.items).filter((i) => i.dueDay !== null)
  const paid = bills.filter((i) => i.isPaid).length
  const unpaidMinor = sumMinor(bills.filter((i) => !i.isPaid).map((i) => i.plannedMinor))
  return { total: bills.length, paid, unpaidMinor }
}

/** How urgent an unpaid bill is, relative to today (only assessed for the current month). */
export type BillStatus = 'paid' | 'overdue' | 'due-soon' | 'upcoming'

/** Bills due within this many days count as "due soon". */
const DUE_SOON_DAYS = 7

const dateOnly = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** The due day clamped to the month's length (e.g. "31" → 28/29 in February). */
export function effectiveDueDay(dueDay: number | null, year: number, month: number): number | null {
  if (dueDay === null) return null
  return Math.min(dueDay, new Date(year, month, 0).getDate())
}

/**
 * Classify a line's bill against `today`. A future month always reads "upcoming";
 * a month that has already passed reads "overdue" when still unpaid (a genuinely
 * missed bill); the current month is scored against the clamped due day. Returns
 * null when the line isn't a bill.
 */
export function billStatus(i: ItemVM, year: number, month: number, today: Date): BillStatus | null {
  if (i.dueDay === null) return null
  if (i.isPaid) return 'paid'

  const currentYear = today.getFullYear()
  const currentMonth = today.getMonth() + 1
  const isPastMonth = year < currentYear || (year === currentYear && month < currentMonth)
  const isCurrentMonth = year === currentYear && month === currentMonth
  if (isPastMonth) return 'overdue' // an unpaid bill in a month already gone is overdue
  if (!isCurrentMonth) return 'upcoming'

  const day = effectiveDueDay(i.dueDay, year, month)! // clamp e.g. "31" in a 30-day month
  const due = new Date(year, month - 1, day)
  const diffDays = Math.round((due.getTime() - dateOnly(today).getTime()) / 86_400_000)

  if (diffDays < 0) return 'overdue'
  if (diffDays <= DUE_SOON_DAYS) return 'due-soon'
  return 'upcoming'
}

export interface BillAlerts {
  overdue: number
  dueSoon: number
}

/** Count the month's overdue / due-soon unpaid bills (relative to today). */
export function billAlerts(m: MonthVM, today: Date): BillAlerts {
  let overdue = 0
  let dueSoon = 0
  for (const c of m.categories) {
    for (const i of c.items) {
      const status = billStatus(i, m.year, m.month, today)
      if (status === 'overdue') overdue += 1
      else if (status === 'due-soon') dueSoon += 1
    }
  }
  return { overdue, dueSoon }
}

/** Find a line anywhere in the tree (used to read its current state for edits). */
export function findItem(m: MonthVM, itemId: string): ItemVM | undefined {
  for (const c of m.categories) {
    const found = c.items.find((i) => i.id === itemId)
    if (found) return found
  }
  return undefined
}

// --- Optimistic update primitives -------------------------------------------
// Each returns a new tree (immutably) so the banner recomputes instantly and a
// rollback is a single setState back to the captured snapshot.

/** Set one line's planned amount. */
export function withItemPlanned(m: MonthVM, itemId: string, plannedMinor: Minor): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      // A typed amount on a skipped jar line is a plan for the month: the server ends the skip
      // (rule 60), so the line stops saying "Skipped" at once.
      items: c.items.map((i) => (i.id === itemId ? { ...i, plannedMinor, isSkipped: i.isSkipped && plannedMinor === 0 } : i)),
    })),
  }
}

/** Attribute (or clear, with null) who earns an income line. */
export function withItemMember(m: MonthVM, itemId: string, memberId: string | null): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === itemId ? { ...i, memberId } : i)),
    })),
  }
}

/** Set (or clear, with null) a line's bill due day. Clearing also marks it unpaid. */
export function withItemBill(m: MonthVM, itemId: string, dueDay: number | null): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.map((i) =>
        i.id === itemId ? { ...i, dueDay, isPaid: dueDay === null ? false : i.isPaid } : i,
      ),
    })),
  }
}

/** Set one bill line's paid status. */
export function withItemPaid(m: MonthVM, itemId: string, isPaid: boolean): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === itemId ? { ...i, isPaid } : i)),
    })),
  }
}

/** Rename one line. */
export function withItemName(m: MonthVM, itemId: string, name: string): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === itemId ? { ...i, name } : i)),
    })),
  }
}

/** Append a (temporary) line to a category — reconciled from the server response. */
export function withNewItem(m: MonthVM, categoryId: string, item: ItemVM): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) =>
      c.id === categoryId ? { ...c, items: [...c.items, item] } : c,
    ),
  }
}

/** Remove a line. */
export function withoutItem(m: MonthVM, itemId: string): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.filter((i) => i.id !== itemId),
    })),
  }
}

/** Append a (temporary) expense group — reconciled from the server response. */
export function withNewCategory(m: MonthVM, category: CategoryVM): MonthVM {
  return { ...m, categories: [...m.categories, category] }
}

/** Rename one category group. */
export function withCategoryName(m: MonthVM, categoryId: string, name: string): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => (c.id === categoryId ? { ...c, name } : c)),
  }
}

/** Reorder the lines within one category to match the given id order. */
export function withReorderedItems(m: MonthVM, categoryId: string, orderedItemIds: string[]): MonthVM {
  return {
    ...m,
    categories: m.categories.map((c) => {
      if (c.id !== categoryId) return c
      const byId = new Map(c.items.map((i) => [i.id, i]))
      const items = orderedItemIds
        .map((id) => byId.get(id))
        .filter((i): i is ItemVM => i !== undefined)
      return { ...c, items }
    }),
  }
}

/** Reorder the expense groups to match the given id order (income first, funds last). */
export function withReorderedExpenseCategories(m: MonthVM, orderedExpenseIds: string[]): MonthVM {
  const byId = new Map(m.categories.map((c) => [c.id, c]))
  const income = m.categories.filter(isIncome)
  const funds = m.categories.filter(isSavings)
  const expense = orderedExpenseIds
    .map((id) => byId.get(id))
    .filter((c): c is CategoryVM => c !== undefined)
  return { ...m, categories: [...income, ...expense, ...funds] }
}

/** Remove a category group (and its lines). */
export function withoutCategory(m: MonthVM, categoryId: string): MonthVM {
  return { ...m, categories: m.categories.filter((c) => c.id !== categoryId) }
}
