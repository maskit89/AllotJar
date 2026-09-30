import { describe, expect, it } from 'vitest'
import { archivedJarNamed, archivedJarNewlyNamed, jarsForAnswer, readLedgers, storedSharesOf } from './jarLedgers'
import type { JarAccountLedgerDto } from '../types'

function ledger(over: Partial<JarAccountLedgerDto> = {}): JarAccountLedgerDto {
  return {
    accountId: 'a1', accountName: 'Savings', currency: 'EUR', asOf: '2026-09-29', accountBalance: 500,
    unallocated: 200, positiveAllocations: 300, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
    jars: [
      { jarId: 'j-hol', name: 'Holiday', balance: 300, isArchived: false },
      { jarId: 'j-car', name: 'Car', balance: 0, isArchived: true },
    ],
    ...over,
  }
}

describe('readLedgers', () => {
  it('keeps well-formed ledgers and drops anything else', () => {
    expect(readLedgers(null)).toEqual([])
    expect(readLedgers([ledger(), { accountId: 7 }, null])).toEqual([ledger()])
  })

  it('reads a jar balance as unavailable when its account balance is (rule 67)', () => {
    const [l] = readLedgers([ledger({ accountBalance: null, unallocated: null })])
    expect(l.jars.map((j) => j.balance)).toEqual([null, null])
  })
})

describe('archivedJarNamed', () => {
  it('finds an archived jar an answer still names, and nothing else', () => {
    expect(archivedJarNamed(ledger(), ['j-car'])?.name).toBe('Car')
    expect(archivedJarNamed(ledger(), ['j-hol', ''])).toBeNull()
    expect(archivedJarNamed(undefined, ['j-car'])).toBeNull()
  })
})

// P3-10, relaxed after #283: an archived jar's stored share sent back unchanged is the entry's
// history and passes; a jar newly named, a changed share, or one on a re-dated entry is stopped.
describe('archivedJarNewlyNamed', () => {
  const ledger: JarAccountLedgerDto = {
    accountId: 'a1', accountName: 'Joint', currency: 'EUR', asOf: '2026-09-30', accountBalance: 100, unallocated: 100,
    positiveAllocations: 0, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
    jars: [
      { jarId: 'j-live', name: 'Car', balance: 0, isArchived: false },
      { jarId: 'j-old', name: 'Holiday', balance: 0, isArchived: true },
    ],
  }
  const stored = new Map([['j-old', 100]])

  it('passes the stored share echoed unchanged on an unchanged entry', () => {
    expect(archivedJarNewlyNamed(ledger, [['j-old', 100]], stored, true)).toBeNull()
    expect(archivedJarNewlyNamed(ledger, [['j-live', 5], ['j-old', 100]], stored, true)).toBeNull()
  })

  it('stops a changed share, a re-dated entry, or an archived jar newly named', () => {
    expect(archivedJarNewlyNamed(ledger, [['j-old', 120]], stored, true)?.name).toBe('Holiday')
    expect(archivedJarNewlyNamed(ledger, [['j-old', 100]], stored, false)?.name).toBe('Holiday')
    expect(archivedJarNewlyNamed(ledger, [['j-old', 100]], new Map(), true)?.name).toBe('Holiday')
    expect(archivedJarNewlyNamed(undefined, [['j-old', 100]], new Map(), true)).toBeNull()
  })

  it('reads the stored shares of one account by direction', () => {
    const allocations = [
      { accountId: 'a1', jarId: 'j-old', jarName: 'Holiday', amount: -100 },
      { accountId: 'a1', jarId: 'j-live', jarName: 'Car', amount: 30 },
      { accountId: 'a2', jarId: 'j-old', jarName: 'Holiday', amount: 100 },
    ]
    expect([...storedSharesOf(allocations, 'a1', 'out')]).toEqual([['j-old', 100]])
    expect([...storedSharesOf(allocations, 'a1', 'in')]).toEqual([['j-live', 30]])
    expect(jarsForAnswer(ledger, ['j-old']).map((j) => j.name)).toEqual(['Car', 'Holiday'])
    expect(jarsForAnswer(ledger, [null]).map((j) => j.name)).toEqual(['Car'])
  })
})
