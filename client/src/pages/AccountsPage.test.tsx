import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto } from '../types'

const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AccountsPage } from './AccountsPage'
import { AuthProvider } from '../auth/AuthContext'

function accounts(): AccountDto[] {
  return [
    { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, currentBalance: 250, displayOrder: 0 },
    { id: 'a2', name: 'Visa', type: 3, currency: 'EUR', openingBalance: 0, currentBalance: -75, displayOrder: 1 },
  ]
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AccountsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AccountsPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
  })

  it('lists account cards with balances and a net total in the hero', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: accounts() })

    renderPage()

    // Each account renders as a card.
    expect(await screen.findByText('Everyday', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
    // The credit card's type badge shows on its card (the add-form select also lists it).
    expect(screen.getAllByText('Credit card').length).toBeGreaterThan(0)
    // Net across the two accounts (250 + (−75) = 175) is the hero's Total balance.
    expect(screen.getByText(/175.00/)).toBeInTheDocument()
  })

  it('adds an account', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: [] })
    mockPost.mockResolvedValue({
      data: { id: 'a9', name: 'Wallet', type: 2, currency: 'EUR', openingBalance: 40, currentBalance: 40, displayOrder: 0 },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Account name'), 'Wallet')
    await user.selectOptions(screen.getByLabelText('Account type'), '2')
    await user.type(screen.getByLabelText('Opening balance'), '40')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/accounts',
        expect.objectContaining({ name: 'Wallet', type: 2, currency: 'EUR', openingBalance: 40 }),
      ),
    )
    // The new account appears as a card.
    expect(await screen.findByText('Wallet', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('deletes an account', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: accounts() })
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Delete Everyday', {}, { timeout: 5000 }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/accounts/a1'))
    await waitFor(() => expect(screen.queryByText('Everyday')).not.toBeInTheDocument())
  })

  it('shows an empty state when there are no accounts', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: [] })

    renderPage()

    expect(await screen.findByText(/No accounts yet/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
