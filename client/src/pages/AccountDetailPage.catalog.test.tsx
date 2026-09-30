import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import type { AccountDto, BudgetMonthDto, TransactionDto } from '../types'

// Same harness as AccountDetailPage.test.tsx: a single mocked GET drives every load.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountDetailPage } from './AccountDetailPage'
// Real money module — pin en-GB so €/£ strings render in the canonical format.
import { setMoneyFormat } from '../lib/money'

function account(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'a1', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 2000, currentBalance: 2140, displayOrder: 0, ...over }
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-06-20', payee: 'Vodafone', amount: 40, currency: 'EUR',
    type: 0, bankReference: null, budgetItemId: null, budgetItemName: null, accountId: 'a1', accountName: 'Joint',
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, isSplit: false, splits: [], ...over,
  }
}

// A minimal current-month budget carrying a single line, for the category-pill lookup.
function monthWith(lineNames: string[]): BudgetMonthDto {
  return {
    id: 'm1', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR',
    totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false,
    categories: [
      {
        id: 'c1', name: 'Bills', kind: 'Expense', displayOrder: 0, totalPlanned: 0, totalActual: 0,
        items: lineNames.map((name, i) => ({
          id: `bi${i}`, name, displayOrder: i, plannedAmount: 0, actualAmount: 0, remaining: 0,
          savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false,
        })),
      },
    ],
  }
}

interface DetailSetup {
  accounts?: AccountDto[]
  transactions?: TransactionDto[]
  month?: BudgetMonthDto | null
  accountsError?: boolean
  txError?: boolean
  budgetError?: boolean
}

function mockLoads(s: DetailSetup = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') {
      return s.accountsError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: s.accounts ?? [account()] })
    }
    if (url === '/transactions') {
      return s.txError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: s.transactions ?? [] })
    }
    if (url === '/budget/current') {
      return s.budgetError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: s.month ?? {} })
    }
    return Promise.resolve({ data: {} })
  })
}

function renderPage(id = 'a1') {
  return renderWithProviders(
    <Routes>
      <Route path="/accounts/:id" element={<AccountDetailPage />} />
    </Routes>,
    { route: `/accounts/${id}` },
  )
}

// The hero's "Transactions" count tile, disambiguated from the sidebar nav link by
// scoping to the .hero-surface section.
function txCountTileValue(): HTMLElement {
  const label = screen.getAllByText('Transactions').find((el) => el.closest('.hero-surface'))!
  return within(label.parentElement!).getByText(/^\d+$/)
}

describe('AccountDetailPage — catalog (ACCT)', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56 / £200.00
    mockLoads()
  })

  it('ACCT-044: the register includes transfers into the account, with a "Transfer" payee fallback', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 'own', payee: 'Groceries', accountId: 'a1' }),
        // A transfer whose destination is this account (accountId is elsewhere).
        tx({ id: 'in', payee: '', type: 2, accountId: 'src', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Joint', amount: 200 }),
      ],
    })

    renderPage()

    // The transfer-in appears (matched via transferAccountId) with the blank-note fallback.
    expect(await screen.findByText('Groceries', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    // Both rows count toward the tile.
    expect(txCountTileValue()).toHaveTextContent('2')
  })

  it('ACCT-045: amount signs are direction-aware (income +, expense −, transfer by side)', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 'inc', payee: 'Salary', type: 1, accountId: 'a1', amount: 500 }),
        tx({ id: 'exp', payee: 'Rent', type: 0, accountId: 'a1', amount: 300 }),
        tx({ id: 'tout', payee: 'MovedOut', type: 2, accountId: 'a1', accountName: 'Joint', transferAccountId: 'x', transferAccountName: 'Rainy Day', amount: 100 }),
        tx({ id: 'tin', payee: 'MovedIn', type: 2, accountId: 'y', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Joint', amount: 150 }),
      ],
    })

    renderPage()

    await screen.findByText('Salary', {}, { timeout: 5000 })

    const amountIn = (payee: string, moneyRe: RegExp) =>
      within(screen.getByText(payee).closest('tr')!).getByText(moneyRe)

    // Income: "+€500.00" in brand-green.
    const inc = amountIn('Salary', /€500\.00/)
    expect(inc.textContent).toBe('+€500.00')
    expect(inc.className).toContain('text-brand-700')
    // Expense: "−€300.00" (U+2212 sign) in dark.
    expect(amountIn('Rent', /€300\.00/).textContent).toBe('−€300.00')
    // Transfer where this account is the source → "−"; muted slate.
    const tout = amountIn('MovedOut', /€100\.00/)
    expect(tout.textContent).toBe('−€100.00')
    expect(tout.className).toContain('text-slate-500')
    // Transfer where this account is the destination → "+".
    expect(amountIn('MovedIn', /€150\.00/).textContent).toBe('+€150.00')
  })

  it('ACCT-046: a transfer category cell reads "{from} → {to}" with a removed-account fallback', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 'ok', payee: 'T1', type: 2, accountId: 'a1', accountName: 'Joint', transferAccountId: 'rd', transferAccountName: 'Rainy Day' }),
        // Counterparty later deleted → transferAccountName is null.
        tx({ id: 'gone', payee: 'T2', type: 2, accountId: 'a1', accountName: 'Joint', transferAccountId: 'x', transferAccountName: null }),
      ],
    })

    renderPage()

    expect(await screen.findByText('Joint → Rainy Day', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Joint → (removed account)')).toBeInTheDocument()
  })

  it('ACCT-047: assigned rows render a named category pill; unassigned rows render "—"', { timeout: 15000 }, async () => {
    mockLoads({
      month: monthWith(['Rent']), // only "Rent" is in the current month
      transactions: [
        tx({ id: 'in-month', payee: 'RentPay', budgetItemId: 'bi0', budgetItemName: 'Rent', accountId: 'a1' }),
        tx({ id: 'off-month', payee: 'OldPay', budgetItemId: 'bi9', budgetItemName: 'Old Line', accountId: 'a1' }),
        tx({ id: 'loose', payee: 'Uncategorised', budgetItemId: null, budgetItemName: null, accountId: 'a1' }),
      ],
    })

    renderPage()

    // Both the in-month and the prior-month line render as a NAMED pill (never blank/grey).
    const rentName = await screen.findByText('Rent', {}, { timeout: 5000 })
    expect(rentName.closest('span.rounded-full')).not.toBeNull()
    expect(screen.getByText('Old Line').closest('span.rounded-full')).not.toBeNull()
    // An unassigned row shows the em-dash, not a pill.
    const dash = screen.getByText('—')
    expect(dash.closest('span.rounded-full')).toBeNull()
  })

  it('ACCT-048: each amount is formatted in the transaction’s own stamped currency', { timeout: 15000 }, async () => {
    // GBP account, but a transaction stamped in EUR (a known deferred display-only mismatch).
    mockLoads({
      accounts: [account({ currency: 'GBP', currentBalance: 200 })],
      transactions: [tx({ id: 'm', payee: 'Mismatch', accountId: 'a1', currency: 'EUR', amount: 40 })],
    })

    renderPage()

    await screen.findByText('Mismatch', {}, { timeout: 5000 })
    // The row uses the transaction's currency (€), not the account's (£).
    expect(screen.getByText(/€40\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/£40\.00/)).not.toBeInTheDocument()
  })

  it('ACCT-049: an account with no transactions shows the empty-register message and a 0 count', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [account({ name: 'Fresh' })], transactions: [] })

    renderPage()

    expect(await screen.findByText('No transactions on this account yet.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(txCountTileValue()).toHaveTextContent('0')
  })

  it('ACCT-051: the detail page is read-only and tolerates side-fetch failures', { timeout: 15000 }, async () => {
    // /accounts succeeds, but the transactions + budget side-fetches fail.
    mockLoads({ accounts: [account()], txError: true, budgetError: true })

    renderPage()

    // The hero still renders (only a failed /accounts trips not-found).
    expect((await screen.findAllByText('Joint', {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('Account not found')).not.toBeInTheDocument()
    // The register degrades gracefully to the empty state rather than crashing.
    expect(screen.getByText('No transactions on this account yet.')).toBeInTheDocument()
    // No write affordances anywhere on the page.
    expect(screen.queryByRole('button', { name: /edit|delete|add account/i })).not.toBeInTheDocument()
  })
})
