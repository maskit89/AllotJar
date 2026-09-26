// Helpers behind the shared jar form (components/JarFormModal.tsx), kept out of the
// component file so it exports only a component (fast refresh).

import { AccountType, JarKind, type AccountDto } from '../types'

/** Whole calendar months from the server's UTC today to an ISO date (yyyy-MM-dd). */
function monthsFromNow(iso: string, now = new Date()): number {
  const [y, m] = iso.split('-').map(Number)
  return (y - now.getUTCFullYear()) * 12 + (m - (now.getUTCMonth() + 1))
}

/**
 * Whole months from today to the effective due date, mirroring the server's
 * recurrence roll: a Recurring jar whose date has passed re-arms to its next cycle,
 * so a past "Next due" spreads over the upcoming cycle rather than demanding the
 * whole remainder this month. Goals (and cycle-less jars) don't roll.
 */
export function monthsToEffectiveDue(iso: string, kind: number, recurMonths: number): number {
  const now = new Date()
  return monthsFromNow(effectiveDueIso(iso, kind, recurMonths, now), now)
}

/** Mirror EffectiveTargetDate: clamp each occurrence, always retaining the original anchor day. */
export function effectiveDueIso(iso: string, kind: number, recurMonths: number, now = new Date()): string {
  // The API currently uses DateOnly.FromDateTime(DateTime.UtcNow). Match that
  // basis until a household timezone policy is agreed, including near midnight.
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  if (kind !== JarKind.Recurring || recurMonths < 1 || iso >= today) return iso
  const [y, m, d] = iso.split('-').map(Number)
  let cycles = Math.floor(-monthsFromNow(iso, now) / recurMonths)
  // Land near today, then advance at most one cycle if that date has passed.
  // Construct from the original anchor, never from a previously clamped date.
  while (true) {
    const total = m - 1 + cycles * recurMonths
    const year = y + Math.floor(total / 12)
    const month = (total % 12) + 1
    const day = Math.min(d, new Date(year, month, 0).getDate())
    const next = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (next >= today) return next
    cycles++
  }
}

/** The accounts a jar may be held in: any type but a credit card (rule 75). */
export function jarAccounts(accounts: AccountDto[]): AccountDto[] {
  return accounts.filter((a) => a.type !== AccountType.CreditCard)
}

