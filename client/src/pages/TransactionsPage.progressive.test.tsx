import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { txAction } from '../test/rowMenu'
import { TransactionsPage } from './TransactionsPage'
import { budgetMonth } from '../test/fixtures/budget'

// The browser's observer, never reporting the end of the list in view: only the first batch is drawn.
class NeverInView {
  observe() {}
  disconnect() {}
}

// 300 rows, one a day back from 30 June 2026, newest first.
function rows(): TransactionDto[] {
  return Array.from({ length: 300 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5, 30 - i))
    return {
      id: `t${i}`, date: d.toISOString().slice(0, 10), payee: `Shop ${i}`, amount: 10, currency: 'EUR',
      type: 0, bankReference: null,
      budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
      transferAccountId: null, transferAccountName: null,
      memberId: null, memberName: null,
      isSplit: false, splits: [],
    }
  })
}

describe('TransactionsPage with a long history', () => {
  beforeEach(() => {
    resetApiMocks()
    vi.stubGlobal('IntersectionObserver', NeverInView)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('draws the first batch, and keeps a row a date edit moves into the rest drawn and focused', { timeout: 20000 }, async () => {
    const list = rows()
    mockGet.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/transactions' ? list : url === '/budget/current' ? budgetMonth({ key: '2026-06', month: 6 }) : [] }),
    )
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)

    expect(await screen.findByText('Shop 0', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-tx-id]')).toHaveLength(60)
    expect(screen.queryByText('Shop 250')).not.toBeInTheDocument()

    // Shop 0 moves back to before Shop 250: far past the drawn batch.
    const moved = { ...list[0], date: list[251].date }
    mockPut.mockResolvedValue({ data: moved })
    await txAction(user, 'Shop 0', 'Edit transaction: Shop 0')
    fireEvent.change(screen.getByLabelText('Edit date'), { target: { value: moved.date } })
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() => expect(mockPut).toHaveBeenCalled())
    await waitFor(() => {
      const row = document.querySelector('[data-tx-id="t0"]')
      expect(row).not.toBeNull()
      expect(row!.contains(document.activeElement)).toBe(true)
    })
    // Still drawn after the focus has landed and nothing holds it any more.
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('[data-tx-id="t0"]')).not.toBeNull()
    expect(document.querySelector('[data-tx-id="t0"]')!.contains(document.activeElement)).toBe(true)
  })
})
