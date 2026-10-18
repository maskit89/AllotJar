import type { TransactionDto } from '../types'
import { TransactionType } from '../types'
import { fromAmount } from './money'
import { transactionTypeLabel } from './transactions'

/*
 * One account's register (the Account detail page's list, restyle PR 11): which rows it lists, the
 * date each shows on, its sign, and whether it moved the balance, by the server's account ledger
 * (AllotJar.Domain/Services/ActualAccountLedger.cs). Kept apart from the page so a test can prove
 * the listed rows add up to the balance's movement.
 */

/**
 * The date a row posts on THIS account (the leg it posts): a transfer leaves its source on its
 * departure and reaches its destination on its receipt (null while a receipt is unconfirmed); any
 * other row on its own date.
 */
export function legDateOf(t: TransactionDto, accountId: string): string | null {
  if (t.type !== TransactionType.Transfer) return t.date
  return t.accountId === accountId ? (t.departedOn ?? t.date) : (t.receivedOn ?? null)
}

/** A row of the register. */
export interface RegisterRow {
  t: TransactionDto
  /** The date the row posts here (null: not yet). */
  legDate: string | null
  /** The date the row shows on, and the month it is listed under. */
  shown: string
  /** A transfer out of this account (it is the source). */
  out: boolean
  /**
   * A transfer that left before the opening date and came back after it (#344 P3-1): the opening
   * balance never had its departure, and its return added it (the ledger counts the return leg), so
   * the row shows on its return date, under that month, as money in, with the Returned chip.
   */
  cameBack: boolean
  /** Rules 40/74: dated before the opening date, already in the opening balance (history only). */
  beforeOpening: boolean
  /** Shown struck through: it never moved this balance (before opening, or a transfer sent back). */
  notCounted: boolean
  /** The amount's sign as this account sees it. */
  sign: '+' | '−'
  /**
   * What the row moved this balance by, in minor units of the row's currency: the signed amount when
   * it is posted and counted, else 0 (struck through, a receipt not yet confirmed, a transfer still
   * held for review). The rows' movements add up to the balance less the opening balance.
   */
  movement: number
}

/**
 * The account's rows (transfers into it included), newest first by the date each shows on; the
 * server's order is kept within a day.
 */
export function registerRows(transactions: TransactionDto[], accountId: string, openingDate: string | null | undefined): RegisterRow[] {
  const rows = transactions
    .filter((t) => t.accountId === accountId || t.transferAccountId === accountId)
    .map((t, i) => ({ row: registerRow(t, accountId, openingDate ?? null), i }))
  rows.sort((a, b) => (a.row.shown < b.row.shown ? 1 : a.row.shown > b.row.shown ? -1 : a.i - b.i))
  return rows.map(({ row }) => row)
}

function registerRow(t: TransactionDto, accountId: string, openingDate: string | null): RegisterRow {
  const isTransfer = t.type === TransactionType.Transfer
  const isIncome = transactionTypeLabel(t.type) === 'Income'
  const out = isTransfer && t.accountId === accountId
  const legDate = legDateOf(t, accountId)
  // The date that counts is the leg this account posts (a receipt not yet confirmed is pending, not
  // history). A transfer that left before the opening date but came back after it moved the
  // balance on its return.
  const returnedAfterOpening = out && !!t.returnedOn && !!openingDate && t.returnedOn >= openingDate
  const postedBeforeOpening = !!openingDate && !!legDate && legDate < openingDate
  const cameBack = postedBeforeOpening && returnedAfterOpening
  const beforeOpening = postedBeforeOpening && !returnedAfterOpening
  // A transfer the bank sent back never moved this balance either: it never reached the
  // destination, and the source got it back (but for one that came back after the opening date).
  const notCounted = beforeOpening || (isTransfer && t.transferStatus === 'Returned' && !cameBack)
  const sign: '+' | '−' = isTransfer ? (out && !cameBack ? '−' : '+') : isIncome ? '+' : '−'
  // Posted here: a confirmed leg (a transfer with no departure yet is held for review and posts
  // nowhere; a receipt not yet confirmed has no date here).
  const posted = cameBack || (legDate !== null && (!isTransfer || !!t.departedOn))
  const minor = fromAmount(t.amount)
  const movement = notCounted || !posted ? 0 : sign === '+' ? minor : -minor
  return {
    t,
    legDate,
    shown: cameBack ? t.returnedOn! : (legDate ?? t.date),
    out,
    cameBack,
    beforeOpening,
    notCounted,
    sign,
    movement,
  }
}
