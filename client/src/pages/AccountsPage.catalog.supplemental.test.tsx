import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, AccountReconciliationDto } from '../types'

// Supplemental catalog cases for the ACCOUNTS area — the jsdom-observable ACCT
// behaviours NOT already locked down by AccountsPage.catalog.test.tsx /
// AccountDetailPage.catalog.test.tsx (which this file deliberately does not
// duplicate). Same shared api mock as those files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountsPage } from './AccountsPage'
// Real (unmocked) money module — pin the active display locale so every €/£ string
// asserted below renders in the design's canonical en-GB comma-dot format
// (€1,234.56), independent of test-execution order.
import { setMoneyFormat } from '../lib/money'
import { accountCard, accountNote } from '../test/rowMenu'

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

const renderPage = () => renderWithProviders(<AccountsPage />)

async function openAddModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('AccountsPage — catalog supplemental (ACCT)', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56 / £75.00
    mockLoads()
  })

  // --- Net hero: the Available / Owed split across a mixed-sign portfolio ----

  // ACCT-001 / ACCT-002: the three memoised reducers (netMinor / availableMinor /
  // owedMinor) working *together* over a portfolio that mixes positive and
  // negative balances — an interaction no existing test asserts (the base test
  // checks only the net; the catalog ACCT-002 uses a single negative account).
  it('ACCT-001/002: the hero shows the total and the available money, with no Owed tile (rule 74)', { timeout: 15000 }, async () => {
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
    // Available = Σ max(0, balance) = 1250 + 500 = 1,750.00 (the debt is excluded), under the total.
    expect(screen.getByText('€1,750.00 available')).toBeInTheDocument()
    // Rule 74: no account is ever below zero, so nothing is "owed" and the tile is gone; a
    // legacy negative row still isn't summed into Available.
    expect(screen.queryByText('Owed')).not.toBeInTheDocument()
    expect(screen.queryByText('€75.00')).not.toBeInTheDocument()
    // The negative account's card balance renders in the bad (red) tone.
    await screen.findAllByText('-€75.00', {}, { timeout: 5000 })
    expect(within(accountCard('Visa')).getByText('-€75.00').className).toContain('text-bad')
    // Every account in the budget currency ⇒ no "not counted" footnote.
    expect(screen.queryByText(/in another currency/i)).not.toBeInTheDocument()
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
    // The new card shows the balance, and its ⋯ note the matching opening. Scope to the
    // card so the assertion isn't satisfied by the hero, which for this single-account
    // portfolio also reads €1,000.00.
    const card = await screen.findByRole('article', { name: 'Everyday' }, { timeout: 5000 })
    expect(within(card).getByText('€1,000.00')).toBeInTheDocument()
    expect(await accountNote(user, 'Everyday')).toContain('Opening €1,000.00')
  })

  // --- Reconciliation: the per-card filter vs the tiles' gate ----------------

  // ACCT-052 / ACCT-053: the jar tiles show when SOME account backs a jar
  // (`backedJarCount > 0`), but only a card whose account backs a jar has the jar
  // bar — an unbacked account that is present in the reconciliation payload shows
  // no bar at all.
  it('ACCT-052/053: only backed accounts show what their jars hold, filtering out unbacked ones', { timeout: 15000 }, async () => {
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

    expect(await screen.findByRole('group', { name: 'In jars' }, { timeout: 5000 })).toHaveTextContent('€600.00')
    // The backed account's card has the bar, with what is not in its jars.
    const jars = screen.getAllByTestId('account-jars')
    expect(jars).toHaveLength(1)
    expect(within(accountCard('Joint')).getByTestId('account-jars')).toHaveTextContent('€450.00 not in jars')
    // The unbacked account has none (it still renders as a card).
    expect(within(accountCard('Rainy Day')).queryByTestId('account-jars')).not.toBeInTheDocument()
    expect(within(accountCard('Rainy Day')).getByText('€700.00')).toBeInTheDocument()
    // Its money is all not in jars: the tile adds its 700 to Joint's 450.
    expect(screen.getByRole('group', { name: 'Not in jars' })).toHaveTextContent('€1,150.00')
  })
})
