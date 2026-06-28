import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AccountDto, TransactionDto } from '../types'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('../lib/api', () => ({
  api: { get: mockGet, put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AccountDetailPage } from './AccountDetailPage'
import { AuthProvider } from '../auth/AuthContext'

function account(): AccountDto {
  return { id: 'a1', name: 'Everyday Current', type: 0, currency: 'EUR', openingBalance: 2000, currentBalance: 2140, displayOrder: 0 }
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-06-20', payee: 'Vodafone', amount: 40, currency: 'EUR', exchangeRate: 1, baseAmount: 40,
    type: 0, bankReference: null, budgetItemId: null, budgetItemName: null, accountId: 'a1', accountName: 'Everyday Current',
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, isSplit: false, splits: [], ...over,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/accounts/a1']}>
      <AuthProvider>
        <Routes>
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AccountDetailPage', () => {
  beforeEach(() => mockGet.mockReset())

  it('shows the balance hero and the account’s filtered register', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions')
        return Promise.resolve({
          data: [tx(), tx({ id: 't2', payee: 'Other-account', accountId: 'zzz' })],
        })
      return Promise.resolve({ data: {} })
    })

    renderPage()

    // The hero shows the account name (eyebrow) + its balance + a Transactions tile.
    expect(await screen.findByText('Everyday Current', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/2,140\.00/)).toBeInTheDocument()
    // Only this account's transactions are listed.
    expect(screen.getByText('Vodafone')).toBeInTheDocument()
    expect(screen.queryByText('Other-account')).not.toBeInTheDocument()
    // The back link is present.
    expect(screen.getByRole('link', { name: '‹ Accounts' })).toHaveAttribute('href', '/accounts')
  })

  it('shows a not-found state for an unknown account', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/accounts' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: [] }),
    )

    renderPage()

    expect(await screen.findByText(/Account not found/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
