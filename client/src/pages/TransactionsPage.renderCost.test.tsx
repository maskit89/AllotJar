import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TransactionDto } from '../types'

// Client P3-1 (end-to-end check 30 Sep): every keystroke in an inline field re-renders the whole
// register, and each row rebuilt its own budget-line options. They are built once per render now.
const { spy } = vi.hoisted(() => ({ spy: { buildItemOptions: undefined as unknown as ReturnType<typeof vi.fn>, tiles: 0 } }))
vi.mock('../lib/transactions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/transactions')>()
  spy.buildItemOptions = vi.fn(real.buildItemOptions)
  return { ...real, buildItemOptions: spy.buildItemOptions }
})
// Restyle PR 5 review (P1): each row is a memoised component. A row draws its icon tile once per
// render of its line, so counting the tiles counts the rows that rendered.
vi.mock('../components/transactions/TxParts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/transactions/TxParts')>()
  return {
    ...real,
    TxTile: (props: Parameters<typeof real.TxTile>[0]) => {
      spy.tiles++
      return real.TxTile(props)
    },
  }
})
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { txAction } from '../test/rowMenu'
import { TransactionsPage } from './TransactionsPage'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

const ROWS = 60

function tx(i: number): TransactionDto {
  return {
    // About five a day, newest first, back from 10 June 2026, so the rows fall into day groups.
    id: `t${i}`, date: new Date(Date.UTC(2026, 5, 10) - Math.floor(i / 5) * 86_400_000).toISOString().slice(0, 10), payee: `Payee ${i}`, amount: 10 + i, currency: 'EUR', type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null, transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null, isSplit: false, splits: [],
  }
}

describe('TransactionsPage: the cost of one keystroke in the register', () => {
  beforeEach(() => {
    resetApiMocks()
    mockGet.mockImplementation((url: string) => {
      if (url === '/transactions') return Promise.resolve({ data: Array.from({ length: ROWS }, (_, i) => tx(i)) })
      if (url === '/accounts' || url === '/members' || url === '/jars/ledger') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: {} })
      return Promise.resolve({
        data: budgetMonth({
          categories: [budgetCategory({ id: 'c1', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1000 })] })],
        }),
      })
    })
  })

  it('typing one character in a row’s amount field builds the line options once per render, not once per row', { timeout: 30000 }, async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)
    await screen.findByText('Payee 0', {}, { timeout: 10000 })
    await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(ROWS))

    await txAction(user, 'Payee 0', 'Edit transaction: Payee 0')
    const amount = await screen.findByLabelText('Edit amount')
    spy.buildItemOptions.mockClear()

    await user.type(amount, '5')

    const calls = spy.buildItemOptions.mock.calls.length
    // A keystroke re-renders the page a few times; each render builds the options a fixed number of times.
    expect(calls).toBeLessThan(20)
  })

  it('a keystroke in a row’s editor or in the search renders no other row', { timeout: 30000 }, async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)
    await screen.findByText('Payee 0', {}, { timeout: 10000 })
    await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(ROWS))

    // Typing in the edit form: the form takes its row's place, and the other rows stay as they are.
    await txAction(user, 'Payee 0', 'Edit transaction: Payee 0')
    const payee = await screen.findByLabelText('Edit payee')
    spy.tiles = 0
    await user.type(payee, 'ab')
    expect(spy.tiles).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))

    // Typing in the search: the rows that still match are not drawn again.
    await user.click(screen.getByRole('button', { name: 'Search transactions' }))
    const search = screen.getByRole('searchbox', { name: 'Search transactions' })
    await user.type(search, 'Payee 1')
    await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(11)) // 1, 10–19
    spy.tiles = 0
    await user.type(search, '2')
    await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(1))
    expect(spy.tiles).toBe(0)
  })
})
