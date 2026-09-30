import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import type { AccountDto, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountDetailPage } from './AccountDetailPage'

function account(): AccountDto {
  return { id: 'a1', name: 'Everyday Current', type: 0, currency: 'EUR', openingBalance: 2000, currentBalance: 2140, displayOrder: 0 }
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-06-20', payee: 'Vodafone', amount: 40, currency: 'EUR',
    type: 0, bankReference: null, budgetItemId: null, budgetItemName: null, accountId: 'a1', accountName: 'Everyday Current',
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, isSplit: false, splits: [], ...over,
  }
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/accounts/:id" element={<AccountDetailPage />} />
    </Routes>,
    { route: '/accounts/a1' },
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

  // Rule 76: the optional bank identifiers show on the detail page only when recorded.
  it('shows recorded bank identifiers and hides the card when none are recorded', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts')
        return Promise.resolve({ data: [{ ...account(), iban: 'MT84MALT011000012345MTLCAST001S', bic: 'VALLMTMT', sortCode: null, accountNumber: '' }] })
      return Promise.resolve({ data: [] })
    })

    const { unmount } = renderPage()

    expect(await screen.findByRole('heading', { name: 'Account details' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('IBAN')).toBeInTheDocument()
    expect(screen.getByText('MT84MALT011000012345MTLCAST001S')).toBeInTheDocument()
    expect(screen.getByText('BIC')).toBeInTheDocument()
    expect(screen.getByText('VALLMTMT')).toBeInTheDocument()
    // Null / blank identifiers are simply not listed.
    expect(screen.queryByText('Sort code')).not.toBeInTheDocument()
    expect(screen.queryByText('Account number')).not.toBeInTheDocument()
    unmount()

    mockGet.mockImplementation((url: string) =>
      url === '/accounts' ? Promise.resolve({ data: [account()] }) : Promise.resolve({ data: [] }),
    )
    renderPage()
    await screen.findByText(/2,000\.00|2,140\.00/, {}, { timeout: 5000 })
    expect(screen.queryByRole('heading', { name: 'Account details' })).not.toBeInTheDocument()
  })

  it('shows a not-found state for an unknown account', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url === '/accounts' ? Promise.resolve({ data: [] }) : Promise.resolve({ data: [] }),
    )

    renderPage()

    expect(await screen.findByText(/Account not found/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('flags an FX-pending row and leaves settled rows unmarked', { timeout: 15000 }, async () => {
    // fxPending = the row is in another currency and waits for its amount in the budget
    // currency; it counts nowhere until then, and the register must say so.
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

    const tag = await screen.findByText('Needs EUR amount', {}, { timeout: 5000 })
    expect(tag).toHaveAttribute('title', expect.stringContaining('Not counted anywhere until you enter the amount in EUR'))
    expect(screen.getAllByText('Needs EUR amount')).toHaveLength(1) // only the waiting row
  })
})
