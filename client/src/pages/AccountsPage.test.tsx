import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountsPage } from './AccountsPage'
import { setMoneyFormat } from '../lib/money'
import { accountAction, accountCard, accountItems, accountNote } from '../test/rowMenu'

function accounts(): AccountDto[] {
  return [
    { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, openingDate: '2026-01-01', currentBalance: 250, displayOrder: 0 },
    { id: 'a2', name: 'Visa', type: 3, currency: 'EUR', openingBalance: 0, openingDate: '2026-01-01', currentBalance: -75, displayOrder: 1 },
  ]
}

const renderPage = () => renderWithProviders(<AccountsPage />)

describe('AccountsPage', () => {
  afterEach(() => setMoneyFormat('comma-dot'))

  beforeEach(() => {
    resetApiMocks()
  })

  it('lists account cards with balances and a net total in the hero', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? accounts() : [] }))

    renderPage()

    // Each account renders as a card.
    expect(await screen.findByText('Everyday', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
    // A credit-card account recorded before rule 75 still labels its card as one: its type tile
    // is named by the type.
    expect(within(accountCard('Visa')).getByRole('img', { name: 'Credit card' })).toBeInTheDocument()
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

  // W13 (rules 30–33): a joint account names its holders; the holder of a private account sees
  // it marked and can share it with the household.
  it('shows who holds each account and lets the holder share a private one', { timeout: 15000 }, async () => {
    // The server's reason for P55, word for word (AccountSharing.HoldsJarReason).
    const SAVINGS_REASON =
      "'Savings' holds the jar 'Holiday'. Jars are part of the household budget, so the account behind one stays visible to everyone (rule 33)."
    const joint: AccountDto = {
      ...accounts()[0], id: 'j1', name: 'Joint',
      holders: [{ memberId: 'm1', name: 'Chris' }, { memberId: 'm2', name: 'Sam' }],
    }
    const mine: AccountDto = {
      ...accounts()[0], id: 'p1', name: 'Pocket', isPrivate: true, canChangeSharing: true,
      holders: [{ memberId: 'm1', name: 'Chris' }],
    }
    const savings: AccountDto = {
      ...accounts()[0], id: 's1', name: 'Savings', isPrivate: false, canChangeSharing: true,
      holders: [{ memberId: 'm1', name: 'Chris' }], sharingBlockedReason: SAVINGS_REASON,
    }
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? [joint, mine, savings] : [] }))
    mockPut.mockResolvedValue({ data: { ...mine, isPrivate: false } })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText('Held by Chris and Sam', {}, { timeout: 5000 })).toBeInTheDocument()
    // That the account is joint is the first line of its ⋯ note, after its type (and before
    // its currency, which multiCurrency, on by default, adds).
    const jointNote = await accountNote(user, 'Joint')
    expect(jointNote[0]).toBe('Current · joint · EUR')
    // The avatars show initials: the note names the holders.
    expect(jointNote[1]).toBe('Held by Chris and Sam')
    expect(within(accountCard('Pocket')).getByText('Private')).toBeInTheDocument()
    expect(await accountNote(user, 'Pocket')).toContain('Only you can see this account.')
    // P55: an account a jar uses stays visible to the household and says why (the server's reason,
    // which says both, once), with no Make private item.
    const savingsNote = await accountNote(user, 'Savings')
    expect(savingsNote).toContain(SAVINGS_REASON)
    expect(savingsNote.filter((line) => /visible/i.test(line))).toEqual([SAVINGS_REASON])
    expect((await accountItems(user, 'Savings')).map((i) => i.name)).not.toContain('Make Savings private')

    await accountAction(user, 'Pocket', 'Share Pocket with the household')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/p1/sharing', { isPrivate: false }))
    await waitFor(() => expect(within(accountCard('Pocket')).queryByText('Private')).not.toBeInTheDocument())
    expect((await accountItems(user, 'Pocket')).map((i) => i.name)).toContain('Make Pocket private')
  })

  // P59 (Christopher, 30 September 2026): the owner sees accounts private to a login that left
  // the household by name and entry count only, and erases one behind its typed name.
  it('lets the owner erase a private account nobody can reach, after typing its name', { timeout: 15000 }, async () => {
    const gone = { id: 'u1', name: 'Sam’s wallet', currency: 'EUR', holderName: 'Sam', privateSinceUtc: '2026-06-01T00:00:00Z', entryCount: 3 }
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { role: 0, memberId: 'm1', email: 'chris@example.com' } })
      if (url === '/accounts') return Promise.resolve({ data: accounts() })
      if (url === '/accounts/unreachable') return Promise.resolve({ data: [gone] })
      return Promise.resolve({ data: [] })
    })
    mockPost.mockResolvedValue({ status: 204 })
    const user = userEvent.setup()

    renderPage()

    const section = within(await screen.findByTestId('unreachable-accounts', {}, { timeout: 5000 }))
    expect(section.getByText('Private accounts nobody can reach')).toBeInTheDocument()
    expect(section.getByText('Sam’s wallet')).toBeInTheDocument()
    expect(section.getByText(/Sam · 3 entries · EUR/)).toBeInTheDocument()

    await user.click(section.getByRole('button', { name: 'Erase Sam’s wallet' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const confirm = dialog.getByRole('button', { name: 'Confirm erase Sam’s wallet' })
    expect(confirm).toBeDisabled()
    await user.type(dialog.getByLabelText(/Type .* to confirm/), 'Sam’s wal')
    expect(confirm).toBeDisabled()
    await user.type(dialog.getByLabelText(/Type .* to confirm/), 'let')
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/accounts/u1/erase', { confirmName: 'Sam’s wallet' }))
    await waitFor(() => expect(screen.queryByTestId('unreachable-accounts')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The shared accounts are read again: the erase may have dropped a movement they counted.
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/accounts')).toHaveLength(2))
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/accounts/reconciliation').length).toBeGreaterThanOrEqual(2))
  })

  it('shows the server’s reason when an erase is refused', { timeout: 15000 }, async () => {
    const gone = { id: 'u1', name: 'Wallet', currency: 'EUR', holderName: 'Sam', privateSinceUtc: '2026-06-01T00:00:00Z', entryCount: 1 }
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { role: 0, memberId: 'm1', email: 'chris@example.com' } })
      if (url === '/accounts') return Promise.resolve({ data: accounts() })
      if (url === '/accounts/unreachable') return Promise.resolve({ data: [gone] })
      return Promise.resolve({ data: [] })
    })
    mockPost.mockRejectedValue({ response: { status: 400, data: { errors: { Id: ["1 refund in another account is linked to a purchase in 'Wallet'. Unlink or delete them on the Transactions page first."] } } } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Erase Wallet' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText(/Type .* to confirm/), 'wallet')
    await user.click(dialog.getByRole('button', { name: 'Confirm erase Wallet' }))

    expect(await dialog.findByText(/1 refund in another account is linked/)).toBeInTheDocument()
    expect(screen.getByTestId('unreachable-accounts')).toBeInTheDocument()
  })

  it('shows no unreachable-accounts section to a login that is not the owner', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { role: 1, memberId: 'm1', email: 'sam@example.com' } })
      if (url === '/accounts') return Promise.resolve({ data: accounts() })
      return Promise.resolve({ data: [] })
    })

    renderPage()

    expect(await screen.findByText('Everyday', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    // The server answers a non-owner with an empty list, and an empty list shows nothing.
    expect(screen.queryByTestId('unreachable-accounts')).not.toBeInTheDocument()
  })

  // Rule 31: an account you add that only you hold starts private unless you untick it.
  it('adds an account you hold alone as private, and a joint one as shared', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { role: 0, memberId: 'm1', email: 'chris@example.com' } })
      if (url === '/members') return Promise.resolve({ data: [
        { id: 'm1', name: 'Chris', netMonthlyIncome: 0, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0 },
        { id: 'm2', name: 'Sam', netMonthlyIncome: 0, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0 },
      ] })
      return Promise.resolve({ data: [] })
    })
    mockPost.mockResolvedValue({ data: { id: 'a9', name: 'Pocket', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 } })
    const user = userEvent.setup()

    renderWithProviders(<AccountsPage />, { household: true })

    await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Account name'), 'Pocket')
    await user.click(await dialog.findByLabelText('Held by Chris'))
    expect(dialog.getByLabelText('Keep this account private')).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ holderIds: ['m1'], isPrivate: true })),
    )

    mockPost.mockClear()
    mockPost.mockResolvedValue({ data: { id: 'a10', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1 } })
    await user.click(await screen.findByRole('button', { name: 'Add account' }))
    const again = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(again.getByLabelText('Account name'), 'Joint')
    await user.click(again.getByLabelText('Held by Chris'))
    await user.click(again.getByLabelText('Held by Sam'))
    expect(again.queryByLabelText('Keep this account private')).not.toBeInTheDocument()
    await user.click(again.getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>
    expect(body.holderIds).toEqual(['m1', 'm2'])
    expect(body).not.toHaveProperty('isPrivate')
  })

  it('deletes an account after confirming', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? accounts() : [] }))
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Everyday', 'Delete Everyday')
    // Deleting now asks for confirmation, explaining transactions are kept.
    expect(await screen.findByText(/transactions are kept/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm delete Everyday' }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/accounts/a1'))
    await waitFor(() => expect(screen.queryByText('Everyday')).not.toBeInTheDocument())
  })

  it.each([1.234, 33.3333])('preserves an unchanged opening balance of %s with comma decimals', async (openingBalance) => {
    localStorage.setItem('zbb.numberFormat', 'dot-comma')
    const account = { ...accounts()[0], openingBalance, currentBalance: openingBalance }
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? [account] : [] }))
    mockPut.mockResolvedValue({ data: account })
    const user = userEvent.setup()

    renderPage()
    await accountAction(user, 'Everyday', 'Edit Everyday')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a1', {
      name: 'Everyday', type: 0, openingBalance, openingDate: '2026-01-01',
      iban: null, bic: null, sortCode: null, accountNumber: null, version: null,
    }))
  })

  // Rule 76: optional bank identifiers ride along on create and edit, blank → null.
  it('sends the optional bank identifiers on add and edit, and edits prefill them', { timeout: 15000 }, async () => {
    const withIds = { ...accounts()[0], iban: 'MT84MALT011000012345MTLCAST001S', bic: 'VALLMTMT', sortCode: '40-47-84', accountNumber: '12345678' }
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? [withIds] : [] }))
    mockPost.mockResolvedValue({ data: { id: 'a9', name: 'Piggy', type: 2, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1 } })
    mockPut.mockResolvedValue({ data: withIds })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Account name'), 'Piggy')
    await user.type(dialog.getByLabelText('IBAN'), 'DE89 3704 0044 0532 0130 00')
    await user.type(dialog.getByLabelText('BIC'), 'COBADEFF')
    // Sort code / account number left blank → null on the wire.
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({
        name: 'Piggy', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFF', sortCode: null, accountNumber: null,
      })),
    )

    await accountAction(user, 'Everyday', 'Edit Everyday')
    expect(screen.getByLabelText('IBAN for Everyday')).toHaveValue('MT84MALT011000012345MTLCAST001S')
    expect(screen.getByLabelText('BIC for Everyday')).toHaveValue('VALLMTMT')
    expect(screen.getByLabelText('Sort code for Everyday')).toHaveValue('40-47-84')
    expect(screen.getByLabelText('Account number for Everyday')).toHaveValue('12345678')
    await user.clear(screen.getByLabelText('Account number for Everyday'))
    await user.type(screen.getByLabelText('Account number for Everyday'), '87654321')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a1', {
      name: 'Everyday', type: 0, openingBalance: 100, openingDate: '2026-01-01',
      iban: 'MT84MALT011000012345MTLCAST001S', bic: 'VALLMTMT', sortCode: '40-47-84', accountNumber: '87654321',
      version: null,
    }))
  })

  // Rule 74: no account opens below zero — refused before any request, and a server 400 is shown as-is.
  it('rejects a negative opening balance client-side and surfaces the server message otherwise', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({ data: [] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Account name'), 'Visa')
    await user.type(dialog.getByLabelText('Opening balance'), '-450')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    expect(await dialog.findByText('An opening balance can’t be negative.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    mockPost.mockRejectedValue({ response: { status: 400, data: { errors: { OpeningBalance: ['No account may have a negative balance.'] } } } })
    await user.clear(dialog.getByLabelText('Opening balance'))
    await user.type(dialog.getByLabelText('Opening balance'), '450')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    expect(await dialog.findByText('No account may have a negative balance.')).toBeInTheDocument()
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
    // Why sits behind the (i) beside it.
    fireEvent.focus(screen.getByRole('button', { name: 'Why Everyday has no balance' }))
    expect((await screen.findByRole('tooltip', {}, { timeout: 5000 })).textContent).toBe('Set an opening date to calculate the balance.')
    expect(screen.getByText(/1 account with no balance before its opening date is not counted/)).toBeInTheDocument()
    // Only Visa (−75) is counted in the hero.
    expect(screen.getByLabelText(/^Total balance:/)).toHaveTextContent('75.00')

    await accountAction(user, 'Everyday', 'Edit Everyday')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    expect(await screen.findByText('Enter the date the opening balance applies from.')).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Opening date for Everyday'), '2026-03-01')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a1', {
      name: 'Everyday', type: 0, openingBalance: 100, openingDate: '2026-03-01',
      iban: null, bic: null, sortCode: null, accountNumber: null, version: null,
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
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/accounts' ? accounts() : [] }))
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Everyday', 'Delete Everyday')
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
