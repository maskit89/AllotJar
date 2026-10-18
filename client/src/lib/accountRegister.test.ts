import { describe, expect, it } from 'vitest'
import type { TransactionDto } from '../types'
import { TransactionType } from '../types'
import { fromAmount } from './money'
import { registerRows } from './accountRegister'

// The Account detail register against the server's account ledger (#344 P3-1): the rows the page
// counts add up to the balance's movement (balance less opening balance), with a transfer that left
// before the opening date and came back after it listed on its return date as money in.

const A = 'a1'
const OPENING = '2026-05-01'
const AS_OF = '2026-07-31'

function tx(over: Partial<TransactionDto>): TransactionDto {
  return {
    id: 't', date: '2026-06-20', payee: 'Row', amount: 10, currency: 'EUR', type: TransactionType.Expense,
    bankReference: null, budgetItemId: null, budgetItemName: null, accountId: A, accountName: 'Everyday',
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, isSplit: false, splits: [],
    ...over,
  } as TransactionDto
}

const transfer = (over: Partial<TransactionDto>) =>
  tx({ type: TransactionType.Transfer, transferAccountId: 'a2', transferAccountName: 'Pot', ...over })

/**
 * A port of ActualAccountLedger.Entries (AllotJar.Domain/Services/ActualAccountLedger.cs) for one
 * account, in minor units: each posted leg dated from the opening date to the as-of date, a
 * transfer's return leg counted on its return date even when the departure predates the opening,
 * a transfer with no departure (held for review) posting nowhere.
 */
function ledgerMovement(rows: TransactionDto[], accountId: string, openingDate: string, asOf: string): number {
  let sum = 0
  for (const t of rows) {
    if (t.accountId !== accountId && !(t.type === TransactionType.Transfer && t.transferAccountId === accountId)) continue
    let date: string | null = t.date
    if (t.type === TransactionType.Transfer) {
      if (!t.departedOn) continue
      date = t.accountId === accountId ? t.departedOn : (t.receivedOn ?? null)
      if (t.accountId === accountId && t.returnedOn && t.returnedOn >= openingDate && t.returnedOn <= asOf) sum += fromAmount(t.amount)
    }
    if (!date || date < openingDate || date > asOf) continue
    const amount = fromAmount(t.amount)
    sum += t.type === TransactionType.Income ? amount : t.type === TransactionType.Expense ? -amount : t.accountId === accountId ? -amount : amount
  }
  return sum
}

// Every kind of row the page lists (the #344 review's parity fixture, by kind).
const ROWS: TransactionDto[] = [
  tx({ id: 'salary', type: TransactionType.Income, payee: 'Salary', amount: 2500, date: '2026-06-28' }),
  tx({ id: 'rent', payee: 'Rent', amount: 950, date: '2026-06-01' }),
  tx({ id: 'refund', type: TransactionType.Income, payee: 'Refund', amount: 19.99, date: '2026-06-05', refundOfTransactionId: 'x' }),
  tx({ id: 'old', payee: 'Before opening', amount: 70, date: '2026-04-12' }),
  // Out and completed.
  transfer({ id: 'out', amount: 200, date: '2026-06-03', departedOn: '2026-06-03', receivedOn: '2026-06-04', transferStatus: 'Completed' }),
  // Out and sent back, both after the opening date: it never moved the balance.
  transfer({ id: 'bounced', amount: 150, date: '2026-06-12', departedOn: '2026-06-12', returnedOn: '2026-06-15', transferStatus: 'Returned' }),
  // #344 P3-1: left on 20 Apr (before the opening date), came back on 10 May.
  transfer({ id: 'came-back', payee: 'To Pot', amount: 75, date: '2026-04-20', departedOn: '2026-04-20', returnedOn: '2026-05-10', transferStatus: 'Returned' }),
  // Left and came back before the opening date: history only.
  transfer({ id: 'old-bounce', amount: 40, date: '2026-04-02', departedOn: '2026-04-02', returnedOn: '2026-04-05', transferStatus: 'Returned' }),
  // Out, still in transit: it left this account.
  transfer({ id: 'in-transit-out', amount: 30, date: '2026-07-02', departedOn: '2026-07-02', transferStatus: 'InTransit' }),
  // Into this account: received; still in transit; held for review; never arrived (returned).
  transfer({ id: 'in', accountId: 'a2', accountName: 'Pot', transferAccountId: A, transferAccountName: 'Everyday', amount: 120, date: '2026-06-29', departedOn: '2026-06-29', receivedOn: '2026-07-01', transferStatus: 'Completed' }),
  transfer({ id: 'in-transit-in', accountId: 'a2', accountName: 'Pot', transferAccountId: A, amount: 55, date: '2026-07-03', departedOn: '2026-07-03', transferStatus: 'InTransit' }),
  transfer({ id: 'pending', accountId: 'a2', accountName: 'Pot', transferAccountId: A, amount: 33, date: '2026-07-04', receivedOn: '2026-07-04', departedOn: null, transferStatus: 'PendingReview' }),
  transfer({ id: 'never-came', accountId: 'a2', accountName: 'Pot', transferAccountId: A, amount: 90, date: '2026-06-10', departedOn: '2026-06-10', returnedOn: '2026-06-11', transferStatus: 'Returned' }),
  // Received in June, but sent in late April (before the opening date): it counts here on its receipt.
  transfer({ id: 'late-receipt', accountId: 'a2', accountName: 'Pot', transferAccountId: A, amount: 25, date: '2026-04-29', departedOn: '2026-04-29', receivedOn: '2026-05-02', transferStatus: 'Completed' }),
  // Another account's own row: not listed.
  tx({ id: 'elsewhere', accountId: 'a3', amount: 999 }),
]

describe('registerRows — the Account detail register against the account ledger', () => {
  it('the rows the page counts add up to the balance movement (#344 P3-1)', () => {
    const rows = registerRows(ROWS, A, OPENING)
    const listed = rows.reduce((sum, r) => sum + r.movement, 0)
    expect(listed).toBe(ledgerMovement(ROWS, A, OPENING, AS_OF))
    // By hand: 2500 − 950 + 19.99 − 200 + 75 − 30 + 120 + 25 = 1559.99.
    expect(listed).toBe(fromAmount(1559.99))
    // And each counted row's movement is the amount the page shows, with its sign.
    for (const r of rows) {
      if (r.movement !== 0) expect(r.movement).toBe((r.sign === '+' ? 1 : -1) * fromAmount(r.t.amount))
    }
  })

  it('lists a transfer that left before the opening date and came back after it on its return date, as money in', () => {
    const r = registerRows(ROWS, A, OPENING).find((x) => x.t.id === 'came-back')!
    expect(r).toMatchObject({ cameBack: true, shown: '2026-05-10', sign: '+', notCounted: false, beforeOpening: false, movement: fromAmount(75) })
    // Under May, the month of its return, not April.
    expect(r.shown.slice(0, 7)).toBe('2026-05')
  })

  it('touches no other row: the sent-back, before-opening, in-transit and pending rows read as before', () => {
    const by = Object.fromEntries(registerRows(ROWS, A, OPENING).map((r) => [r.t.id, r]))
    expect(by['bounced']).toMatchObject({ cameBack: false, notCounted: true, sign: '−', shown: '2026-06-12' })
    expect(by['old-bounce']).toMatchObject({ cameBack: false, beforeOpening: true, notCounted: true, sign: '−', shown: '2026-04-02' })
    expect(by['old']).toMatchObject({ beforeOpening: true, notCounted: true, sign: '−', movement: 0 })
    expect(by['never-came']).toMatchObject({ notCounted: true, sign: '+', movement: 0 })
    expect(by['in-transit-in']).toMatchObject({ notCounted: false, legDate: null, sign: '+', movement: 0, shown: '2026-07-03' })
    expect(by['pending']).toMatchObject({ notCounted: false, sign: '+', movement: 0 })
    expect(by['in-transit-out']).toMatchObject({ sign: '−', movement: -fromAmount(30) })
    expect(by['late-receipt']).toMatchObject({ beforeOpening: false, shown: '2026-05-02', movement: fromAmount(25) })
    expect(by['elsewhere']).toBeUndefined()
  })

  it('newest first by the date each row shows on, the server order kept within a day', () => {
    const rows = registerRows(
      [tx({ id: 'b', date: '2026-06-02' }), tx({ id: 'a1st', date: '2026-06-05' }), tx({ id: 'a2nd', date: '2026-06-05' }), transfer({ id: 'back', date: '2026-04-20', departedOn: '2026-04-20', returnedOn: '2026-06-03', transferStatus: 'Returned' })],
      A,
      OPENING,
    )
    expect(rows.map((r) => r.t.id)).toEqual(['a1st', 'a2nd', 'back', 'b'])
  })

  it('with no opening date nothing is before opening, and a sent-back transfer stays struck where it left', () => {
    const r = registerRows([transfer({ id: 'x', date: '2026-04-20', departedOn: '2026-04-20', returnedOn: '2026-05-10', transferStatus: 'Returned' })], A, null)[0]
    expect(r).toMatchObject({ cameBack: false, beforeOpening: false, notCounted: true, shown: '2026-04-20', sign: '−' })
  })
})
