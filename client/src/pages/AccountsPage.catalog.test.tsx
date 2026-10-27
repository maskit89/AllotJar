import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, AccountReconciliationDto } from '../types'

// Same shared api mock as AccountsPage.test.tsx and the other *.catalog.test.tsx files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountsPage } from './AccountsPage'
// Real (unmocked) money module — pin the active display locale so every €/£ string
// asserted below renders in the design's canonical en-GB comma-dot format
// (€1,234.56), independent of test-execution order.
import { setMoneyFormat } from '../lib/money'
import { accountAction, accountCard, accountItems, accountNote } from '../test/rowMenu'

function acct(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'a1', name: 'Account', type: 0, currency: 'EUR', openingBalance: 0, openingDate: '2026-01-01', currentBalance: 0, displayOrder: 0, ...over }
}

interface ApiSetup {
  accounts?: AccountDto[]
  reconciliation?: AccountReconciliationDto[]
  features?: Record<string, unknown>
  accountsError?: boolean
  reconciliationError?: boolean
}

// Route the endpoints AccountsPage + AuthProvider (+ optional FeatureProvider) hit on
// mount: /accounts, /accounts/reconciliation, /auth/me, /features. A non-numeric
// /auth/me leaves AuthContext at its Owner default (canWrite = true).
function mockLoads(s: ApiSetup = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') {
      return s.accountsError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: s.accounts ?? [] })
    }
    if (url === '/accounts/reconciliation') {
      return s.reconciliationError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: s.reconciliation ?? [] })
    }
    if (url === '/features') return Promise.resolve({ data: s.features ?? {} })
    return Promise.resolve({ data: {} })
  })
}

const renderPage = () => renderWithProviders(<AccountsPage />)

// A variant with a real FeatureProvider so a mocked GET /features can toggle multiCurrency.
const renderPageWithFeatures = () => renderWithProviders(<AccountsPage />, { features: true })

// Open the Add-account modal and return a `within` scope bound to its dialog.
async function openAddModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('AccountsPage — catalog (ACCT)', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56 / £200.00
    mockLoads()
  })

  // --- List & balance hero -------------------------------------------------

  it('ACCT-002: a negative balance colours its card rose and is left out of Available; there is no Owed tile (rule 74)', { timeout: 15000 }, async () => {
    // Single all-EUR CreditCard with opening −450, so the hero is unanimous.
    mockLoads({ accounts: [acct({ id: 'v1', name: 'Visa', type: 3, openingBalance: -450, currentBalance: -450 })] })

    renderPage()

    // The card balance renders in the bad (red) tone. −€450.00 also appears as the hero amount,
    // so look in the card.
    await screen.findAllByText('-€450.00', {}, { timeout: 5000 })
    expect(within(accountCard('Visa')).getByText('-€450.00').className).toContain('text-bad')

    // Hero: Total −450, Available 0 (Σ max(0,bal)) under it; no Owed tile (rule 74 keeps every account at or above zero).
    expect(screen.getByLabelText('Total balance: -€450.00')).toBeInTheDocument()
    expect(screen.getByText('€0.00 available')).toBeInTheDocument()
    expect(screen.queryByText('Owed')).not.toBeInTheDocument()
    expect(screen.queryByText('€450.00')).not.toBeInTheDocument()
    // Every account is in the budget currency ⇒ no "not counted" footnote.
    expect(screen.queryByText(/in another currency/i)).not.toBeInTheDocument()
  })

  it('ACCT-004: one currency labels the hero in it, no footnote, cards keep their own currency', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1250, currentBalance: 1250 }),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 }),
      ],
    })

    const user = userEvent.setup()

    renderPage()

    // Totals are labelled in the budget currency (EUR); total 1,750, no pill.
    expect(await screen.findByLabelText('Total balance: €1,750.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/in another currency/i)).not.toBeInTheDocument()
    // Per-account balances on the cards, and "Opening …" in each ⋯ note, in the account's own currency.
    expect(within(accountCard('Joint')).getByText('€1,250.00')).toBeInTheDocument()
    expect(within(accountCard('Rainy Day')).getByText('€500.00')).toBeInTheDocument()
    expect(await accountNote(user, 'Joint')).toContainEqual(expect.stringMatching(/^Opening €1,250\.00/))
    expect(await accountNote(user, 'Rainy Day')).toContainEqual(expect.stringMatching(/^Opening €500\.00/))
    expect(screen.getByRole('heading', { name: 'Your accounts' })).toBeInTheDocument()
  })

  it('ACCT-005: an account in another currency is left out of the totals and called out; cards keep their currency', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1250, currentBalance: 1250 }),
        acct({ id: 'uk1', name: 'UK Pot', currency: 'GBP', openingBalance: 200, currentBalance: 200 }),
      ],
    })

    const user = userEvent.setup()

    renderPage()

    // The app never converts: only the budget-currency (EUR) account counts, 1,250 not 1,450.
    expect(await screen.findByLabelText('Total balance: €1,250.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('1 account in another currency is not counted.')).toBeInTheDocument()
    expect(screen.queryByText(/Totals shown in/)).not.toBeInTheDocument()
    // Each card still formats in its own currency (€ vs £); €1,250.00 is also the hero's
    // Available tile now that it is the only counted account.
    expect(screen.getAllByText('€1,250.00').length).toBeGreaterThanOrEqual(1)
    expect(within(accountCard('UK Pot')).getByText('£200.00')).toBeInTheDocument()
    // The card says which currency it holds, and its note's opening is in it.
    expect(within(accountCard('UK Pot')).getByText('GBP')).toBeInTheDocument()
    expect(await accountNote(user, 'UK Pot')).toContainEqual(expect.stringMatching(/^Opening £200\.00/))
  })

  it('ACCT-008: a card carries its currency, its type and an overlay link to its detail', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1 })] })
    const user = userEvent.setup()

    renderPage()

    await screen.findByText('Rainy Day', {}, { timeout: 5000 })
    // The type (from ACCOUNT_TYPE_LABELS, Savings) names the card's icon tile, and the ⋯ note
    // leads with it and the currency (only said because multiCurrency is on).
    expect(within(accountCard('Rainy Day')).getByRole('img', { name: 'Savings' })).toBeInTheDocument()
    expect((await accountNote(user, 'Rainy Day'))[0]).toBe('Savings · EUR')
    // Whole-card overlay link to the detail page.
    const link = screen.getByRole('link', { name: 'View Rainy Day' })
    expect(link).toHaveAttribute('href', '/accounts/rd1')
  })

  it('ACCT-006: a failed accounts load shows the page error banner', { timeout: 15000 }, async () => {
    mockLoads({ accountsError: true })

    renderPage()

    expect(await screen.findByText('Could not load your accounts.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // --- Adding an account ---------------------------------------------------

  it('ACCT-010: each type maps to its numeric wire value and badge label', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({
      data: acct({ id: 's1', name: 'Pot', type: 1, openingBalance: 0, currentBalance: 0 }),
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    // The Type select offers Current / Savings / Cash / Other — credit cards are not accounts (rule 75).
    const typeSelect = dialog.getByLabelText('Account type')
    for (const label of ['Current', 'Savings', 'Cash', 'Other']) {
      expect(within(typeSelect).getByRole('option', { name: label })).toBeInTheDocument()
    }
    expect(within(typeSelect).queryByRole('option', { name: 'Credit card' })).not.toBeInTheDocument()
    await user.type(dialog.getByLabelText('Account name'), 'Pot')
    await user.selectOptions(typeSelect, '1') // Savings
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'Pot', type: 1 })),
    )
    // The new card's type tile is named by the matching label.
    const card = await screen.findByRole('article', { name: 'Pot' }, { timeout: 5000 })
    expect(within(card).getByRole('img', { name: 'Savings' })).toBeInTheDocument()
  })

  it('ACCT-011: editing a legacy credit-card account keeps its type selectable, but a new account never offers it', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'v1', name: 'Visa', type: 3, openingBalance: 0, currentBalance: -450 })] })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Visa', 'Edit Visa')
    const typeSelect = screen.getByLabelText('Type for Visa') as HTMLSelectElement
    expect(typeSelect.value).toBe('3')
    expect(within(typeSelect).getByRole('option', { name: 'Credit card' })).toBeInTheDocument()
  })

  it('ACCT-012: a blank opening and "0" both post an opening balance of 0', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost
      .mockResolvedValueOnce({ data: acct({ id: 'b1', name: 'Blank', currentBalance: 0 }) })
      .mockResolvedValueOnce({ data: acct({ id: 'z1', name: 'Zero', currentBalance: 0 }) })
    const user = userEvent.setup()

    renderPage()

    // First add: leave Opening blank.
    let dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Blank')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenNthCalledWith(1, '/accounts', expect.objectContaining({ openingBalance: 0 })),
    )

    // Second add: Opening "0".
    dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Zero')
    await user.type(dialog.getByLabelText('Opening balance'), '0')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenNthCalledWith(2, '/accounts', expect.objectContaining({ openingBalance: 0 })),
    )
  })

  it('ACCT-013: an empty name is rejected client-side before any request', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Opening balance'), '100')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    expect(await screen.findByText('Give the account a name.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('ACCT-014: an unparseable opening amount is rejected client-side (abc / 1.2.3 / 1,2,3)', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Test')
    const opening = dialog.getByLabelText('Opening balance')

    for (const bad of ['abc', '1.2.3', '1,2,3']) {
      await user.clear(opening)
      await user.type(opening, bad)
      await user.click(dialog.getByRole('button', { name: 'Add account' }))
      expect(await screen.findByText('Enter a valid opening balance.', {}, { timeout: 5000 })).toBeInTheDocument()
      expect(mockPost).not.toHaveBeenCalled()
    }
  })

  it('ACCT-015 (D1): a many-decimal opening is refused with a message, never rounded; European grouping is tolerated', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValueOnce({ data: acct({ id: 'g1', name: 'Grouped', openingBalance: 1234.5, currentBalance: 1234.5 }) })
    const user = userEvent.setup()

    renderPage()

    // 1234.56785 has more decimals than cents: refused, nothing sent.
    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Grouped')
    await user.type(dialog.getByLabelText('Opening balance'), '1234.56785')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    expect(await dialog.findByText('Enter at most 2 decimal places.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // "1.234,50" → right-most separator (comma) is the decimal → 1234.50.
    await user.clear(dialog.getByLabelText('Opening balance'))
    await user.type(dialog.getByLabelText('Opening balance'), '1.234,50')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenNthCalledWith(1, '/accounts', expect.objectContaining({ openingBalance: 1234.5 })),
    )
  })

  it('ACCT-016/017: a server-rejected create surfaces only the generic add error', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockRejectedValue(new Error('400')) // e.g. opening out of range, or name > 120 chars
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Too big')
    await user.type(dialog.getByLabelText('Opening balance'), '100000000000000')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    // A POST fired (client is range-agnostic) but only the fixed generic string shows.
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    expect(await screen.findByText('Could not add that account.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('ACCT-018: the add form has no currency picker; the POST uses the budget currency, not the preference', { timeout: 15000 }, async () => {
    // The hero shows once there is an account; this one holds the budget currency.
    mockLoads({ accounts: [acct({ id: 'g0', name: 'Current', currency: 'GBP' })] })
    const base = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string) =>
      url === '/auth/me'
        ? Promise.resolve({
            data: { userId: 'u1', email: 'a@x.com', displayName: 'A', role: 0, ownerId: 'u1', memberId: null,
              preferredCurrency: 'EUR', budgetCurrency: 'GBP', currencyLocked: true },
          })
        : base(url),
    )
    mockPost.mockResolvedValue({ data: acct({ id: 'f1', name: 'Pot', currency: 'GBP' }) })
    const user = userEvent.setup()

    renderPage()

    // The hero is labelled in the budget currency once /auth/me answers.
    await screen.findByLabelText('Total balance: £0.00', {}, { timeout: 5000 })
    const dialog = await openAddModal(user)
    expect(dialog.queryByLabelText('Account currency')).not.toBeInTheDocument()
    expect(dialog.getByText('The account holds GBP, your budget currency.')).toBeInTheDocument()

    await user.type(dialog.getByLabelText('Account name'), 'Pot')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ currency: 'GBP' })),
    )
  })

  it('ACCT-019: with multiCurrency off only an account in another currency keeps its currency chip', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'a1', name: 'Everyday' }), acct({ id: 'uk1', name: 'UK Pot', currency: 'GBP' })],
      features: { multiCurrency: false },
    })
    const user = userEvent.setup()

    renderPageWithFeatures()

    // Once the flag load settles the budget currency leaves the ⋯ note (the flag starts on by
    // default before /features resolves); the GBP account still says what it holds, on its card.
    await screen.findByText('Everyday', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Everyday: more actions' }))
    const menu = await screen.findByRole('menu', {}, { timeout: 5000 })
    await waitFor(() => expect(menu).not.toHaveAccessibleDescription(/EUR/), { timeout: 5000 })
    expect(menu).toHaveAccessibleDescription(/^Current Opening/)
    await user.keyboard('{Escape}')
    expect(screen.queryByText('EUR')).not.toBeInTheDocument()
    expect(within(accountCard('UK Pot')).getByText('GBP')).toBeInTheDocument()
    expect(within(accountCard('Everyday')).queryByText('GBP')).not.toBeInTheDocument()
  })

  it('ACCT-020: pressing Enter in the opening field submits the add', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({ data: acct({ id: 'e1', name: 'ViaEnter', openingBalance: 50, currentBalance: 50 }) })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'ViaEnter')
    await user.type(dialog.getByLabelText('Opening balance'), '50{Enter}')

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'ViaEnter', openingBalance: 50 })),
    )
  })

  it('ACCT-020: Cancel closes the modal without a request', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Discarded')
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('ACCT-021: a whitespace-only name is rejected; a unicode name is accepted and trimmed', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({ data: acct({ id: 'u1', name: 'Ünïçödé Jar' }) })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    const name = dialog.getByLabelText('Account name')

    // Spaces only → trimmed empty → blocked.
    await user.type(name, '   ')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByText('Give the account a name.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // A unicode name passes and posts trimmed.
    await user.clear(name)
    await user.type(name, 'Ünïçödé Jar')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'Ünïçödé Jar' })),
    )
  })

  // --- Editing an account --------------------------------------------------

  it('ACCT-023: editing name, type and opening PUTs no currency field', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 })] })
    mockPut.mockResolvedValue({
      data: acct({ id: 'rd1', name: 'Emergency', type: 0, openingBalance: 750, currentBalance: 900 }),
    })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Rainy Day', 'Edit Rainy Day')
    const nameInput = screen.getByLabelText('Name for Rainy Day')
    await user.clear(nameInput)
    await user.type(nameInput, 'Emergency')
    await user.selectOptions(screen.getByLabelText('Type for Rainy Day'), '0') // Current
    const openingInput = screen.getByLabelText('Opening balance for Rainy Day')
    await user.clear(openingInput)
    await user.type(openingInput, '750')
    expect(openingInput).toHaveValue('750')
    await user.click(screen.getByLabelText('Save Rainy Day'))

    // Exact body ⇒ proves the request carries no `currency` key.
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/accounts/rd1', { name: 'Emergency', type: 0, openingBalance: 750, openingDate: '2026-01-01', version: null }),
    )
    expect(await screen.findByText('Emergency', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('ACCT-024: currency is immutable on edit — a read-only note, no input, PUT carries no currency', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'uk1', name: 'UK Pot', type: 1, currency: 'GBP', openingBalance: 200, currentBalance: 200 })] })
    mockPut.mockResolvedValue({
      data: acct({ id: 'uk1', name: 'UK Pot', type: 1, currency: 'GBP', openingBalance: 200, currentBalance: 200 }),
    })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'UK Pot', 'Edit UK Pot')
    // No currency input, just the read-only note carrying the fixed currency.
    const note = screen.getByText(/fixed once created/i)
    expect(note.textContent).toContain('GBP')
    expect(screen.queryByLabelText('Account currency')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Save UK Pot'))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/accounts/uk1', { name: 'UK Pot', type: 1, openingBalance: 200, openingDate: '2026-01-01', version: null }),
    )
  })

  it('ACCT-025: the opening field pre-fills as a plain (non-localized) decimal', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'p1', name: 'Pennies', openingBalance: 1234.5, currentBalance: 1234.5 })] })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Pennies', 'Edit Pennies')
    // Plain "1234.5" (dot decimal, no grouping comma), not the localized "1,234.5".
    expect(screen.getByLabelText('Opening balance for Pennies')).toHaveValue('1234.5')
  })

  it('ACCT-026: editing to an empty name (or invalid opening) is blocked before any request', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 })] })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Rainy Day', 'Edit Rainy Day')
    const nameInput = screen.getByLabelText('Name for Rainy Day')
    await user.clear(nameInput)
    await user.click(screen.getByLabelText('Save Rainy Day'))
    expect(await screen.findByText('Give the account a name.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()

    // Restore a name but break the opening → the other guard fires.
    await user.type(nameInput, 'Rainy Day')
    const openingInput = screen.getByLabelText('Opening balance for Rainy Day')
    await user.clear(openingInput)
    await user.type(openingInput, 'abc')
    await user.click(screen.getByLabelText('Save Rainy Day'))
    expect(await screen.findByText('Enter a valid opening balance.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('ACCT-027: a failed edit save shows the generic error and keeps the card in edit mode', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 })] })
    mockPut.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Rainy Day', 'Edit Rainy Day')
    const nameInput = screen.getByLabelText('Name for Rainy Day')
    await user.clear(nameInput)
    await user.type(nameInput, 'Emergency')
    await user.click(screen.getByLabelText('Save Rainy Day'))

    expect(await screen.findByText('Could not save that account.', {}, { timeout: 5000 })).toBeInTheDocument()
    // Still in edit mode (the inline card, with a re-enabled Save button, remains).
    const save = screen.getByLabelText('Save Rainy Day')
    expect(save).toBeInTheDocument()
    expect(save).not.toBeDisabled()
  })

  it('ACCT-028: cancelling an edit reverts to the card with no request', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 })] })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Rainy Day', 'Edit Rainy Day')
    const nameInput = screen.getByLabelText('Name for Rainy Day')
    await user.clear(nameInput)
    await user.type(nameInput, 'Zzz Discarded')
    await user.click(screen.getByLabelText('Cancel edit'))

    // Back to the persisted card; the typed change is discarded and no PUT fired.
    expect(await screen.findByText('Rainy Day', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Name for Rainy Day')).not.toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // --- Deleting an account -------------------------------------------------

  it('ACCT-033: the delete modal shows only the name — never the currency or balance', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'uk1', name: 'UK Pot', currency: 'GBP', openingBalance: 200, currentBalance: 200 })] })
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'UK Pot', 'Delete UK Pot')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Delete UK Pot?')).toBeInTheDocument()
    expect(dialog.getByText(/transactions are kept/i)).toBeInTheDocument()
    // The modal deliberately omits the account's currency and balance.
    expect(dialog.queryByText('GBP')).not.toBeInTheDocument()
    expect(dialog.queryByText('£200.00')).not.toBeInTheDocument()
  })

  it('ACCT-034: a failed delete shows the generic error and keeps the card', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'a1', name: 'Everyday', openingBalance: 100, currentBalance: 250 })] })
    mockDelete.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Everyday', 'Delete Everyday')
    await user.click(await screen.findByRole('button', { name: 'Delete account' }))

    expect(await screen.findByText('Could not delete that account.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Everyday')).toBeInTheDocument()
  })

  it('ACCT-036: the delete affordance is disabled while that account is deleting', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'a1', name: 'Everyday', openingBalance: 100, currentBalance: 250 })] })
    // Hold the DELETE open so the in-flight (savingId) state is observable.
    let resolveDelete: (v: unknown) => void = () => {}
    mockDelete.mockReturnValue(new Promise((r) => { resolveDelete = r }))
    const user = userEvent.setup()

    renderPage()

    await accountAction(user, 'Everyday', 'Delete Everyday')
    await user.click(await screen.findByRole('button', { name: 'Delete account' }))

    // While the request is pending the ⋯'s Delete is disabled (prevents a double-submit).
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/accounts/a1'))
    expect(await accountItems(user, 'Everyday')).toContainEqual({ name: 'Delete Everyday', disabled: true })

    resolveDelete({ data: null })
    await waitFor(() => expect(screen.queryByText('Everyday')).not.toBeInTheDocument(), { timeout: 5000 })
  })

  // --- What the jars hold of each account (the reconciliation) -------------

  it('ACCT-052: an account that backs a jar shows its balance, what its jars hold and what is not in jars', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 })],
      reconciliation: [
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 600, backedJarCount: 1, float: 450 },
      ],
    })
    const user = userEvent.setup()

    renderPage()

    const jars = within(await screen.findByTestId('account-jars', {}, { timeout: 5000 }))
    const card = within(accountCard('Joint'))
    expect(card.getByTestId('account-jars')).toBeInTheDocument()
    expect(card.getByText('€1,050.00')).toBeInTheDocument() // Balance
    expect(jars.getByText('1 jar')).toBeInTheDocument()
    // In jars: the exact amount in the ⋯ note (the bar draws it), and the KPI tile's total.
    expect(await accountNote(user, 'Joint')).toContain('€600.00 in jars')
    expect(screen.getByRole('group', { name: 'In jars' })).toHaveTextContent('€600.00')
    // Not in jars (never "Float") 450 = 1050 − 600, positive ⇒ slate (not red); jars are backed ⇒ no warning.
    expect(screen.getByRole('group', { name: 'Not in jars' })).toHaveTextContent('€450.00')
    expect(screen.queryByText(/Float/)).not.toBeInTheDocument()
    const notInJars = jars.getByText('€450.00 not in jars')
    expect(notInJars.parentElement!.className).not.toContain('text-bad')
    // The bar (decorative: the caption says it) fills by what the jars hold of the balance, 600 of 1,050.
    const fill = card.getByTestId('account-jars').firstElementChild!.firstElementChild as HTMLElement
    expect(fill.style.width).toMatch(/^57\.14/)
    expect(fill.className).not.toContain('bg-bad')
    expect(jars.queryByText('Jars exceed account money')).not.toBeInTheDocument()
  })

  it('ACCT-055: a backing deficit (rule 70) shows the "Jars exceed account money" badge on that row', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 350, currentBalance: 350 }),
        acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 }),
      ],
      reconciliation: [
        // Holiday −50 + Repairs 400 = 350 signed, but positive jars (400) exceed the account (350).
        { accountId: 'r1', accountName: 'Rainy Day', currentBalance: 350, backedJarsTotal: 350, backedJarCount: 2, float: 0, hasBackingDeficit: true },
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 600, backedJarCount: 1, float: 450, hasBackingDeficit: false },
      ],
    })

    renderPage()

    await screen.findAllByTestId('account-jars', {}, { timeout: 5000 })
    const rainy = within(within(accountCard('Rainy Day')).getByTestId('account-jars'))
    const deficit = rainy.getByText('Jars exceed account money')
    expect(deficit.parentElement!.className).toContain('text-bad')
    expect(rainy.getByRole('button', { name: 'About the shortfall in Rainy Day' })).toBeInTheDocument()
    const joint = within(within(accountCard('Joint')).getByTestId('account-jars'))
    expect(joint.queryByText('Jars exceed account money')).not.toBeInTheDocument()
    expect(joint.getByText('€450.00 not in jars')).toBeInTheDocument()
  })

  it('ACCT-053: the reconciliation card is hidden when no account backs a jar', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 })],
      reconciliation: [
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 0, backedJarCount: 0, float: 1050 },
      ],
    })

    renderPage()

    await screen.findByText('Joint', {}, { timeout: 5000 })
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/accounts/reconciliation'))
    expect(screen.queryByText('Jar reconciliation')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // No card has a jar bar, and the KPI row has no jar tiles.
    expect(screen.queryByTestId('account-jars')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'In jars' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Not in jars' })).not.toBeInTheDocument()
  })

  it('ACCT-054: negative money not in jars renders in red as what the jars hold over the account (a shortfall)', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 700, currentBalance: 700 })],
      reconciliation: [
        { accountId: 'r1', accountName: 'Rainy Day', currentBalance: 700, backedJarsTotal: 1200, backedJarCount: 1, float: -500 },
      ],
    })

    renderPage()

    const jars = within(await screen.findByTestId('account-jars', {}, { timeout: 5000 }))
    const over = jars.getByText('€500.00 over')
    expect(over.parentElement!.className).toContain('text-bad')
    const fill = screen.getByTestId('account-jars').firstElementChild!.firstElementChild as HTMLElement
    expect(fill.className).toContain('bg-bad')
    expect(fill.style.width).toBe('100%')
    expect(jars.queryByText(/not in jars/)).not.toBeInTheDocument()
    // The Not in jars tile counts the shortfall against the total, in red as on the card.
    const notInJars = screen.getByRole('group', { name: 'Not in jars' })
    expect(notInJars).toHaveTextContent('-€500.00')
    expect(within(notInJars).getByText('-€500.00').className).toContain('text-bad')
    expect(within(screen.getByRole('group', { name: 'In jars' })).getByText('€1,200.00').className).not.toContain('text-bad')
  })

  it('ACCT-056: reconciliation money cells use each account’s own currency', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'uk1', name: 'UK Pot', currency: 'GBP', openingBalance: 200, currentBalance: 200 }),
        acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 }),
      ],
      reconciliation: [
        { accountId: 'uk1', accountName: 'UK Pot', currentBalance: 200, backedJarsTotal: 150, backedJarCount: 1, float: 50 },
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 600, backedJarCount: 1, float: 450 },
      ],
    })

    const user = userEvent.setup()

    renderPage()

    await screen.findAllByTestId('account-jars', {}, { timeout: 5000 })
    // The GBP card in £, the EUR card in €.
    const uk = within(accountCard('UK Pot'))
    expect(uk.getByText('£200.00')).toBeInTheDocument()
    expect(uk.getByText('£50.00 not in jars')).toBeInTheDocument()
    expect(await accountNote(user, 'UK Pot')).toContain('£150.00 in jars')
    const joint = within(accountCard('Joint'))
    expect(joint.getByText('€1,050.00')).toBeInTheDocument()
    expect(joint.getByText('€450.00 not in jars')).toBeInTheDocument()
    expect(await accountNote(user, 'Joint')).toContain('€600.00 in jars')
    // The tiles add up the budget currency only: the GBP jars are left out, as the total leaves the account out.
    expect(screen.getByRole('group', { name: 'In jars' })).toHaveTextContent('€600.00')
    expect(screen.getByRole('group', { name: 'Not in jars' })).toHaveTextContent('€450.00')
  })

  it('ACCT-056: a failed reconciliation fetch is swallowed silently (no error banner)', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 })],
      reconciliationError: true,
    })

    renderPage()

    // The accounts still render and no page-level error banner appears.
    await screen.findByText('Joint', {}, { timeout: 5000 })
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/accounts/reconciliation'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Jar reconciliation')).not.toBeInTheDocument()
    // Nothing about jars shows: no bar on the card, no jar tiles.
    expect(screen.queryByTestId('account-jars')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'In jars' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Total balance: €1,050.00')).toBeInTheDocument()
  })
})
