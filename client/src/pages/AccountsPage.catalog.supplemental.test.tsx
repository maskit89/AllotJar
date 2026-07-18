import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, AccountReconciliationDto } from '../types'

// Supplemental catalog cases for the ACCOUNTS area — the jsdom-observable ACCT
// behaviours NOT already locked down by AccountsPage.catalog.test.tsx /
// AccountDetailPage.catalog.test.tsx (which this file deliberately does not
// duplicate). Same api-control harness as those files: vi.hoisted so the mock
// factory can close over the fns, importOriginal spread so the rest of api.ts
// (refreshSession, setSessionHandlers, isAccessTokenExpired, …) keeps working —
// AuthProvider reaches into them on mount.
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
}

// Route the endpoints AccountsPage + AuthProvider hit on mount: /accounts,
// /accounts/reconciliation, /auth/me, /features. A non-numeric /auth/me leaves
// AuthContext at its Owner default (canWrite = true, preferredCurrency = EUR).
function mockLoads(s: ApiSetup = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') return Promise.resolve({ data: s.accounts ?? [] })
    if (url === '/accounts/reconciliation') return Promise.resolve({ data: s.reconciliation ?? [] })
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

async function openAddModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('AccountsPage — catalog supplemental (ACCT)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56 / £75.00
    mockLoads()
  })

  // --- Net hero: the Available / Owed split across a mixed-sign portfolio ----

  // ACCT-001 / ACCT-002: the three memoised reducers (netMinor / availableMinor /
  // owedMinor) working *together* over a portfolio that mixes positive and
  // negative balances — an interaction no existing test asserts (the base test
  // checks only the net; the catalog ACCT-002 uses a single negative account).
  it('ACCT-001/002: the hero splits a mixed-sign portfolio into Total / Available / Owed', { timeout: 15000 }, async () => {
    // All EUR ⇒ the hero currency is unanimous (no footnote). Two positives + one debt.
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1250, currentBalance: 1250 }),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 500, currentBalance: 500 }),
        acct({ id: 'v1', name: 'Visa', type: 3, openingBalance: -75, currentBalance: -75 }),
      ],
    })

    renderPage()

    // Total = net = 1250 + 500 − 75 = 1,675.00, labelled in the unanimous EUR.
    expect(await screen.findByLabelText('Total balance: €1,675.00', {}, { timeout: 5000 })).toBeInTheDocument()
    // Available = Σ max(0, balance) = 1250 + 500 = 1,750.00 (the debt is excluded).
    expect(screen.getByText('€1,750.00')).toBeInTheDocument()
    // Owed = −Σ min(0, balance) = 75.00 (the debt, displayed positive).
    expect(screen.getByText('€75.00')).toBeInTheDocument()
    // The negative account's card balance renders rose; its "Opening −€75.00"
    // caption shares the string but is slate, so pick the rose occurrence.
    const negs = await screen.findAllByText('-€75.00', {}, { timeout: 5000 })
    expect(negs.some((el) => el.className.includes('text-rose-600'))).toBe(true)
    // Unanimous currency ⇒ no mixed-currency footnote.
    expect(screen.queryByText(/some accounts hold another currency/i)).not.toBeInTheDocument()
  })

  // --- Ordering & duplicate names -------------------------------------------

  // ACCT-007: the client renders accounts in the exact order GET /accounts
  // returns them (server-sorted DisplayOrder→Name — the page applies no sort of
  // its own), and two accounts sharing a name coexist as distinct cards with
  // independent balances (there is no uniqueness rule anywhere).
  it('ACCT-007: cards keep the server order and duplicate names render as distinct cards', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 100, currentBalance: 100 }),
        acct({ id: 'j2', name: 'Joint', openingBalance: 300, currentBalance: 300 }),
        acct({ id: 'aaa', name: 'Aaa', openingBalance: 50, currentBalance: 50 }),
      ],
    })

    renderPage()

    // Wait for the grid, then read the whole-card overlay links in DOM order.
    await screen.findByLabelText('View Aaa', {}, { timeout: 5000 })
    const links = screen.getAllByRole('link', { name: /^View / })
    // Order is preserved as received (a name-sort would have hoisted "Aaa" first).
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/accounts/j1',
      '/accounts/j2',
      '/accounts/aaa',
    ])
    // Both "Joint" accounts are present…
    expect(screen.getAllByText('Joint')).toHaveLength(2)
    // …and carry their own independent balances.
    expect(screen.getByText('€100.00')).toBeInTheDocument()
    expect(screen.getByText('€300.00')).toBeInTheDocument()
  })

  // --- A newly-created account's balance = its opening ----------------------

  // ACCT-041: on create the balance short-circuits to the opening (no transactions
  // possible yet), so the appended card immediately shows the opening as BOTH the
  // balance and the "Opening …" caption. The base add test only asserts the name
  // appears; this locks the fresh card's money.
  it('ACCT-041: a freshly-added account shows a balance equal to its opening', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    mockPost.mockResolvedValue({
      data: acct({ id: 'e1', name: 'Everyday', openingBalance: 1000, currentBalance: 1000 }),
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openAddModal(user)
    await user.type(dialog.getByLabelText('Account name'), 'Everyday')
    await user.type(dialog.getByLabelText('Opening balance'), '1000')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'Everyday', openingBalance: 1000 })),
    )
    // The new card shows the balance and the matching opening caption. Scope to the
    // card body (name + balance + caption share a wrapper) so the assertion isn't
    // satisfied by the hero, which for this single-account portfolio also reads
    // €1,000.00 (net + Available tile).
    const cardBody = (await screen.findByText('Everyday', {}, { timeout: 5000 })).parentElement!
    expect(within(cardBody).getByText('€1,000.00')).toBeInTheDocument()
    expect(within(cardBody).getByText('Opening €1,000.00')).toBeInTheDocument()
  })

  // --- Reconciliation: the row filter vs the card-visibility gate ------------

  // ACCT-052 / ACCT-053: the "Jar reconciliation" card is shown when SOME account
  // backs a jar (`reconciliation.some(r => r.backedJarCount > 0)`), but the table
  // body only lists rows with `backedJarCount > 0` — an unbacked account that is
  // present in the reconciliation payload is filtered out of the table entirely.
  it('ACCT-052/053: reconciliation lists only backed accounts, filtering out unbacked ones', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ id: 'j1', name: 'Joint', openingBalance: 1050, currentBalance: 1050 }),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, openingBalance: 700, currentBalance: 700 }),
      ],
      reconciliation: [
        { accountId: 'j1', accountName: 'Joint', currentBalance: 1050, backedJarsTotal: 600, backedJarCount: 1, float: 450 },
        // Present in the payload but backs no jar ⇒ must not appear as a table row.
        { accountId: 'r1', accountName: 'Rainy Day', currentBalance: 700, backedJarsTotal: 0, backedJarCount: 0, float: 700 },
      ],
    })

    renderPage()

    expect(await screen.findByText('Jar reconciliation', {}, { timeout: 5000 })).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    // The backed account's row is present with its float.
    expect(table.getByText('Joint')).toBeInTheDocument()
    expect(table.getByText('€450.00')).toBeInTheDocument()
    // The unbacked account is filtered out of the table (it still renders as a card,
    // so scope the negative assertion to the table only).
    expect(table.queryByText('Rainy Day')).not.toBeInTheDocument()
    // Sanity: Rainy Day does exist on the page as an account card.
    expect(screen.getByText('Rainy Day')).toBeInTheDocument()
  })
})
