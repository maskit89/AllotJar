import { describe, it, expect } from 'vitest'
import type { ItemVM, MonthVM } from './budgetModel'
import {
  billAlerts,
  billStatus,
  fromDto,
  findItem,
  isSavings,
  itemRemaining,
  categoryPlanned,
  monthPlanned,
  totalIncome,
  remainingToBudget,
  isBalanced,
  billsSummary,
  withItemPlanned,
  withItemBill,
  withItemName,
  withItemPaid,
  withNewItem,
  withoutItem,
  withNewCategory,
  withCategoryName,
  withoutCategory,
} from './budgetModel'
import { fromAmount } from './lib/money'
import type { BudgetMonthDto } from './types'

// Income(Take-home Pay 3000) + Housing(Rent 1100) + Food(Groceries 200).
function dto(): BudgetMonthDto {
  return {
    id: 'm1',
    key: '2026-06',
    year: 2026,
    month: 6,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: 1300,
    remainingToBudget: 1700,
    isBalanced: false,
    categories: [
      {
        id: 'inc',
        name: 'Income',
        kind: 'Income',
        displayOrder: 0,
        totalPlanned: 3000,
        totalActual: 0,
        items: [
          { id: 'pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 0, remaining: 3000},
        ],
      },
      {
        id: 'c1',
        name: 'Housing',
        kind: 'Expense',
        displayOrder: 0,
        totalPlanned: 1100,
        totalActual: 0,
        items: [
          { id: 'i1', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 200, remaining: 900},
        ],
      },
      {
        id: 'c2',
        name: 'Food',
        kind: 'Expense',
        displayOrder: 1,
        totalPlanned: 200,
        totalActual: 0,
        items: [
          { id: 'i2', name: 'Groceries', displayOrder: 0, plannedAmount: 200, actualAmount: 0, remaining: 200},
        ],
      },
    ],
  }
}

describe('budgetModel selectors', () => {
  it('maps the DTO into integer minor units, carrying the currency and kind', () => {
    const vm = fromDto(dto())
    expect(vm.currency).toBe('EUR')
    expect(vm.categories[0].kind).toBe('income')
    expect(vm.categories[1].kind).toBe('expense')
    expect(totalIncome(vm)).toBe(fromAmount(3000))
  })

  it('computes item remaining = planned - actual', () => {
    const vm = fromDto(dto())
    expect(itemRemaining(vm.categories[1].items[0])).toBe(fromAmount(900))
  })

  it('excludes income from planned; remaining = income - expense planned', () => {
    const vm = fromDto(dto())
    expect(categoryPlanned(vm.categories[1])).toBe(fromAmount(1100))
    expect(monthPlanned(vm)).toBe(fromAmount(1300)) // expenses only — income not counted
    expect(totalIncome(vm)).toBe(fromAmount(3000))
    expect(remainingToBudget(vm)).toBe(fromAmount(1700))
    expect(isBalanced(vm)).toBe(false)
  })

  it('withItemPlanned updates one line immutably and recomputes the pool', () => {
    const vm = fromDto(dto())
    const next = withItemPlanned(vm, 'i2', fromAmount(1900)) // Groceries 200 -> 1900

    // original untouched (immutability)
    expect(findItem(vm, 'i2')!.plannedMinor).toBe(fromAmount(200))
    // 1100 + 1900 = 3000 == income -> balanced
    expect(monthPlanned(next)).toBe(fromAmount(3000))
    expect(remainingToBudget(next)).toBe(0)
    expect(isBalanced(next)).toBe(true)
  })

  it('adding an income line raises the pool but never the planned total', () => {
    const vm = fromDto(dto())
    const next = withNewItem(vm, 'inc', {
      id: 'temp',
      name: 'Freelance',
      displayOrder: 1,
      plannedMinor: fromAmount(500),
      actualMinor: 0,
    })

    expect(totalIncome(next)).toBe(fromAmount(3500))
    expect(monthPlanned(next)).toBe(fromAmount(1300)) // unchanged
    expect(remainingToBudget(next)).toBe(fromAmount(2200))
  })

  it('removing an income line lowers the pool', () => {
    const vm = fromDto(dto())
    const next = withoutItem(vm, 'pay')

    expect(totalIncome(next)).toBe(0)
    expect(remainingToBudget(next)).toBe(fromAmount(-1300)) // 0 income, 1300 planned
  })

  it('withItemName renames one line immutably', () => {
    const vm = fromDto(dto())
    const next = withItemName(vm, 'pay', 'Salary')

    expect(findItem(vm, 'pay')!.name).toBe('Take-home Pay')
    expect(findItem(next, 'pay')!.name).toBe('Salary')
  })

  it('withNewCategory appends a group immutably without touching the pool', () => {
    const vm = fromDto(dto())
    const next = withNewCategory(vm, {
      id: 'c-new',
      name: 'Subscriptions',
      kind: 'expense',
      displayOrder: 9,
      items: [],
    })

    expect(vm.categories).toHaveLength(3) // original untouched
    expect(next.categories).toHaveLength(4)
    expect(totalIncome(next)).toBe(fromAmount(3000)) // empty group adds nothing
    expect(monthPlanned(next)).toBe(fromAmount(1300))
  })

  it('withCategoryName renames a group immutably', () => {
    const vm = fromDto(dto())
    const next = withCategoryName(vm, 'c1', 'Home')

    expect(vm.categories.find((c) => c.id === 'c1')!.name).toBe('Housing')
    expect(next.categories.find((c) => c.id === 'c1')!.name).toBe('Home')
  })

  it('withoutCategory removes a group and its lines from the totals', () => {
    const vm = fromDto(dto())
    const next = withoutCategory(vm, 'c1') // drop Housing (Rent 1100)

    expect(next.categories.find((c) => c.id === 'c1')).toBeUndefined()
    expect(monthPlanned(next)).toBe(fromAmount(200)) // only Food's 200 remains
    expect(remainingToBudget(next)).toBe(fromAmount(2800))
  })

  it('maps a fund group and counts its contribution as budgeted money', () => {
    const d = dto()
    d.categories.push({
      id: 'f1',
      name: 'Jars',
      kind: 'Savings',
      displayOrder: 0,
      totalPlanned: 100,
      totalActual: 0,
      items: [
        {
          id: 'car', name: 'Car', displayOrder: 0, plannedAmount: 100, actualAmount: 30,
          remaining: 70, savingsId: 'fund-car', savingsAvailable: 170,
        },
      ],
    })
    const vm = fromDto(d)

    const fund = vm.categories.find(isSavings)!
    expect(fund.kind).toBe('savings')
    expect(fund.items[0].savingsAvailableMinor).toBe(fromAmount(170)) // rolled-over balance
    // The 100 contribution joins the 1300 of expenses in the planned pool.
    expect(monthPlanned(vm)).toBe(fromAmount(1400))
    expect(remainingToBudget(vm)).toBe(fromAmount(1600))
  })

  it('withItemBill sets/clears a due day; clearing also marks it unpaid', () => {
    const vm = fromDto(dto())
    const billed = withItemBill(vm, 'i1', 15) // Rent due on the 15th
    expect(findItem(billed, 'i1')!.dueDay).toBe(15)

    const paid = withItemPaid(billed, 'i1', true)
    expect(findItem(paid, 'i1')!.isPaid).toBe(true)

    // Clearing the due day drops the bill and resets paid.
    const cleared = withItemBill(paid, 'i1', null)
    expect(findItem(cleared, 'i1')!.dueDay).toBeNull()
    expect(findItem(cleared, 'i1')!.isPaid).toBe(false)
    // immutability: original untouched
    expect(findItem(vm, 'i1')!.dueDay).toBeNull()
  })

  it('billsSummary counts bills and totals what is unpaid', () => {
    let vm = fromDto(dto())
    vm = withItemBill(vm, 'i1', 1) // Rent 1100, due 1st
    vm = withItemBill(vm, 'i2', 20) // Groceries 200, due 20th
    vm = withItemPaid(vm, 'i1', true) // Rent paid

    const s = billsSummary(vm)
    expect(s.total).toBe(2)
    expect(s.paid).toBe(1)
    expect(s.unpaidMinor).toBe(fromAmount(200)) // only Groceries (unpaid) counts
  })
})

describe('bill reminders', () => {
  const item = (dueDay: number | null, isPaid = false): ItemVM => ({
    id: 'x', name: 'Rent', displayOrder: 0, plannedMinor: 0, actualMinor: 0,
    savingsAvailableMinor: null, dueDay, isPaid,
  })
  // Mid-June 2026 — the month under test is 2026-06.
  const today = new Date(2026, 5, 15)

  it('classifies a bill in the current month by how close its due day is', () => {
    expect(billStatus(item(10), 2026, 6, today)).toBe('overdue') // 10th already passed
    expect(billStatus(item(20), 2026, 6, today)).toBe('due-soon') // 5 days away
    expect(billStatus(item(25), 2026, 6, today)).toBe('upcoming') // 10 days away
  })

  it('treats paid and non-bill lines specially', () => {
    expect(billStatus(item(10, true), 2026, 6, today)).toBe('paid')
    expect(billStatus(item(null), 2026, 6, today)).toBeNull()
  })

  it('only assesses urgency for the month you are living in', () => {
    // Same overdue-looking day, but viewing a different month → just "upcoming".
    expect(billStatus(item(10), 2026, 7, today)).toBe('upcoming') // future month
    expect(billStatus(item(10), 2026, 5, today)).toBe('upcoming') // past month
  })

  it('clamps a due day past the end of a short month', () => {
    const feb27 = new Date(2026, 1, 27)
    // "Due on the 31st" of February clamps to the 28th → due tomorrow → due-soon.
    expect(billStatus(item(31), 2026, 2, feb27)).toBe('due-soon')
  })

  it('billAlerts counts overdue and due-soon unpaid bills', () => {
    const month: MonthVM = {
      id: 'm', key: '2026-06', year: 2026, month: 6, currency: 'EUR',
      categories: [
        {
          id: 'c', name: 'Housing', kind: 'expense', displayOrder: 0,
          items: [item(8), item(10), item(20), item(25), item(5, true)],
        },
      ],
    }
    expect(billAlerts(month, today)).toEqual({ overdue: 2, dueSoon: 1 })
  })
})
