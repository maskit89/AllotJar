import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// Client P3-6: two reloads in flight (two saves in a row) can answer in either order; only the
// latest read lands, so an older ledger never overwrites a newer one.
vi.mock('./api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { useJarLedgers } from './jarLedgers'
import type { JarAccountLedgerDto } from '../types'

function ledger(balance: number): JarAccountLedgerDto[] {
  return [{
    accountId: 'a1', accountName: 'Savings', currency: 'EUR', asOf: '2026-10-15', accountBalance: balance,
    unallocated: balance, positiveAllocations: 0, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
    jars: [],
  }]
}

describe('useJarLedgers: reloads', () => {
  beforeEach(() => resetApiMocks())

  it('keeps the latest reload when an earlier one answers last', async () => {
    mockGet.mockResolvedValueOnce({ data: ledger(100) })
    const { result } = renderHook(() => useJarLedgers())
    await waitFor(() => expect(result.current.loaded).toBe(true))

    const answers: Array<(value: { data: JarAccountLedgerDto[] }) => void> = []
    mockGet.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    let first!: Promise<void>, second!: Promise<void>
    act(() => {
      first = result.current.reload()
      second = result.current.reload()
    })
    await act(async () => {
      answers[1]({ data: ledger(300) })
      await second
      answers[0]({ data: ledger(200) })
      await first
    })

    expect(result.current.ledgers[0].accountBalance).toBe(300)
  })
})
