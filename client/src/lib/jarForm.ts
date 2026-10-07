// Helpers behind the shared jar form (components/JarFormModal.tsx), kept out of the
// component file so it exports only a component (fast refresh). The schedule itself is
// never mirrored here: the form asks the server (POST /jars/schedule) so the preview and
// the saved plans can't disagree (W02).

import { AccountType, type AccountDto } from '../types'
import { currentMonth } from './dates'

/**
 * The accounts a jar may be held in: any type but a credit card (rule 75), in the budget
 * currency (rules 63/85). The account a jar already has stays on offer so its form reads true.
 */
export function jarAccounts(accounts: AccountDto[], budgetCurrency: string, keepId?: string | null): AccountDto[] {
  return accounts.filter((a) => a.id === keepId || (a.type !== AccountType.CreditCard && a.currency === budgetCurrency))
}

/** The first day of a schedule month as an ISO date, for the date formatters. */
export function monthIso(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
}

/** Whether a deadline falls after the 1st, so the deadline month could take a contribution (rule 36). */
export function deadlineMonthEligible(iso: string): boolean {
  const day = Number(iso.split('-')[2])
  return Number.isFinite(day) && day > 1
}

/**
 * A jar to start from (jar setup plan, PR 3): the empty Jars page offers one of each shape the form
 * makes, and picking one fills the form. Nothing is saved until Add jar.
 */
export interface JarExample {
  name: string
  /** The target as typed; '' for a pot with none. */
  target: string
  /** Months between due dates; 0 for one that doesn't repeat. */
  repeats: number
  fixedMonthly: boolean
  /** The amount each month as typed, for a fixed monthly pot; '' otherwise. */
  monthly: string
  /** The 1st of the month it is due in, given as just the month; '' for none. */
  month: string
}

/**
 * A yearly bill due in six months, a holiday the first July at least six months away (so it is never
 * a one- or two-month rush, #325 review P3-2), and a rainy-day pot topped up each month.
 */
export function jarExamples(now = new Date()): JarExample[] {
  const { year, month } = currentMonth(now)
  const inSix = month + 6 > 12 ? monthIso(year + 1, month - 6) : monthIso(year, month + 6)
  const july = monthIso(month <= 1 ? year : year + 1, 7)
  return [
    { name: 'Car insurance', target: '600', repeats: 12, fixedMonthly: false, monthly: '', month: inSix },
    { name: 'Summer holiday', target: '1500', repeats: 0, fixedMonthly: false, monthly: '', month: july },
    { name: 'Rainy day', target: '', repeats: 0, fixedMonthly: true, monthly: '50', month: '' },
  ]
}
