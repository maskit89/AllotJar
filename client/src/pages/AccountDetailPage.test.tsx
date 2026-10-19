import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, Route, Routes } from 'react-router-dom'
import type { AccountDto, AccountReconciliationDto, BudgetMonthDto, JarAccountLedgerDto, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountDetailPage } from './AccountDetailPage'
import { reconFromState, reconState } from '../lib/accountJars'

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

/** The register row that holds an element. */
function rowOf(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>('[data-testid="tx-row"]')!
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

    // The account name shows as the page heading (the top bar's h1).
    expect((await screen.findAllByText('Everyday Current', {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { level: 1, name: 'Everyday Current' })).toBeInTheDocument()
    expect(screen.getByText(/2,140\.00/)).toBeInTheDocument()
    // Only this account's transactions are listed.
    expect(screen.getByText('Vodafone')).toBeInTheDocument()
    expect(screen.queryByText('Other-account')).not.toBeInTheDocument()
    // The way back is the top bar's chevron link.
    expect(screen.getByRole('link', { name: 'Back to Accounts' })).toHaveAttribute('href', '/accounts')
  })

  // Rule 76: the optional bank identifiers show on the detail page only when recorded. The Account
  // details card itself always shows (it holds the type and the opening balance too).
  it('shows recorded bank identifiers, and none when none are recorded', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts')
        return Promise.resolve({ data: [{ ...account(), iban: 'MT84MALT011000012345MTLCAST001S', bic: 'VALLMTMT', sortCode: null, accountNumber: '' }] })
      return Promise.resolve({ data: [] })
    })

    const { unmount } = renderPage()

    expect(await screen.findByRole('heading', { name: 'Account details' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('IBAN')).toBeInTheDocument()
    // In groups of four, as banks print it (#344 P3-5), spaced by a margin, so the text (what a copy
    // gives) is the stored value.
    const iban = screen.getByText('IBAN').nextElementSibling as HTMLElement
    expect(iban.textContent).toBe('MT84MALT011000012345MTLCAST001S')
    expect(Array.from(iban.querySelectorAll('[data-iban] > span'), (g) => g.textContent)).toEqual([
      'MT84', 'MALT', '0110', '0001', '2345', 'MTLC', 'AST0', '01S',
    ])
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
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    const details = screen.getByRole('region', { name: 'Account details' })
    for (const label of ['IBAN', 'BIC', 'Sort code', 'Account number']) expect(screen.queryByText(label)).not.toBeInTheDocument()
    // The card still says what kind of account it is.
    expect(within(details).getByText('Current')).toBeInTheDocument()
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

    const user = userEvent.setup()
    renderPage()

    const tag = await screen.findByText('Needs EUR amount', {}, { timeout: 5000 })
    expect(screen.getAllByText('Needs EUR amount')).toHaveLength(1) // only the waiting row
    // Why it is flagged sits behind the tag's (i) (it was the tag's title, which a keyboard or a
    // phone never reaches): focus it from the keyboard and read it.
    const hint = within(rowOf(tag)).getByRole('button', { name: /^About London Cab on .+: needs EUR amount$/ })
    expect(screen.getAllByRole('button', { name: /needs EUR amount$/ })).toHaveLength(1)
    await user.tab()
    while (document.activeElement !== hint && document.activeElement !== document.body) await user.tab()
    expect(hint).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('In another currency. Not counted anywhere until you enter the amount in EUR.')
    expect(hint).toHaveAttribute('aria-describedby', tip.id)
    expect(tag).not.toHaveAttribute('title')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
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

    const old = rowOf(await screen.findByText('Old phone bill', {}, { timeout: 5000 }))
    expect(within(old).getByText('Before opening')).toBeInTheDocument()
    expect(within(old).getByText(/25\.00/).className).toContain('line-through')
    const recent = rowOf(screen.getByText('Vodafone'))
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

    const received = rowOf(await screen.findByText('Top up', {}, { timeout: 5000 }))
    expect(within(received).queryByText('Before opening')).not.toBeInTheDocument()
    expect(within(received).getByText(/200\.00/).className).not.toContain('line-through')
    expect(within(received).getByText(/Jun 2/)).toBeInTheDocument()
    const left = rowOf(screen.getByText('Old move'))
    expect(within(left).getByText('Before opening')).toBeInTheDocument()
    const returned = rowOf(screen.getByText('Bounced'))
    expect(within(returned).queryByText('Before opening')).not.toBeInTheDocument()
    // It moved the balance on its return, so its amount is not struck through either.
    expect(within(returned).getByText(/75\.00/).className).not.toContain('line-through')
    const pending = rowOf(screen.getByText('On its way'))
    expect(within(pending).queryByText('Before opening')).not.toBeInTheDocument()
  })
})

// ---- The restyled page (restyle PR 11) ----------------------------------------------------------

interface Loads {
  accounts?: AccountDto[] | 'fail'
  transactions?: TransactionDto[]
  recon?: AccountReconciliationDto[] | 'fail'
  month?: BudgetMonthDto | null
  /** GET /jars/ledger: which jars each account holds. */
  ledger?: JarAccountLedgerDto[]
}

function mockLoads(l: Loads = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') return l.accounts === 'fail' ? Promise.reject(new Error('boom')) : Promise.resolve({ data: l.accounts ?? [account()] })
    if (url === '/transactions') return Promise.resolve({ data: l.transactions ?? [] })
    if (url === '/accounts/reconciliation') return l.recon === 'fail' ? Promise.reject(new Error('boom')) : Promise.resolve({ data: l.recon ?? [] })
    if (url === '/budget/current') return Promise.resolve({ data: l.month ?? {} })
    if (url === '/jars/ledger') return Promise.resolve({ data: l.ledger ?? [] })
    return Promise.resolve({ data: {} })
  })
}

/** An account's line of GET /jars/ledger holding the given jars. */
const ledgerOf = (accountId: string, jarIds: string[]): JarAccountLedgerDto => ({
  accountId, accountName: accountId, currency: 'EUR', asOf: '2026-07-01', accountBalance: 2140, unallocated: 1840,
  positiveAllocations: 300, hasBackingDeficit: false, unreconciledAllocations: 0,
  jars: jarIds.map((jarId) => ({ jarId, name: jarId, balance: 150, isArchived: false })),
} as JarAccountLedgerDto)

const recon = (over: Partial<AccountReconciliationDto> = {}): AccountReconciliationDto => ({
  accountId: 'a1', accountName: 'Everyday Current', currentBalance: 2140, backedJarsTotal: 300, backedJarCount: 2, float: 1840, ...over,
})

function monthWithJar(): BudgetMonthDto {
  const item = (id: string, name: string, savingsId: string | null) => ({
    id, name, displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId, savingsAvailable: null, dueDay: null, isPaid: false,
  })
  return {
    id: 'm1', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR', totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false,
    categories: [
      { id: 'c1', name: 'Bills', kind: 'Expense', displayOrder: 0, totalPlanned: 0, totalActual: 0, items: [item('bi0', 'Phone', null)] },
      { id: 'c2', name: 'Jars', kind: 'Savings', displayOrder: 1, totalPlanned: 0, totalActual: 0, items: [item('bi1', 'Holiday', 'j1')] },
    ],
  }
}

/** Makes the page's media queries answer as on a phone (jsdom has no matchMedia). */
function asPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 699.98px)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
}

describe('AccountDetailPage — the restyled page', () => {
  beforeEach(() => mockGet.mockReset())
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the way back and a plain title while loading, then on an unknown account', { timeout: 15000 }, async () => {
    let answer!: (v: unknown) => void
    mockGet.mockImplementation((url: string) =>
      url === '/accounts' ? new Promise((r) => (answer = r)) : Promise.resolve({ data: [] }),
    )
    renderPage()
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Accounts' })).toHaveAttribute('href', '/accounts')
    expect(screen.queryByText('Account not found')).not.toBeInTheDocument()

    await act(async () => answer({ data: [{ ...account(), id: 'other' }] }))
    expect(await screen.findByText('Account not found')).toBeInTheDocument()
    expect(screen.getByText('It may have been deleted. Head back to your accounts.')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    // The name never shows: the title stays "Account", and the way back stays.
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Accounts' })).toBeInTheDocument()
  })

  it('shows a failed account load as not found, with no error banner', { timeout: 15000 }, async () => {
    mockLoads({ accounts: 'fail' })
    renderPage()
    expect(await screen.findByText('Account not found', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('the back link is a link a keyboard user can follow', { timeout: 15000 }, async () => {
    mockLoads()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/accounts/:id" element={<AccountDetailPage />} />
        <Route path="/accounts" element={<p>The accounts list</p>} />
      </Routes>,
      { route: '/accounts/a1' },
    )
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    const back = screen.getByRole('link', { name: 'Back to Accounts' })
    back.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('The accounts list')).toBeInTheDocument()
  })

  it('drops the answer for an account the page has already left', { timeout: 15000 }, async () => {
    let first!: (v: unknown) => void
    let calls = 0
    mockGet.mockImplementation((url: string) => {
      if (url !== '/accounts') return Promise.resolve({ data: [] })
      calls += 1
      return calls === 1
        ? new Promise((r) => (first = r))
        : Promise.resolve({ data: [account(), { ...account(), id: 'a2', name: 'Rainy Day' }] })
    })
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Routes>
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
        </Routes>
        <Link to="/accounts/a2">Open Rainy Day</Link>
      </>,
      { route: '/accounts/a1' },
    )
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Open Rainy Day' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rainy Day' }, { timeout: 5000 })).toBeInTheDocument()
    // a1's late answer arrives: it is dropped, so a1 never shows.
    await act(async () => first({ data: [{ ...account(), name: 'Stale answer' }] }))
    expect(screen.queryByText('Stale answer')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Rainy Day' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Rainy Day balance:/)).toBeInTheDocument()
  })

  it('says why there is no balance, with the app’s own two reasons', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [{ ...account(), currentBalance: null, openingDateMissing: true }] })
    const { unmount } = renderPage()
    const value = await screen.findByLabelText('Everyday Current balance: not available', {}, { timeout: 5000 })
    expect(value).toHaveTextContent('Not available')
    expect(screen.getByText('Set an opening date to calculate the balance.')).toBeInTheDocument()
    unmount()

    mockLoads({ accounts: [{ ...account(), currentBalance: null, openingDate: '2026-12-01' }] })
    renderPage()
    expect(await screen.findByText('No balance before the opening date.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Set an opening date to calculate the balance.')).not.toBeInTheDocument()
  })

  it('shows what is in transit (out and in together) and pending review under the balance', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), inTransitOut: 150, inTransitIn: 50, pendingReceiptCount: 2, pendingReceiptTotal: 80 }],
      transactions: [
        tx({ id: 'go', type: 2, payee: 'To savings', amount: 150, transferAccountId: 'a2', transferAccountName: 'Rainy Day', departedOn: '2026-06-20', receivedOn: null, transferStatus: 'InTransit' }),
        tx({ id: 'rv', type: 2, payee: 'Cash in', amount: 80, accountId: 'a3', accountName: 'Wallet', transferAccountId: 'a1', transferAccountName: 'Everyday Current', departedOn: null, receivedOn: '2026-06-19', transferStatus: 'PendingReview' }),
      ],
    })
    renderPage()
    expect(await screen.findByText('€200.00 in transit', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('€80.00 pending review')).toBeInTheDocument()
    // The rows carry their status chips, word for word (the journeys find "In transit" exactly).
    expect(within(rowOf(screen.getByText('To savings'))).getByText('In transit', { exact: true })).toHaveAttribute('data-tone', 'line')
    expect(within(rowOf(screen.getByText('Cash in'))).getByText('Pending review')).toHaveAttribute('data-tone', 'warn')
  })

  it('shows none of those lines for an account with nothing in transit or pending', { timeout: 15000 }, async () => {
    mockLoads()
    renderPage()
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    expect(screen.queryByText(/in transit$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/pending review$/)).not.toBeInTheDocument()
  })

  it('groups the rows under one eyebrow a month, with the year for another year, and counts them', { timeout: 15000 }, async () => {
    const year = new Date().getUTCFullYear()
    mockLoads({
      transactions: [
        tx({ id: 'a', date: `${year}-03-12`, payee: 'March one' }),
        tx({ id: 'b', date: `${year}-03-02`, payee: 'March two' }),
        // Left the other account in February, reached this one in March: it sits in March.
        tx({ id: 'c', date: `${year}-02-27`, payee: 'Late receipt', type: 2, accountId: 'a2', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Everyday Current', departedOn: `${year}-02-27`, receivedOn: `${year}-03-01` }),
        tx({ id: 'd', date: `${year}-02-10`, payee: 'February one' }),
        tx({ id: 'e', date: `${year - 1}-12-20`, payee: 'Last December' }),
      ],
    })
    renderPage()
    await screen.findByText('March one', {}, { timeout: 5000 })
    const months = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(months).toEqual(['March', 'February', `December ${year - 1}`])
    const march = screen.getByRole('heading', { level: 3, name: 'March' }).nextElementSibling as HTMLElement
    expect(within(march).getAllByTestId('tx-row').map((r) => r.querySelector('.truncate')?.textContent)).toEqual([
      'March one',
      'March two',
      'Late receipt',
    ])
    // "Transactions, 5" to the ear (#344 P3-6), not "Transactions 5".
    expect(screen.getByRole('heading', { level: 2, name: 'Transactions, 5' })).toBeInTheDocument()
    expect(screen.getByTestId('account-tx-count')).toHaveTextContent('5')
  })

  it('strikes through a transfer the bank sent back', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), openingDate: '2026-01-01' }],
      transactions: [
        // Out of this account and back: it never moved the balance.
        tx({ id: 'out', type: 2, payee: 'Sent back', amount: 150, transferAccountId: 'a2', transferAccountName: 'Rainy Day', departedOn: '2026-06-12', receivedOn: null, returnedOn: '2026-06-15', transferStatus: 'Returned' }),
        // Into this account, but it never arrived.
        tx({ id: 'in', type: 2, payee: 'Never came', amount: 90, accountId: 'a2', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Everyday Current', departedOn: '2026-06-10', receivedOn: null, returnedOn: '2026-06-11', transferStatus: 'Returned' }),
        tx({ id: 'ok', type: 2, payee: 'Arrived', amount: 60, transferAccountId: 'a2', transferAccountName: 'Rainy Day', departedOn: '2026-06-09', receivedOn: '2026-06-09', transferStatus: 'Completed' }),
      ],
    })
    renderPage()
    const out = rowOf(await screen.findByText('Sent back', {}, { timeout: 5000 }))
    expect(within(out).getByText('Returned')).toHaveAttribute('data-tone', 'bad')
    expect(within(out).getByText('−€150.00').className).toContain('line-through')
    const into = rowOf(screen.getByText('Never came'))
    expect(within(into).getByText('+€90.00').className).toContain('line-through')
    // Neither is history: no "Before opening".
    expect(within(out).queryByText('Before opening')).not.toBeInTheDocument()
    const ok = rowOf(screen.getByText('Arrived'))
    expect(within(ok).getByText('−€60.00').className).not.toContain('line-through')
    expect(within(ok).queryByText('Returned')).not.toBeInTheDocument()
  })

  it('explains a row before the opening date behind its (i), with the date', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), openingDate: '2026-06-01' }],
      transactions: [tx({ id: 't0', date: '2026-05-20', payee: 'Old phone bill', amount: 25 })],
    })
    const user = userEvent.setup()
    renderPage()
    const old = rowOf(await screen.findByText('Old phone bill', {}, { timeout: 5000 }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    const hint = within(old).getByRole('button', { name: 'About Old phone bill on May 20: before opening' })
    await user.tab()
    while (document.activeElement !== hint && document.activeElement !== document.body) await user.tab()
    expect(hint).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Dated before the opening balance of Jun 1, 2026, which already includes it: kept as history, it doesn’t change the balance.')
    expect(hint).toHaveAttribute('aria-describedby', tip.id)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('reaches the back link, then the hints in order, from the keyboard', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), openingDate: '2026-06-01' }],
      recon: [recon()],
      transactions: [tx({ id: 't0', date: '2026-05-20', payee: 'Old phone bill', amount: 25 })],
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Old phone bill', {}, { timeout: 5000 })
    const order = [
      screen.getByRole('link', { name: 'Back to Accounts' }),
      screen.getByRole('button', { name: 'About balance' }),
      screen.getByRole('button', { name: 'About the money not in jars in Everyday Current' }),
      screen.getByRole('button', { name: 'About Old phone bill on May 20: before opening' }),
    ]
    const all = Array.from(document.querySelectorAll<HTMLElement>('a[href], button'))
    const at = order.map((el) => all.indexOf(el))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The register has nothing else to stop on.
    const list = screen.getByRole('region', { name: /^Transactions/ })
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(within(list).queryByRole('link')).not.toBeInTheDocument()
    await user.click(document.body)
  })

  it('lists the account’s type, who holds it and its opening balance and date', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), type: 1, openingDate: '2026-06-01', holders: [{ memberId: 'm1', name: 'Alex' }, { memberId: 'm2', name: 'Sam' }] }],
    })
    const { unmount } = renderPage()
    const details = await screen.findByRole('region', { name: 'Account details' }, { timeout: 5000 })
    expect(within(details).getByText('Savings')).toBeInTheDocument()
    expect(within(details).getByText('Held by Alex and Sam')).toBeInTheDocument()
    expect(within(details).getByText('Opening balance')).toBeInTheDocument()
    expect(within(details).getByText('€2,000.00')).toBeInTheDocument()
    expect(within(details).getByText('On Jun 1, 2026')).toBeInTheDocument()
    // The values are 14px (text-sm) as in the mock-up, not the page's 16px, with the date at 12px.
    expect(within(details).getByText('€2,000.00')).toHaveClass('text-sm')
    expect(within(details).getByText('On Jun 1, 2026')).toHaveClass('text-xs')
    // The type's tile is decorative there: the type is read once.
    expect(within(details).queryByRole('img', { name: 'Savings' })).not.toBeInTheDocument()
    unmount()

    // A household's own account (no holders), recorded before the opening date was required.
    mockLoads({ accounts: [{ ...account(), openingDate: null }] })
    renderPage()
    const plain = await screen.findByRole('region', { name: 'Account details' }, { timeout: 5000 })
    expect(within(plain).queryByText(/^Held by/)).not.toBeInTheDocument()
    expect(within(plain).getByText('€2,000.00')).toBeInTheDocument()
    expect(within(plain).queryByText(/^On /)).not.toBeInTheDocument()
  })

  it('shows In jars, with the Accounts card’s rest and its (i), only for an account that holds jars', { timeout: 15000 }, async () => {
    mockLoads({ recon: [recon()] })
    const user = userEvent.setup()
    const { unmount } = renderPage()
    const tile = await screen.findByRole('group', { name: 'In jars' }, { timeout: 5000 })
    expect(within(tile).getByText('€300.00')).toBeInTheDocument()
    expect(within(tile).getByText('€1,840.00 not in jars')).toBeInTheDocument()
    await user.hover(within(tile).getByRole('button', { name: 'About the money not in jars in Everyday Current' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Money in this account that no jar holds. Move money can put it in a jar.')
    unmount()

    // More in the jars than in the account: the shortfall, in red.
    mockLoads({ recon: [recon({ float: -50 })] })
    let r = renderPage()
    const over = await screen.findByText('€50.00 over', {}, { timeout: 5000 })
    expect(over.className).toContain('text-bad')
    expect(screen.getByRole('button', { name: 'About the shortfall in Everyday Current' })).toBeInTheDocument()
    r.unmount()

    mockLoads({ recon: [recon({ hasBackingDeficit: true })] })
    r = renderPage()
    expect(await screen.findByText('Jars exceed account money', {}, { timeout: 5000 })).toBeInTheDocument()
    r.unmount()

    // No jars in it (or another account's): the hero alone.
    for (const answer of [[recon({ backedJarCount: 0, backedJarsTotal: 0 })], [recon({ accountId: 'zz' })], 'fail' as const]) {
      mockLoads({ recon: answer })
      r = renderPage()
      await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
      expect(screen.queryByRole('group', { name: 'In jars' })).not.toBeInTheDocument()
      expect(screen.queryByText('Account not found')).not.toBeInTheDocument()
      r.unmount()
    }
  })

  it('shows the transfer’s other account with its direction, a removed one included', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 'o', type: 2, payee: 'Out', accountId: 'a1', accountName: 'Everyday Current', transferAccountId: 'a2', transferAccountName: 'Rainy Day' }),
        tx({ id: 'i', type: 2, payee: 'In', accountId: 'a2', accountName: 'Rainy Day', transferAccountId: 'a1', transferAccountName: 'Everyday Current' }),
        tx({ id: 'g', type: 2, payee: 'From gone', accountId: null, accountName: null, transferAccountId: 'a1', transferAccountName: 'Everyday Current' }),
      ],
    })
    renderPage()
    const route = (payee: string) => rowOf(screen.getByText(payee)).querySelector('[data-tx-route]')
    await screen.findByText('Out', {}, { timeout: 5000 })
    expect(route('Out')).toHaveTextContent(/^To Rainy Day$/)
    expect(route('In')).toHaveTextContent(/^From Rainy Day$/)
    expect(route('From gone')).toHaveTextContent(/^From \(removed account\)$/)
    // The amounts carry the direction too.
    expect(within(rowOf(screen.getByText('Out'))).getByText('−€40.00')).toBeInTheDocument()
    expect(within(rowOf(screen.getByText('In'))).getByText('+€40.00')).toBeInTheDocument()
  })

  it('labels a split as a split and an uncategorised row as Unassigned, never as a category', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 's', payee: 'Grocer + Pharmacy', isSplit: true, splits: [
          { id: 's1', budgetItemId: 'bi0', budgetItemName: 'Phone', memberId: null, memberName: null, amount: 30 },
          { id: 's2', budgetItemId: 'bi9', budgetItemName: 'Other', memberId: null, memberName: null, amount: 10 },
        ] }),
        tx({ id: 'u', payee: 'Loose' }),
      ],
    })
    renderPage()
    const split = rowOf(await screen.findByText('Grocer + Pharmacy', {}, { timeout: 5000 }))
    expect(within(split).getByText('Split')).toBeInTheDocument()
    expect(within(split).queryByText('Unassigned')).not.toBeInTheDocument()
    expect(within(rowOf(screen.getByText('Loose'))).getByText('Unassigned').closest('[data-tone]')).toHaveAttribute('data-tone', 'line')
  })

  it('shows a payment from a jar’s line as a jar chip in an account that holds jars', { timeout: 15000 }, async () => {
    const rows = [tx({ id: 'j', payee: 'Ryanair', budgetItemId: 'bi1', budgetItemName: 'Holiday' }), tx({ id: 'p', payee: 'Vodafone', budgetItemId: 'bi0', budgetItemName: 'Phone' })]
    // The Holiday jar (j1) sits in this account (GET /jars/ledger, as Transactions reads it).
    mockLoads({ month: monthWithJar(), recon: [recon()], transactions: rows, ledger: [ledgerOf('a1', ['j1'])] })
    const { unmount } = renderPage()
    await waitFor(() => expect(screen.getByText('Holiday').parentElement).not.toHaveAttribute('style'))
    // The outline jar chip (no colour fill), as on Transactions.
    expect(screen.getByText('Phone').parentElement).toHaveAttribute('style')
    unmount()

    // The jars aren't in this account: the plain category chip.
    mockLoads({ month: monthWithJar(), recon: [], transactions: rows, ledger: [] })
    renderPage()
    expect((await screen.findByText('Holiday', {}, { timeout: 5000 })).parentElement).toHaveAttribute('style')
  })

  // #344 P3-2: the chip agrees with Transactions: this account holds jars, but not that one.
  it('shows the plain chip for a jar’s line when that jar sits in another account', { timeout: 15000 }, async () => {
    const rows = [tx({ id: 'j', payee: 'Ryanair', budgetItemId: 'bi1', budgetItemName: 'Holiday' })]
    mockLoads({ month: monthWithJar(), recon: [recon()], transactions: rows, ledger: [ledgerOf('a1', ['j9']), ledgerOf('a2', ['j1'])] })
    renderPage()
    expect(await screen.findByText('In jars', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Holiday').parentElement).toHaveAttribute('style')
    expect(mockGet).toHaveBeenCalledWith('/jars/ledger')
  })

  it('shows the jar chip before the jars’ figures answer (it needs only the jar ledger)', { timeout: 15000 }, async () => {
    const rows = [tx({ id: 'j', payee: 'Ryanair', budgetItemId: 'bi1', budgetItemName: 'Holiday' })]
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions') return Promise.resolve({ data: rows })
      if (url === '/budget/current') return Promise.resolve({ data: monthWithJar() })
      if (url === '/jars/ledger') return Promise.resolve({ data: [ledgerOf('a1', ['j1'])] })
      if (url === '/accounts/reconciliation') return new Promise(() => {})
      return Promise.resolve({ data: [] })
    })
    renderPage()
    await screen.findByText('Ryanair', {}, { timeout: 5000 })
    await waitFor(() => expect(screen.getByText('Holiday').parentElement).not.toHaveAttribute('style'))
  })

  it('shows a foreign payment’s own amount and what an account in another currency counts in the budget', { timeout: 15000 }, async () => {
    mockLoads({
      transactions: [
        tx({ id: 'f', payee: 'NYC Diner', amount: 23.1, originalAmount: 25, originalCurrency: 'USD' }),
        tx({ id: 'g', payee: 'Old pounds', amount: 40, currency: 'GBP', budgetAmount: 46.5 }),
      ],
    })
    renderPage()
    const diner = rowOf(await screen.findByText('NYC Diner', {}, { timeout: 5000 }))
    expect(within(diner).getByText('USD 25.00')).toHaveAttribute('title', 'Paid in USD')
    expect(within(rowOf(screen.getByText('Old pounds'))).getByText('Counts as €46.50 in the budget')).toBeInTheDocument()
    expect(within(diner).queryByText('Needs EUR amount')).not.toBeInTheDocument()
  })

  it('on a phone: two lines a row, the date once, after the category', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads({
      transactions: [
        tx(),
        tx({ id: 'o', type: 2, payee: 'Out', accountId: 'a1', accountName: 'Everyday Current', transferAccountId: 'a2', transferAccountName: 'Rainy Day', date: '2026-06-18', departedOn: '2026-06-18' }),
      ],
    })
    renderPage()
    const row = rowOf(await screen.findByText('Vodafone', {}, { timeout: 5000 }))
    expect(within(row).getAllByText('Jun 20')).toHaveLength(1)
    // The date follows the category on the second line.
    const date = within(row).getByText('Jun 20')
    expect(date.parentElement).toBe(within(row).getByText('Unassigned').closest('[data-tone]')!.parentElement)
    // A transfer's direction word stays for screen readers.
    const out = rowOf(screen.getByText('Out'))
    expect(out.querySelector('[data-tx-route]')).toHaveTextContent(/^To Rainy Day$/)
    expect(within(out).getByText('To')).toHaveClass('sr-only')
    // The dot between the route and the date goes with the date: one piece that never wraps
    // apart, so a wrapped date takes its dot along.
    const outDate = within(out).getByText('Jun 18')
    const piece = outDate.parentElement!
    expect(piece).toHaveClass('whitespace-nowrap')
    expect(piece.firstElementChild).toHaveTextContent('·')
    expect(piece.firstElementChild).toHaveAttribute('aria-hidden')
    expect(piece.previousElementSibling).toBe(out.querySelector('[data-tx-route]'))
    // A row that isn't a transfer has no dot.
    expect(row.textContent).not.toContain('·')
  })

  it('on a phone: a long line under the amount wraps in a capped width, so the category keeps its room', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads({
      transactions: [
        tx({ id: 'g', payee: 'Old pounds', amount: 40, currency: 'GBP', budgetAmount: 46.5, budgetItemId: 'bi0', budgetItemName: 'Phone' }),
        tx({ id: 'f', payee: 'NYC Diner', amount: 23.1, originalAmount: 25, originalCurrency: 'USD' }),
      ],
    })
    renderPage()
    const counts = await screen.findByText('Counts as €46.50 in the budget', {}, { timeout: 5000 })
    // It may wrap (no nowrap), at most 112px wide; on a wide screen it stays on one line.
    expect(counts).toHaveClass('max-w-28')
    expect(counts).not.toHaveClass('whitespace-nowrap')
    expect(screen.getByText('USD 25.00')).toHaveClass('max-w-28')
    expect(screen.getByText('USD 25.00')).toHaveAttribute('title', 'Paid in USD')
  })

  it('on the narrowest phones a waiting row’s tag and its (i) join the second line, after the date', { timeout: 15000 }, async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 699.98px)' || query === '(max-width: 359.98px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    mockLoads({ transactions: [tx({ id: 'w', payee: 'London Cab', currency: 'GBP', fxPending: true })] })
    renderPage()
    const tag = await screen.findByText('Needs EUR amount', {}, { timeout: 5000 })
    const row = rowOf(tag)
    // Not under the amount: beside the category and the date, with its (i).
    expect(row.querySelector('[data-tx-amount]')).not.toContainElement(tag)
    const line = within(row).getByText('Jun 20').parentElement!
    expect(line).toContainElement(tag)
    expect(line).toContainElement(within(row).getByRole('button', { name: /^About London Cab on .+: needs EUR amount$/ }))
    expect(screen.getAllByText('Needs EUR amount')).toHaveLength(1)
  })

  it('on a wide screen the lines under the amount stay on one line', { timeout: 15000 }, async () => {
    mockLoads({ transactions: [tx({ id: 'g', payee: 'Old pounds', amount: 40, currency: 'GBP', budgetAmount: 46.5 })] })
    renderPage()
    const counts = await screen.findByText('Counts as €46.50 in the budget', {}, { timeout: 5000 })
    expect(counts).toHaveClass('whitespace-nowrap')
    expect(counts).not.toHaveClass('max-w-28')
  })

  it('shows the balance and the list without waiting for the jars’ figures, then adds In jars', { timeout: 15000 }, async () => {
    let answer!: (v: unknown) => void
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions') return Promise.resolve({ data: [tx()] })
      if (url === '/accounts/reconciliation') return new Promise((r) => (answer = r))
      return Promise.resolve({ data: {} })
    })
    renderPage()
    // The page is there before the reconciliation answers, with the hero alone.
    expect(await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Vodafone')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(screen.queryByText('In jars')).not.toBeInTheDocument()
    await act(async () => answer({ data: [recon()] }))
    expect(await screen.findByText('In jars')).toBeInTheDocument()
    expect(screen.getByText('€300.00')).toBeInTheDocument()
  })

  it('never shows the jars’ figures of an account the page has already left', { timeout: 15000 }, async () => {
    const answers: Array<(v: unknown) => void> = []
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account(), { ...account(), id: 'a2', name: 'Rainy Day' }] })
      if (url === '/accounts/reconciliation') return new Promise((r) => answers.push(r))
      return Promise.resolve({ data: [] })
    })
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Routes>
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
        </Routes>
        <Link to="/accounts/a2">Open Rainy Day</Link>
      </>,
      { route: '/accounts/a1' },
    )
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    await user.click(screen.getByRole('link', { name: 'Open Rainy Day' }))
    expect(await screen.findByLabelText(/^Rainy Day balance:/, {}, { timeout: 5000 })).toBeInTheDocument()
    // a1's reconciliation answers late (with a row for a2 too): dropped, so no tile shows.
    await act(async () => answers[0]({ data: [recon(), recon({ accountId: 'a2', accountName: 'Rainy Day' })] }))
    expect(screen.queryByText('In jars')).not.toBeInTheDocument()
    // a2's own answer is the one that counts.
    await act(async () => answers[1]({ data: [recon({ accountId: 'a2', accountName: 'Rainy Day', backedJarsTotal: 75 })] }))
    expect(await screen.findByText('In jars')).toBeInTheDocument()
    expect(screen.getByText('€75.00')).toBeInTheDocument()
  })
})

// ---- Restyle PR 20: the #344 follow-ups ---------------------------------------------------------

describe('AccountDetailPage — the #344 follow-ups', () => {
  beforeEach(() => mockGet.mockReset())
  afterEach(() => vi.unstubAllGlobals())

  // #344 P3-1: a transfer that left before the opening date and came back after it moved the
  // balance by +amount on its return (ActualAccountLedger.cs): it shows that way.
  it('lists a transfer that left before the opening date and came back after it on its return date, as money in', { timeout: 15000 }, async () => {
    const year = new Date().getUTCFullYear()
    mockLoads({
      accounts: [{ ...account(), openingDate: `${year}-05-01` }],
      transactions: [
        tx({ id: 'back', type: 2, payee: 'To Pot', amount: 75, date: `${year}-04-20`, transferAccountId: 'a2', transferAccountName: 'Pot', departedOn: `${year}-04-20`, receivedOn: null, returnedOn: `${year}-05-10`, transferStatus: 'Returned' }),
        tx({ id: 'apr', date: `${year}-04-12`, payee: 'April bill', amount: 20 }),
      ],
    })
    const user = userEvent.setup()
    renderPage()
    const row = rowOf(await screen.findByText('To Pot', {}, { timeout: 5000 }))
    // Under May, the month it came back, on its return date.
    const may = screen.getByRole('heading', { level: 3, name: 'May' }).nextElementSibling as HTMLElement
    expect(may).toContainElement(row)
    expect(within(row).getByText('May 10')).toBeInTheDocument()
    // Money in, not struck through, not "Before opening", with the Returned chip.
    const amount = within(row).getByText(/75\.00/)
    expect(amount.textContent).toBe('+€75.00')
    expect(amount.className).not.toContain('line-through')
    expect(within(row).queryByText('Before opening')).not.toBeInTheDocument()
    expect(within(row).getByText('Returned').closest('[data-tone]')).toHaveAttribute('data-tone', 'bad')
    // Its (i) names both dates.
    await user.hover(within(row).getByRole('button', { name: /^About To Pot on May 10: returned$/ }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(`Left on Apr 20, ${year}, before the opening balance of May 1, ${year}, and came back on May 10, ${year}: the return adds it to the balance.`)
    // The April row is untouched.
    const april = rowOf(screen.getByText('April bill'))
    expect(within(april).getByText('Before opening')).toBeInTheDocument()
  })

  it('keeps an ordinary sent-back transfer struck where it left, with no (i)', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [{ ...account(), openingDate: '2026-01-01' }],
      transactions: [tx({ id: 'out', type: 2, payee: 'Sent back', amount: 150, date: '2026-06-12', transferAccountId: 'a2', transferAccountName: 'Rainy Day', departedOn: '2026-06-12', returnedOn: '2026-06-15', transferStatus: 'Returned' })],
    })
    renderPage()
    const row = rowOf(await screen.findByText('Sent back', {}, { timeout: 5000 }))
    expect(within(row).getByText(/150\.00/).textContent).toBe('−€150.00')
    expect(within(row).getByText(/150\.00/).className).toContain('line-through')
    expect(within(row).getByText('Jun 12')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /returned$/ })).not.toBeInTheDocument()
  })

  // #344 P3-3: an in-app open from Accounts hands over the account's line of the reconciliation.
  it('uses the reconciliation the Accounts page hands over, and reads it itself on a direct open', { timeout: 15000 }, async () => {
    mockLoads({ recon: [recon({ backedJarsTotal: 999 })] })
    const user = userEvent.setup()
    const { unmount } = renderWithProviders(
      <Routes>
        <Route path="/accounts" element={<Link to="/accounts/a1" state={reconState('a1', recon())}>View</Link>} />
        <Route path="/accounts/:id" element={<AccountDetailPage />} />
      </Routes>,
      { route: '/accounts' },
    )
    await user.click(screen.getByRole('link', { name: 'View' }))
    expect(await screen.findByText('In jars', {}, { timeout: 5000 })).toBeInTheDocument()
    // The handed-over figure (300), not a fresh read (999), and no second reconciliation read.
    expect(screen.getByText('€300.00')).toBeInTheDocument()
    expect(mockGet).not.toHaveBeenCalledWith('/accounts/reconciliation')
    expect(screen.queryByTestId('in-jars-pending')).not.toBeInTheDocument()
    unmount()

    // Opened directly (or reloaded): the page reads the reconciliation.
    mockGet.mockClear()
    renderPage()
    expect(await screen.findByText('€999.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledWith('/accounts/reconciliation')
  })

  it('reads the reconciliation itself when the handed-over state is for another account, or comes back with Back', { timeout: 15000 }, async () => {
    mockLoads({ recon: [recon({ backedJarsTotal: 999 })] })
    renderWithProviders(
      <Routes>
        <Route path="/accounts/:id" element={<AccountDetailPage />} />
      </Routes>,
      // A history entry with state (as after a reload or Back): its navigation is a POP, not a PUSH.
      { route: '/accounts/a1' },
    )
    expect(await screen.findByText('€999.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(reconFromState(reconState('a2', recon({ accountId: 'a2' })), 'a1', true)).toBeNull()
    expect(reconFromState(reconState('a1', recon()), 'a1', false)).toBeNull()
    expect(reconFromState(reconState('a1', undefined), 'a1', true)).toEqual({ line: null })
  })

  // #344 P3-6: the In jars tile's room is kept while its figures load, so the list does not move.
  it('keeps the In jars tile’s room while the reconciliation loads, then the tile takes it', { timeout: 15000 }, async () => {
    let answer!: (v: unknown) => void
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions') return Promise.resolve({ data: [tx()] })
      if (url === '/accounts/reconciliation') return new Promise((r) => (answer = r))
      if (url === '/jars/ledger') return Promise.resolve({ data: [ledgerOf('a1', ['j1'])] })
      return Promise.resolve({ data: {} })
    })
    renderPage()
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    const pending = screen.getByTestId('in-jars-pending')
    // Hidden from screen readers, no words or figures of its own, the real tile's shape.
    expect(pending).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByText('In jars')).not.toBeInTheDocument()
    expect(pending.className).toContain('col-span-2')
    // The hero keeps to its column beside it, as it will beside the tile.
    expect(screen.getByLabelText(/^Everyday Current balance:/).closest('section')!.className).not.toContain('col-span-2!')
    await act(async () => answer({ data: [recon()] }))
    expect(await screen.findByText('In jars')).toBeInTheDocument()
    expect(screen.queryByTestId('in-jars-pending')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'In jars' }).className.trim()).toBe(pending.className.replace(' animate-pulse', '').trim())
  })

  it('keeps no room when the jar ledger says the account holds no jar', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url === '/transactions') return Promise.resolve({ data: [tx()] })
      if (url === '/accounts/reconciliation') return new Promise(() => {})
      if (url === '/jars/ledger') return Promise.resolve({ data: [ledgerOf('a2', ['j1'])] })
      return Promise.resolve({ data: {} })
    })
    renderPage()
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    await waitFor(() => expect(screen.queryByTestId('in-jars-pending')).not.toBeInTheDocument())
    expect(screen.getByLabelText(/^Everyday Current balance:/).closest('section')!.className).toContain('col-span-2!')
  })

  it('a failed reconciliation leaves no tile and no kept room', { timeout: 15000 }, async () => {
    mockLoads({ recon: 'fail', ledger: [ledgerOf('a1', ['j1'])], transactions: [tx()] })
    renderPage()
    await screen.findByLabelText(/^Everyday Current balance:/, {}, { timeout: 5000 })
    await waitFor(() => expect(screen.queryByTestId('in-jars-pending')).not.toBeInTheDocument())
    expect(screen.queryByText('In jars')).not.toBeInTheDocument()
  })

  it('reads Loading…, not the previous account’s name, on an in-app change of account', { timeout: 15000 }, async () => {
    let second!: (v: unknown) => void
    let calls = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') {
        calls++
        const data = [account(), { ...account(), id: 'a2', name: 'Rainy Day' }]
        return calls === 1 ? Promise.resolve({ data }) : new Promise((r) => (second = () => r({ data })))
      }
      return Promise.resolve({ data: [] })
    })
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Routes>
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
        </Routes>
        <Link to="/accounts/a2">Open Rainy Day</Link>
      </>,
      { route: '/accounts/a1' },
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Everyday Current' }, { timeout: 5000 })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Open Rainy Day' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Loading…' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'Everyday Current' })).not.toBeInTheDocument()
    await act(async () => second(undefined))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rainy Day' })).toBeInTheDocument()
  })
})
