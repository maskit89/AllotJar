// Helpers behind the shared jar form (components/JarFormModal.tsx), kept out of the
// component file so it exports only a component (fast refresh). The schedule itself is
// never mirrored here: the form asks the server (POST /jars/schedule) so the preview and
// the saved plans can't disagree (W02).

import { AccountType, type AccountDto } from '../types'

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
