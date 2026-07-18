import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, AccountReconciliationDto } from '../types'

// Same api-control harness as AccountsPage.test.tsx and the other *.catalog.test.tsx
// files: vi.hoisted so the mock factory can close over the fns, importOriginal spread
// so the rest of api.ts (refreshSession, setSessionHandlers, isAccessTokenExpired, …)
// keeps working — AuthProvider reaches into them on mount.
const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AccountsPage } from './AccountsPage'
import { AuthProvider } from '../auth/AuthContext'
import { FeatureProvider } from '../features/FeatureContext'
// Real (unmocked) money module — pin the active display locale so every €/£ string
// asserted below renders in the design's canonical en-GB comma-dot format
// (€1,234.56), independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

function acct(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'a1', name: 'Account', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0, ...over }
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

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AccountsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// A variant with a real FeatureProvider so a mocked GET /features can toggle multiCurrency.
function renderPageWithFeatures() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <FeatureProvider>
          <AccountsPage />
        </FeatureProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

// Open the Add-account modal and return a `within` scope bound to its dialog.
async function openAddModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('AccountsPage — catalog (ACCT)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56 / £200.00
    mockLoads()
  })

  // --- List & balance hero -------------------------------------------------

  it('ACCT-002: a negative balance colours its card rose and feeds the Owed tile', { timeout: 15000 }, async () => {
    // Single all-EUR CreditCard with opening −450, so the hero is unanimous.
    mockLoads({ accounts: [acct({ id: 'v1', name: 'Visa', type: 3, openingBalance: -450, currentBalance: -450 })] })

    renderPage()

    // The card balance renders in rose. −€450.00 also appears as the hero amount,
    // so pick the occurrence carrying the rose class.
    const negs = await screen.findAllByText('-€450.00', {}, { timeout: 5000 })
    expect(negs.some((el) => el.className.includes('text-rose-600'))).toBe(true)

    // Hero: Total −450, Available 0 (Σ max(0,bal)), Owed 450 (−Σ min(0,bal)).
    expect(screen.getByLabelText('Total balance: -€450.00')).toBeInTheDocument()
    expect(screen.getByText('€0.00')).toBeInTheDocument() // Available
    expect(screen.getByText('€450.00')).toBeInTheDocument() // Owed
    // Unanimous currency ⇒ no mixed-currency footnote.
    expect(screen.queryByText(/some accounts hold another currency/i)).not.toBeInTheDocument()
  })

  it('ACCT-004: one currency labels the hero in it, no footnote, cards keep their own currency', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1250, currentBalance: 1250 }),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 }),
      ],
    })

    renderPage()

    // heroCurrency === the single currency (EUR); total 1,750 labelled in EUR, no pill.
    expect(await screen.findByLabelText('Total balance: €1,750.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/some accounts hold another currency/i)).not.toBeInTheDocument()
    // Per-account balances + "Opening …" captions in the account's own currency.
    expect(screen.getByText('€1,250.00')).toBeInTheDocument()
    expect(screen.getByText('€500.00')).toBeInTheDocument()
    expect(screen.getByText('Opening €1,250.00')).toBeInTheDocument()
    expect(screen.getByText('Opening €500.00')).toBeInTheDocument()
    expect(screen.getByText('Your accounts')).toBeInTheDocument()
  })

  it('ACCT-005: mixed currencies show the raw sum, a footnote pill, and per-currency cards', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1250, currentBalance: 1250 }),
        acct({ id: 'uk1', name: 'UK Pot', currency: 'GBP', openingBalance: 200, currentBalance: 200 }),
      ],
    })

    renderPage()

    // Raw cross-currency sum 1,250 + 200 = 1,450, labelled in the preferred currency (EUR).
    expect(await screen.findByLabelText('Total balance: €1,450.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Totals shown in EUR; some accounts hold another currency.')).toBeInTheDocument()
    // Each card still formats in its own currency (€ vs £).
    expect(screen.getByText('€1,250.00')).toBeInTheDocument()
    expect(screen.getByText('£200.00')).toBeInTheDocument()
    expect(screen.getByText('Opening £200.00')).toBeInTheDocument()
  })

  it('ACCT-008: a card carries a currency chip, a type badge and an overlay link to its detail', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1 })] })

    renderPage()

    await screen.findByText('Rainy Day', {}, { timeout: 5000 })
    // Currency chip (only shown because multiCurrency is on).
    expect(screen.getByText('EUR')).toBeInTheDocument()
    // Type badge from ACCOUNT_TYPE_LABELS (Savings).
    expect(screen.getByText('Savings')).toBeInTheDocument()
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
    // The Type select offers every ACCOUNT_TYPE_LABELS entry.
    const typeSelect = dialog.getByLabelText('Account type')
    for (const label of ['Current', 'Savings', 'Cash', 'Credit card', 'Other']) {
      expect(within(typeSelect).getByRole('option', { name: label })).toBeInTheDocument()
    }
    await user.type(dialog.getByLabelText('Account name'), 'Pot')
    await user.selectOptions(typeSelect, '1') // Savings
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'Pot', type: 1 })),
    )
    // The new card's type badge reads the matching label.
    expect(await screen.findByText('Savings', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('ACCT-011: a negative opening balance is accepted (credit-card debt)', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({
      data: acct({ id: 'v1', name: 'Visa', type: 3, openingBalance: -450, currentBalance: -450 }),
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Visa')
    await user.selectOptions(dialog.getByLabelText('Account type'), '3') // Credit card
    await user.type(dialog.getByLabelText('Opening balance'), '-450')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ openingBalance: -450, type: 3 })),
    )
    // The resulting card shows the debt in rose and feeds the Owed tile.
    const negs = await screen.findAllByText('-€450.00', {}, { timeout: 5000 })
    expect(negs.some((el) => el.className.includes('text-rose-600'))).toBe(true)
    expect(screen.getByText('€450.00')).toBeInTheDocument() // Owed tile
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

  it('ACCT-015: a many-decimal opening rounds half-up to 4dp; European grouping is tolerated', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost
      .mockResolvedValueOnce({ data: acct({ id: 'p1', name: 'Precise', openingBalance: 1234.5679, currentBalance: 1234.5679 }) })
      .mockResolvedValueOnce({ data: acct({ id: 'g1', name: 'Grouped', openingBalance: 1234.5, currentBalance: 1234.5 }) })
    const user = userEvent.setup()

    renderPage()

    // 1234.56785 → 4dp half-up on the 5th digit → 1234.5679.
    let dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Precise')
    await user.type(dialog.getByLabelText('Opening balance'), '1234.56785')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenNthCalledWith(1, '/accounts', expect.objectContaining({ openingBalance: 1234.5679 })),
    )

    // "1.234,50" → right-most separator (comma) is the decimal → 1234.50.
    dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Grouped')
    await user.type(dialog.getByLabelText('Opening balance'), '1.234,50')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenNthCalledWith(2, '/accounts', expect.objectContaining({ openingBalance: 1234.5 })),
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

  it('ACCT-018: the currency select defaults to preferred, notes immutability, and resets after add', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({ data: acct({ id: 'f1', name: 'Foreign', currency: 'GBP' }) })
    const user = userEvent.setup()

    renderPage()

    let dialog = await openAddModal(user)
    const currency = dialog.getByLabelText('Account currency') as HTMLSelectElement
    expect(currency.value).toBe('EUR') // defaults to preferredCurrency
    expect(dialog.getByText(/currency is fixed once created/i)).toBeInTheDocument()

    await user.type(dialog.getByLabelText('Account name'), 'Foreign')
    await user.selectOptions(currency, 'GBP')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ currency: 'GBP' })),
    )

    // Reopening the modal resets the select back to the preferred currency.
    dialog = await openAddModal(user)
    expect((dialog.getByLabelText('Account currency') as HTMLSelectElement).value).toBe('EUR')
  })

  it('ACCT-019: with multiCurrency off there is no currency picker and the POST uses the preferred currency', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'a1', name: 'Everyday' })], features: { multiCurrency: false } })
    mockPost.mockResolvedValue({ data: acct({ id: 'n1', name: 'Second' }) })
    const user = userEvent.setup()

    renderPageWithFeatures()

    // Once the flag load settles, the card currency chip disappears — our signal that
    // multiCurrency is now off (it starts on by default before /features resolves).
    await screen.findByText('Everyday', {}, { timeout: 5000 })
    await waitFor(() => expect(screen.queryByText('EUR')).not.toBeInTheDocument(), { timeout: 5000 })

    const dialog = await openAddModal(user)
    expect(dialog.queryByLabelText('Account currency')).not.toBeInTheDocument()
    expect(dialog.queryByText(/fixed once created/i)).not.toBeInTheDocument()

    await user.type(dialog.getByLabelText('Account name'), 'Second')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ currency: 'EUR' })),
    )
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

    await user.click(await screen.findByLabelText('Edit Rainy Day', {}, { timeout: 5000 }))
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
      expect(mockPut).toHaveBeenCalledWith('/accounts/rd1', { name: 'Emergency', type: 0, openingBalance: 750 }),
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

    await user.click(await screen.findByLabelText('Edit UK Pot', {}, { timeout: 5000 }))
    // No currency input, just the read-only note carrying the fixed currency.
    const note = screen.getByText(/fixed once created/i)
    expect(note.textContent).toContain('GBP')
    expect(screen.queryByLabelText('Account currency')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Save UK Pot'))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/accounts/uk1', { name: 'UK Pot', type: 1, openingBalance: 200 }),
    )
  })

  it('ACCT-025: the opening field pre-fills as a plain (non-localized) decimal', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'p1', name: 'Pennies', openingBalance: 1234.5, currentBalance: 1234.5 })] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Pennies', {}, { timeout: 5000 }))
    // Plain "1234.5" (dot decimal, no grouping comma), not the localized "1,234.5".
    expect(screen.getByLabelText('Opening balance for Pennies')).toHaveValue('1234.5')
  })

  it('ACCT-026: editing to an empty name (or invalid opening) is blocked before any request', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'rd1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 })] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Rainy Day', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Edit Rainy Day', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Edit Rainy Day', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Delete UK Pot', {}, { timeout: 5000 }))
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

    await user.click(await screen.findByLabelText('Delete Everyday', {}, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Confirm delete Everyday' }))

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

    await user.click(await screen.findByLabelText('Delete Everyday', {}, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Confirm delete Everyday' }))

    // While the request is pending the card's ✕ is disabled (prevents a double-submit).
    await waitFor(() => expect(screen.getByLabelText('Delete Everyday')).toBeDisabled(), { timeout: 5000 })

    resolveDelete({ data: null })
    await waitFor(() => expect(screen.queryByText('Everyday')).not.toBeInTheDocument(), { timeout: 5000 })
  })

  // --- Jar reconciliation panel --------------------------------------------

  it('ACCT-052: the reconciliation table renders Balance / In jars / Float when an account backs a jar', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 })],
      reconciliation: [
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 600, backedJarCount: 1, float: 450 },
      ],
    })

    renderPage()

    expect(await screen.findByText('Jar reconciliation', {}, { timeout: 5000 })).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('Joint')).toBeInTheDocument()
    expect(table.getByText('€1,050.00')).toBeInTheDocument() // Balance
    expect(table.getByText('€600.00')).toBeInTheDocument() // In jars
    // Float 450 = 1050 − 600, positive ⇒ slate (not rose).
    const float = table.getByText('€450.00')
    expect(float.className).not.toContain('text-rose-600')
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
    expect(screen.queryByText('Jar reconciliation')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('ACCT-054: a negative float renders in rose (a shortfall)', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 700, currentBalance: 700 })],
      reconciliation: [
        { accountId: 'r1', accountName: 'Rainy Day', currentBalance: 700, backedJarsTotal: 1200, backedJarCount: 1, float: -500 },
      ],
    })

    renderPage()

    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    const float = table.getByText('-€500.00')
    expect(float.className).toContain('text-rose-600')
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

    renderPage()

    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    // GBP row in £, EUR row in €.
    expect(table.getByText('£200.00')).toBeInTheDocument()
    expect(table.getByText('£150.00')).toBeInTheDocument()
    expect(table.getByText('£50.00')).toBeInTheDocument()
    expect(table.getByText('€1,050.00')).toBeInTheDocument()
    expect(table.getByText('€600.00')).toBeInTheDocument()
  })

  it('ACCT-056: a failed reconciliation fetch is swallowed silently (no error banner)', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 })],
      reconciliationError: true,
    })

    renderPage()

    // The accounts still render and no page-level error banner appears.
    await screen.findByText('Joint', {}, { timeout: 5000 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Jar reconciliation')).not.toBeInTheDocument()
  })
})
