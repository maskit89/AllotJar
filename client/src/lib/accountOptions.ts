import { ACCOUNT_TYPE_LABELS, AccountType, type AccountDto } from '../types'

/**
 * Savings accounts first (they're what member savings-links and allocation transfers
 * target), then everything else in display order. Non-mutating.
 */
export function savingsFirst(accounts: AccountDto[]): AccountDto[] {
  return [...accounts].sort(
    (a, b) =>
      Number(b.type === AccountType.Savings) - Number(a.type === AccountType.Savings) ||
      a.displayOrder - b.displayOrder,
  )
}

/** "Chris Savings — Savings" — the type suffix keeps mixed pickers scannable. */
export function accountOptionLabel(a: AccountDto): string {
  return `${a.name} — ${ACCOUNT_TYPE_LABELS[a.type] ?? 'Other'}`
}

/** "Chris" / "Chris and Robin" / "Chris, Robin and Sam" — for warning copy. */
export function formatNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
