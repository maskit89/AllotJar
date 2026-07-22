import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AccountDto, TransactionDto } from '../types'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
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

    // The account name shows as the page heading (sr-only h1) and the hero eyebrow.
    expect((await screen.findAllByText('Everyday Current', {}, { timeout: 5000 })).length).toBeGreaterThan(0)
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

  it('flags an FX-pending row and leaves settled rows unmarked', { timeout: 15000 }, async () => {
    // fxPending = the server resolved no exchange rate (amount counts at face value);
    // the register must say so instead of presenting the figure as settled.
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions')
        return Promise.resolve({
          data: [
            tx({ id: 't-pending', payee: 'London Cab', currency: 'GBP', fxPending: true }),
            tx({ id: 't-settled' }),
          ],
        })
      return Promise.resolve({ data: {} })
    })

    renderPage()

    const tag = await screen.findByText('Rate pending', {}, { timeout: 5000 })
    expect(tag).toHaveAttribute('title', expect.stringContaining('face value'))
    expect(screen.getAllByText('Rate pending')).toHaveLength(1) // only the unresolved row
  })
})
