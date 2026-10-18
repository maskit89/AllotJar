import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MeResponse, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { TransactionsPage } from './TransactionsPage'
import { AccountsPage } from './AccountsPage'

function me(role: number): MeResponse {
  return { userId: 'u1', email: 'alex@x.com', displayName: 'Alex', role, ownerId: 'u1', memberId: null }
}

function tx(): TransactionDto {
  return {
    id: 't1', date: '2026-06-01', payee: 'Tesco', amount: 10, currency: 'EUR',
    type: 0, bankReference: null, budgetItemId: 'b1', budgetItemName: 'Groceries', accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, isSplit: false, splits: [],
  }
}

let meRole = 0

const renderPage = (node: React.ReactNode) => renderWithProviders(node, { features: true })

describe('role gating', () => {
  beforeEach(() => {
    resetApiMocks()
    meRole = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: me(meRole) })
      if (url === '/transactions') return Promise.resolve({ data: [tx()] })
      if (url === '/features') return Promise.resolve({ data: {} })
      if (url === '/budget/current') return Promise.resolve({ data: null })
      // accounts, members, reconciliation, etc.
      return Promise.resolve({ data: [] })
    })
  })

  it('read-only access hides transaction entry and edit controls, and shows a banner', async () => {
    meRole = 3 // ReadOnly

    renderPage(<TransactionsPage />)

    // The transaction itself still renders (view-only)…
    expect(await screen.findByText('Tesco', {}, { timeout: 5000 })).toBeInTheDocument()
    // …but once /auth/me resolves the role, the entry + row controls disappear.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Add transaction' })).not.toBeInTheDocument(),
    )
    expect(screen.queryByLabelText('Transaction payee')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Edit transaction: Tesco')).not.toBeInTheDocument()
    // No row ⋯ at all (so no Edit, Split or Delete behind it), and no assign control.
    expect(screen.queryByRole('button', { name: 'Tesco: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Assign Tesco')).not.toBeInTheDocument()
    // The assigned line shows as static text instead of a dropdown.
    expect(screen.getByText('Groceries')).toBeInTheDocument()
    // And the role banner explains why.
    expect(await screen.findByText(/Read-only access/)).toBeInTheDocument()
  })

  it('limited access keeps transaction entry available', async () => {
    meRole = 2 // Limited

    renderPage(<TransactionsPage />)

    expect(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 })).toBeInTheDocument()
    // The row's ⋯ offers the edit.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Tesco: more actions' }, { timeout: 5000 }))
    expect(await screen.findByRole('menuitem', { name: 'Edit transaction: Tesco' })).toBeInTheDocument()
  })

  it('limited access cannot manage accounts (admin-only)', async () => {
    meRole = 2 // Limited
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: me(meRole) })
      if (url === '/accounts') return Promise.resolve({ data: [{ id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 }] })
      return Promise.resolve({ data: [] })
    })

    renderPage(<AccountsPage />)

    // The account is listed…
    expect(await screen.findByText('Everyday', {}, { timeout: 5000 })).toBeInTheDocument()
    // …but the add form and per-row actions are gone for a non-admin.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument())
    expect(screen.queryByLabelText('Edit Everyday')).not.toBeInTheDocument()
    // The card has no ⋯ at all: only an (i) with what its note says.
    expect(screen.queryByRole('button', { name: 'Everyday: more actions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Everyday' })).toBeInTheDocument()
  })

  it('owner sees full account management', async () => {
    meRole = 0 // Owner
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: me(meRole) })
      if (url === '/accounts') return Promise.resolve({ data: [{ id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 }] })
      return Promise.resolve({ data: [] })
    })

    renderPage(<AccountsPage />)

    expect(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 })).toBeInTheDocument()
    // The card's ⋯ offers the edit and the delete.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Everyday: more actions' }, { timeout: 5000 }))
    expect(await screen.findByRole('menuitem', { name: 'Edit Everyday' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete Everyday' })).toBeInTheDocument()
  })
})
