import type { AccountDto } from '../types'

/** What others see in place of an account private to someone else (W13, P56/P57). Matches the server's label. */
export const PRIVATE_ACCOUNT = 'Private account'

/** Who holds an account, for its card (rule 30): "Chris", "Chris and Sam", "Chris, Sam and Kid". */
export function holderNames(account: AccountDto): string {
  const names = (account.holders ?? []).map((h) => h.name)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
