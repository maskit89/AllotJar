import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AccountsPage } from './AccountsPage'
import { AuthProvider } from '../auth/AuthContext'
import { setMoneyFormat } from '../lib/money'

function accounts(): AccountDto[] {
  return [
    { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, openingDate: '2026-01-01', currentBalance: 250, displayOrder: 0 },
    { id: 'a2', name: 'Visa', type: 3, currency: 'EUR', openingBalance: 0, openingDate: '2026-01-01', currentBalance: -75, displayOrder: 1 },
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
  afterEach(() => setMoneyFormat('comma-dot'))

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

  it('deletes an account after confirming', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: accounts() })
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Delete Everyday', {}, { timeout: 5000 }))
    // Deleting now asks for confirmation, explaining transactions are kept.
    expect(await screen.findByText(/transactions are kept/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm delete Everyday' }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/accounts/a1'))
    await waitFor(() => expect(screen.queryByText('Everyday')).not.toBeInTheDocument())
  })

  it.each([1.234, -1.234, 33.3333])('preserves an unchanged opening balance of %s with comma decimals', async (openingBalance) => {
    localStorage.setItem('zbb.numberFormat', 'dot-comma')
    const account = { ...accounts()[0], openingBalance, currentBalance: openingBalance }
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? [account] : [] }))
    mockPut.mockResolvedValue({ data: account })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit Everyday' }))
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a1', {
      name: 'Everyday', type: 0, openingBalance, openingDate: '2026-01-01',
    }))
  })

  // Rule 40/67: an account recorded before opening dates existed has no calculable balance. The
  // card says so (never zero), the hero leaves it out, and an edit must supply the date before
  // anything is sent.
  it('shows a legacy account without an opening date as unavailable and requires the date on edit', { timeout: 15000 }, async () => {
    const legacy = { ...accounts()[0], openingDate: null, currentBalance: null, openingDateMissing: true }
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? [legacy, accounts()[1]] : [] }))
    mockPut.mockResolvedValue({ data: { ...legacy, openingDate: '2026-03-01', currentBalance: 250, openingDateMissing: false } })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText('Not available', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Set an opening date to calculate the balance.')).toBeInTheDocument()
    expect(screen.getByText(/1 account without an opening date is not counted/)).toBeInTheDocument()
    // Only Visa (−75) is counted in the hero.
    expect(screen.getByLabelText(/^Total balance:/)).toHaveTextContent('75.00')

    await user.click(screen.getByRole('button', { name: 'Edit Everyday' }))
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    expect(await screen.findByText('Enter the date the opening balance applies from.')).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Opening date for Everyday'), '2026-03-01')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a1', {
      name: 'Everyday', type: 0, openingBalance: 100, openingDate: '2026-03-01',
    }))
    expect((await screen.findAllByText(/250\.00/, {}, { timeout: 5000 })).length).toBeGreaterThan(0)
  })

  // Rules 69/72: money in transit and receipts held for review are visible per account.
  it('flags in-transit money and pending receipts on the account cards', { timeout: 15000 }, async () => {
    const flagged = [
      { ...accounts()[0], inTransitOut: 100, currentBalance: 150 },
      { ...accounts()[1], inTransitIn: 100, pendingReceiptCount: 1, pendingReceiptTotal: 40, requiresReview: true },
    ]
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? flagged : [] }))

    renderPage()

    expect(await screen.findByText(/100\.00 in transit out/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/100\.00 in transit in/)).toBeInTheDocument()
    expect(screen.getByText('1 receipt pending review')).toBeInTheDocument()
    expect(screen.getByText(/1 transfer receipt pending review/)).toBeInTheDocument()
  })

  it('does not delete when the confirmation is cancelled', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: accounts() })
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Delete Everyday', {}, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(mockDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Everyday')).toBeInTheDocument()
  })

  it('shows an empty state when there are no accounts', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: [] })

    renderPage()

    expect(await screen.findByText(/No accounts yet/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
