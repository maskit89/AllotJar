import { describe, expect, it } from 'vitest'
import { archivedJarNamed, readLedgers } from './jarLedgers'
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
