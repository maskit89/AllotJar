import { formatMoney, fromAmount } from './money'
import type { AccountDto, AccountReconciliationDto } from '../types'

/*
 * What an account's jars hold of it, as the Accounts page's cards (restyle PR 6) and an account's
 * own page (restyle PR 11) show it: the bar's fill and the rest (or the shortfall) with its (i).
 */

/** What the (i) after an account's jar line says. */
export const FREE_HINT = 'Money in this account that no jar holds. Move money can put it in a jar.'
export const OVER_HINT = 'Your jars hold more than this account has. Move money out of a jar to cover it.'
// Rule 70 with nothing "over" to show: a jar below zero offsets the ones with money in them.
export const DEFICIT_HINT = 'The jars with money in them hold more than this account has. Move money out of a jar to cover it.'

/** What an account's jars hold of it, as its card's bar and caption say it. */
export interface AccountJars {
  /** The money the jars hold (minor units). */
  backed: number
  count: number
  /** The bar's fill: what the jars hold of the balance, 0-100 (100 when there is no balance to hold). */
  pct: number
  /** The jars hold more than the account has (rule 70): the bar and the rest in red. */
  over: boolean
  /** The rest, or the shortfall, with its (i): null when the balance is unavailable. */
  rest: { text: string; label: string; hint: string } | null
}

/**
 * An account's jars from its line of the reconciliation, or null when it holds none. `balanceMinor`
 * is the account's balance (null when unavailable).
 */
export function accountJars(a: AccountDto, recon: AccountReconciliationDto | undefined, balanceMinor: number | null): AccountJars | null {
  const jars = recon && recon.backedJarCount > 0 ? recon : null
  if (!jars) return null
  const floatMinor = jars.float !== null ? fromAmount(jars.float) : null
  const over = (floatMinor !== null && floatMinor < 0) || !!jars.hasBackingDeficit
  const backed = fromAmount(jars.backedJarsTotal)
  const pct = balanceMinor !== null && balanceMinor > 0 ? (backed / balanceMinor) * 100 : backed > 0 ? 100 : 0
  const rest =
    floatMinor === null
      ? null
      : floatMinor < 0
        ? { text: `${formatMoney(-floatMinor, a.currency)} over`, label: `About the shortfall in ${a.name}`, hint: OVER_HINT }
        : jars.hasBackingDeficit
          ? { text: 'Jars exceed account money', label: `About the shortfall in ${a.name}`, hint: DEFICIT_HINT }
          : { text: `${formatMoney(floatMinor, a.currency)} not in jars`, label: `About the money not in jars in ${a.name}`, hint: FREE_HINT }
  return { backed, count: jars.backedJarCount, pct, over, rest }
}

/**
 * What the Accounts page hands an account's own page through router state (#344 P3-3): the
 * account's line of the reconciliation the Accounts page has just read (null: the answer had no
 * line for it, so it holds no jars), so the account's page shows its In jars tile at once instead
 * of asking the server for the whole household's reconciliation again.
 */
export interface AccountReconState {
  reconciliation: { accountId: string; line: AccountReconciliationDto | null }
}

export function reconState(accountId: string, line: AccountReconciliationDto | null | undefined): AccountReconState {
  return { reconciliation: { accountId, line: line ?? null } }
}

/**
 * The line handed over for `accountId`, or null when there is none to use (the page was opened
 * directly, reloaded, or reached with Back or Forward, where the state may be stale: the caller
 * passes `fresh` only for an in-app navigation, and then reads the reconciliation itself).
 */
export function reconFromState(state: unknown, accountId: string, fresh: boolean): { line: AccountReconciliationDto | null } | null {
  if (!fresh || !state || typeof state !== 'object') return null
  const r = (state as Partial<AccountReconState>).reconciliation
  if (!r || typeof r !== 'object' || r.accountId !== accountId) return null
  const line = r.line && typeof r.line === 'object' && r.line.accountId === accountId ? r.line : null
  return { line }
}
