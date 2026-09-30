import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
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

  // Rules 40/74: a row dated before the opening balance is history only; it never changes the
  // balance, so it is marked and its amount is struck through rather than read as a movement.
  it('marks rows dated before the opening date as history only', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [{ ...account(), openingDate: '2026-06-01' }] })
      if (url === '/transactions')
        return Promise.resolve({ data: [tx(), tx({ id: 't0', date: '2026-05-20', payee: 'Old phone bill', amount: 25 })] })
      return Promise.resolve({ data: {} })
    })

    renderPage()

    const old = (await screen.findByText('Old phone bill', {}, { timeout: 5000 })).closest('tr')!
    expect(within(old).getByText('Before opening')).toBeInTheDocument()
    expect(within(old).getByText(/25\.00/).className).toContain('line-through')
    const recent = screen.getByText('Vodafone').closest('tr')!
    expect(within(recent).queryByText('Before opening')).not.toBeInTheDocument()
    expect(within(recent).getByText(/40\.00/).className).not.toContain('line-through')
  })

  // The leg this account posts decides (#286 P2-2): a transfer departed before the opening date
  // but received after it moved this balance on its receipt; one that left before the opening
  // date is history here unless it came back after it; a receipt not yet confirmed is pending.
  it('judges a transfer against the opening date by this account’s own leg', { timeout: 15000 }, async () => {
    const leg = (over: Partial<TransactionDto>) =>
      tx({ type: 2, accountName: 'Everyday Current', transferAccountName: 'Rainy Day', ...over })
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [{ ...account(), openingDate: '2026-06-01' }] })
      if (url === '/transactions')
        return Promise.resolve({
          data: [
            leg({ id: 't-in', date: '2026-05-30', payee: 'Top up', amount: 200, accountId: 'a2', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Everyday Current', departedOn: '2026-05-30', receivedOn: '2026-06-02' }),
            leg({ id: 't-out', date: '2026-05-20', payee: 'Old move', amount: 60, transferAccountId: 'a2', departedOn: '2026-05-20', receivedOn: '2026-05-21' }),
            leg({ id: 't-back', date: '2026-05-25', payee: 'Bounced', amount: 75, transferAccountId: 'a2', departedOn: '2026-05-25', receivedOn: null, returnedOn: '2026-06-03', transferStatus: 'Returned' }),
            leg({ id: 't-pending', date: '2026-05-31', payee: 'On its way', amount: 30, accountId: 'a2', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Everyday Current', departedOn: '2026-05-31', receivedOn: null, transferStatus: 'InTransit' }),
          ],
        })
      return Promise.resolve({ data: {} })
    })

    renderPage()

    const received = (await screen.findByText('Top up', {}, { timeout: 5000 })).closest('tr')!
    expect(within(received).queryByText('Before opening')).not.toBeInTheDocument()
    expect(within(received).getByText(/200\.00/).className).not.toContain('line-through')
    expect(within(received).getByText(/Jun 2/)).toBeInTheDocument()
    const left = screen.getByText('Old move').closest('tr')!
    expect(within(left).getByText('Before opening')).toBeInTheDocument()
    const returned = screen.getByText('Bounced').closest('tr')!
    expect(within(returned).queryByText('Before opening')).not.toBeInTheDocument()
    const pending = screen.getByText('On its way').closest('tr')!
    expect(within(pending).queryByText('Before opening')).not.toBeInTheDocument()
  })
})
