import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, TransactionDto } from '../types'

// The restyled Transactions list (restyle PR 5): one card with the All / Unassigned filter and a
// search, rows grouped by day, each row's rarer actions behind a ⋯ (a bottom sheet titled with the
// payee on a phone), and focus kept in place as the inline editors and dialogs open and close.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { txAction, txDelete, txItems } from '../test/rowMenu'
import { TransactionsPage } from './TransactionsPage'
import { setMoneyFormat } from '../lib/money'
import { todayIso } from '../lib/dates'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

function budget(): BudgetMonthDto {
  return budgetMonth({
    categories: [
      budgetCategory({ id: 'c-inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-salary', name: 'Salary' })] }),
      budgetCategory({ id: 'c-exp', name: 'Everyday', displayOrder: 1, items: [budgetItem({ id: 'i-groceries', name: 'Groceries' })] }),
    ],
  })
}

function accounts(): AccountDto[] {
  return [
    { id: 'a-joint', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 100, currentBalance: 100, displayOrder: 0 },
    { id: 'a-every', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, currentBalance: 100, displayOrder: 1 },
  ]
}

/** A day of the month the top bar shows (today's), `back` days before today. */
function daysAgo(back: number): string {
  return todayIso(new Date(Date.now() - back * 86_400_000))
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-07-10', payee: 'Tesco', amount: 40, currency: 'EUR', type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null, memberId: null, memberName: null,
    isSplit: false, splits: [],
    ...over,
  }
}

const transfer = (over: Partial<TransactionDto> = {}) =>
  tx({
    type: 2, amount: 100, accountId: 'a-joint', accountName: 'Joint', transferAccountId: 'a-every', transferAccountName: 'Everyday',
    transferStatus: 'InTransit', departedOn: '2026-07-10', receivedOn: null, returnedOn: null,
    ...over,
  })

function mockLoad(transactions: TransactionDto[]) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/transactions') return Promise.resolve({ data: [...transactions] })
    if (url === '/accounts') return Promise.resolve({ data: accounts() })
    if (url === '/members' || url === '/jars/ledger') return Promise.resolve({ data: [] })
    if (url === '/auth/me') return Promise.resolve({ data: {} })
    return Promise.resolve({ data: budget() })
  })
}

/** Makes the page's media queries answer as on a given screen (jsdom has no matchMedia). */
function screenMatching(...queries: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}
const asPhone = () => screenMatching('(max-width: 699.98px)')

const renderPage = () => renderWithProviders(<TransactionsPage />)
const more = (row: string) => screen.getByRole('button', { name: `${row}: more actions` })
const payees = () => screen.getAllByTestId('tx-row').map((r) => r.querySelector('[data-row-trigger], span.font-semibold')?.textContent)

beforeEach(() => {
  resetApiMocks()
  setMoneyFormat('comma-dot')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TransactionsPage list — the row ⋯', () => {
  it('each kind of row offers its own actions, in order, Delete last after a divider', { timeout: 20000 }, async () => {
    mockLoad([
      tx({ id: 'e', payee: 'Tesco' }),
      tx({ id: 'i', payee: 'Payday', type: 1 }),
      tx({ id: 'r', payee: 'Money back', type: 1, refundOfTransactionId: 'e', refundOfPayee: 'Tesco', refundOfDate: '2026-07-10', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      transfer({ id: 'x', payee: 'Stash' }),
      transfer({ id: 'p', payee: 'From Joint', transferStatus: 'PendingReview', departedOn: null, receivedOn: '2026-07-11' }),
      transfer({ id: 'c', payee: 'Done', transferStatus: 'Completed', receivedOn: '2026-07-11', fee: 2, feeBudgetItemId: 'i-groceries', feeBudgetItemName: 'Groceries' }),
      tx({ id: 'f', payee: 'Transfer fee', amount: 2, accountId: 'a-joint', accountName: 'Joint', feeForTransferId: 'c' }),
      tx({ id: 'v', payee: 'Lidl', accountName: 'Private account', inPrivateAccount: true, budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Tesco', {}, { timeout: 5000 })

    expect(await txItems(user, 'Tesco')).toEqual(['Edit transaction: Tesco', 'Split transaction: Tesco', 'Delete transaction: Tesco'])
    expect(await txItems(user, 'Payday')).toEqual([
      'Edit transaction: Payday',
      'Split transaction: Payday',
      'Mark as refund: Payday',
      'Delete transaction: Payday',
    ])
    // A refund is never split (rule 38); it can be unmarked.
    expect(await txItems(user, 'Money back')).toEqual(['Edit transaction: Money back', 'Not a refund: Money back', 'Delete transaction: Money back'])
    // A transfer is edited through its form, never split, and takes its missing leg.
    expect(await txItems(user, 'Stash')).toEqual(['Edit transfer: Stash', 'Confirm receipt: Stash', 'Delete transaction: Stash'])
    expect(await txItems(user, 'From Joint')).toEqual([
      'Edit transfer: From Joint',
      'Add departure date: From Joint',
      'Delete transaction: From Joint',
    ])
    expect(await txItems(user, 'Done')).toEqual(['Edit transfer: Done', 'Delete transaction: Done'])
    // The fee row and someone else's private entry have no ⋯ (an (i) carries the fee row's note).
    expect(screen.queryByRole('button', { name: 'Transfer fee: more actions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Transfer fee' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lidl: more actions' })).not.toBeInTheDocument()

    // The visible labels are short; Delete reads in red after the one divider.
    await user.click(more('Tesco'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Edit', 'Split', 'Delete'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: 'Delete transaction: Tesco' }).className).toContain('text-bad')
  })

  it('works from the keyboard: Enter opens the ⋯, arrows move, Escape closes and gives focus back to the ⋯', { timeout: 15000 }, async () => {
    mockLoad([tx()])
    const user = userEvent.setup()
    renderPage()

    const trigger = await screen.findByRole('button', { name: 'Tesco: more actions' }, { timeout: 5000 })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Edit transaction: Tesco' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Split transaction: Tesco' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Delete transaction: Tesco' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()

    // Enter on Edit opens the row's form with focus in it; Escape closes it and gives focus back to the ⋯.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Edit date')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Edit date')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Tesco')).toHaveFocus())
  })
})

describe('TransactionsPage list — focus stays in place', () => {
  it('gives focus back to the ⋯ after the inline edit, the split and the refund link close', { timeout: 20000 }, async () => {
    mockLoad([tx(), tx({ id: 't2', payee: 'Payday', type: 1 })])
    mockPut.mockResolvedValue({ data: tx({ payee: 'Tesco' }) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Tesco', {}, { timeout: 5000 })

    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    await waitFor(() => expect(screen.getByLabelText('Edit date')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(more('Tesco')).toHaveFocus())

    // A save gives focus back to the ⋯ too.
    await txAction(user, 'Tesco', 'Edit transaction: Tesco')
    await user.click(await screen.findByRole('button', { name: 'Save transaction' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ payee: 'Tesco' })))
    await waitFor(() => expect(more('Tesco')).toHaveFocus())

    await txAction(user, 'Tesco', 'Split transaction: Tesco')
    await waitFor(() => expect(screen.getByLabelText('Split line 1 amount')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Cancel split' }))
    await waitFor(() => expect(more('Tesco')).toHaveFocus())

    await txAction(user, 'Payday', 'Mark as refund: Payday')
    await waitFor(() => expect(screen.getByLabelText('Purchase refunded by Payday')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Purchase refunded by Payday')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Payday')).toHaveFocus())
  })

  it('gives focus back after the leg editor, the assign picker and the dialogs close', { timeout: 20000 }, async () => {
    mockLoad([
      transfer({ id: 'x', payee: 'Stash' }),
      tx({ id: 'c', payee: 'Cafe' }),
      tx({ id: 'g', payee: 'London Cab', currency: 'GBP', amount: 12.5, fxPending: true }),
    ])
    mockPut.mockResolvedValue({ data: tx({ id: 'c', payee: 'Cafe', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Stash', {}, { timeout: 5000 })

    // The leg editor opens inside the row with focus on its date.
    await txAction(user, 'Stash', 'Confirm receipt: Stash')
    await waitFor(() => expect(screen.getByLabelText('Receipt date')).toHaveFocus())
    expect(screen.getByLabelText('Receipt date').closest('[data-testid="tx-row"]')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Cancel transfer leg' }))
    await waitFor(() => expect(more('Stash')).toHaveFocus())

    // The transfer's own form, a dialog: closing it gives focus back to the ⋯.
    await txAction(user, 'Stash', 'Edit transfer: Stash')
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Stash')).toHaveFocus())

    // The assign picker: Escape gives focus back to the chip; a pick saves and keeps it there.
    await user.click(screen.getByRole('button', { name: 'Assign Cafe' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Assign Cafe' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign Cafe' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Assign Cafe' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign Cafe' }), 'i-groceries')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reassign Cafe:/ })).toHaveFocus())

    // The € amount dialog gives focus back to its chip.
    await user.click(screen.getByRole('button', { name: 'Enter amount in EUR: London Cab' }))
    const convert = await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.click(within(convert).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enter amount in EUR: London Cab' })).toHaveFocus())
  })

  it('after a delete, focus moves to the next row (or the one before)', { timeout: 15000 }, async () => {
    mockLoad([tx({ id: 'a', payee: 'Alpha' }), tx({ id: 'b', payee: 'Beta' })])
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Alpha', {}, { timeout: 5000 })

    await txDelete(user, 'Alpha')
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Beta')).toHaveFocus())
  })

  it('after a delete, focus skips a row with nothing to focus (someone else’s private entry)', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 'a', payee: 'Alpha' }),
      tx({ id: 'p', payee: 'Pharmacy', accountName: 'Private account', inPrivateAccount: true, budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 'b', payee: 'Beta' }),
    ])
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Alpha', {}, { timeout: 5000 })

    await txDelete(user, 'Alpha')
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Beta')).toHaveFocus())
  })

  it('a row assigned in the Unassigned filter leaves it, and focus moves to the next row', { timeout: 15000 }, async () => {
    mockLoad([tx({ id: 'a', payee: 'Alpha' }), tx({ id: 'b', payee: 'Beta' })])
    mockPut.mockResolvedValue({ data: tx({ id: 'a', payee: 'Alpha', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Alpha', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Unassigned' }))

    await user.click(screen.getByRole('button', { name: 'Assign Alpha' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign Alpha' }), 'i-groceries')
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())
    await waitFor(() => expect(more('Beta')).toHaveFocus())

    // The last one: the list has nothing left, so focus goes to the filter.
    mockPut.mockResolvedValue({ data: tx({ id: 'b', payee: 'Beta', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    await user.click(screen.getByRole('button', { name: 'Assign Beta' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign Beta' }), 'i-groceries')
    expect(await screen.findByText('Nothing left to assign.', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unassigned' })).toHaveFocus())
  })
})

describe('TransactionsPage list — what a screen reader hears of a row', () => {
  it('the ⋯ is described by its day and amount, and the category chip by its category', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 'a', payee: 'Tesco', date: daysAgo(0), budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({ id: 'b', payee: 'Tesco', date: daysAgo(1), amount: 12 }),
    ])
    renderPage()
    await screen.findAllByText('Tesco', {}, { timeout: 5000 })

    // Two rows with one name: their ⋯ keep the name the tests and journeys use, and tell the rows apart.
    const [first, second] = screen.getAllByRole('button', { name: 'Tesco: more actions' })
    expect(first).toHaveAccessibleDescription('Today −€40.00')
    expect(second).toHaveAccessibleDescription('Yesterday −€12.00')
    // The chip is named for what it does, then the category it shows.
    expect(screen.getByRole('button', { name: /^Reassign Tesco:/ })).toHaveAccessibleName('Reassign Tesco: Groceries')
    expect(screen.getByRole('button', { name: 'Assign Tesco' })).toHaveAccessibleDescription('')
  })
})

describe('TransactionsPage list — on a phone', () => {
  it('the whole row opens a sheet titled with the payee, the same actions; its chips stay their own buttons', { timeout: 20000 }, async () => {
    asPhone()
    mockLoad([tx({ budgetItemId: null }), tx({ id: 'g', payee: 'London Cab', currency: 'GBP', amount: 12.5, fxPending: true })])
    const user = userEvent.setup()
    renderPage()

    // One Add transaction, under the KPIs (not in the top bar).
    expect(await screen.findAllByRole('button', { name: 'Add transaction' }, { timeout: 5000 })).toHaveLength(1)
    // No ⋯ on a phone: the row is the button.
    expect(screen.queryByRole('button', { name: 'Tesco: more actions' })).not.toBeInTheDocument()
    const row = screen.getByRole('button', { name: 'Tesco' })
    await user.click(row)
    const sheet = await screen.findByRole('dialog', { name: 'Tesco' }, { timeout: 5000 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const actions = within(sheet)
      .getAllByRole('button')
      .filter((b) => b.textContent)
    expect(actions.map((b) => b.textContent)).toEqual(['Edit', 'Split', 'Delete'])
    expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Edit transaction: Tesco',
      'Split transaction: Tesco',
      'Delete transaction: Tesco',
    ])

    // Escape closes it and gives focus back to the row.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(row).toHaveFocus())

    // Edit from the sheet opens the row's form with focus in it; Cancel gives focus back to the row.
    await user.click(row)
    await user.click(within(await screen.findByRole('dialog', { name: 'Tesco' })).getByRole('button', { name: 'Edit transaction: Tesco' }))
    await waitFor(() => expect(screen.getByLabelText('Edit date')).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tesco' })).toHaveFocus())

    // "+ Assign" and "+ € amount" are tapped on their own, not through the sheet.
    await user.click(screen.getByRole('button', { name: 'Assign Tesco' }))
    expect(await screen.findByRole('combobox', { name: 'Assign Tesco' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Tesco' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Enter amount in EUR: London Cab' }))
    const convert = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(within(convert).getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'London Cab' })).not.toBeInTheDocument()
  })
})

describe('TransactionsPage list — a phone row’s second line', () => {
  it('holds the category and the account; the slices and the jar split are said in the sheet', { timeout: 20000 }, async () => {
    asPhone()
    mockLoad([
      tx({
        id: 's', payee: 'Grocer', amount: 50, isSplit: true, splits: [
          { id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 30 },
          { id: 's2', budgetItemId: 'i-salary', budgetItemName: 'Kids', memberId: null, memberName: null, amount: 20 },
        ],
      }),
      transfer({
        id: 'x', payee: 'Into jars', transferStatus: 'Completed', receivedOn: '2026-07-10',
        jarAllocations: [{ accountId: 'a-every', jarId: 'j1', jarName: 'Holiday', amount: 300 }],
      }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Into jars', {}, { timeout: 5000 })

    // The slices truncate on the line (the chip's title has them all); the sheet's line says them in full.
    expect(screen.getByTitle('Split: Groceries €30.00 · Kids €20.00')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Grocer' }))
    expect(await screen.findByRole('dialog', { name: 'Grocer' })).toHaveAccessibleDescription('Split: Groceries €30.00 · Kids €20.00')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // A transfer's row has no jar chip on a phone: the sheet says where the money went. No
    // Transfer chip either (the tile and the accounts say it), but a screen reader is told.
    const row = screen.getByRole('button', { name: 'Into jars' }).closest('[data-testid="tx-row"]') as HTMLElement
    expect(within(row).queryByText(/Holiday/)).not.toBeInTheDocument()
    expect(within(row).getByText('Transfer')).toHaveClass('sr-only')
    await user.click(screen.getByRole('button', { name: 'Into jars' }))
    const sheet = await screen.findByRole('dialog', { name: 'Into jars' })
    expect(sheet).toHaveAccessibleDescription('Into jar: Holiday 300.00')
  })
})

describe('TransactionsPage list — search', () => {
  it('filters on payee, category and account as you type, with no request; Escape and ✕ close it', { timeout: 20000 }, async () => {
    mockLoad([
      tx({ id: 'a', payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', accountId: 'a-joint', accountName: 'Joint' }),
      tx({ id: 'b', payee: 'Payday', type: 1, budgetItemId: 'i-salary', budgetItemName: 'Salary', accountId: 'a-every', accountName: 'Everyday' }),
      tx({ id: 'c', payee: 'Cafe', accountId: 'a-joint', accountName: 'Joint' }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Tesco', {}, { timeout: 5000 })
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/accounts'))
    const requests = mockGet.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Search transactions' }))
    const box = screen.getByRole('searchbox', { name: 'Search transactions' })
    expect(box).toHaveFocus()

    await user.type(box, 'groc') // a category
    expect(payees()).toEqual(['Tesco'])
    expect(screen.getByText('1 transaction found')).toBeInTheDocument()
    await user.clear(box)
    await user.type(box, 'every') // an account
    expect(payees()).toEqual(['Payday'])
    await user.clear(box)
    await user.type(box, 'CAF') // a payee, any case
    expect(payees()).toEqual(['Cafe'])
    await user.clear(box)
    await user.type(box, 'zzz')
    expect(screen.queryAllByTestId('tx-row')).toHaveLength(0)
    expect(screen.getByText('No match for “zzz”.')).toBeInTheDocument()
    expect(screen.getByText('0 transactions found')).toBeInTheDocument()

    // Escape closes the search, gives focus back to its button and brings every row back.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search transactions' })).toHaveFocus())
    expect(screen.getAllByTestId('tx-row')).toHaveLength(3)

    // The ✕ does the same.
    await user.click(screen.getByRole('button', { name: 'Search transactions' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search transactions' }), 'tesco')
    expect(payees()).toEqual(['Tesco'])
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search transactions' })).toHaveFocus())
    expect(screen.getAllByTestId('tx-row')).toHaveLength(3)

    // All on the client: no request was made.
    expect(mockGet.mock.calls.length).toBe(requests)
  })

  it('searches within the Unassigned filter, and matches a split line and a transfer', { timeout: 15000 }, async () => {
    mockLoad([
      tx({ id: 'a', payee: 'Tesco' }),
      tx({ id: 'b', payee: 'Tesla', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }),
      tx({
        id: 's', payee: 'Market', isSplit: true,
        splits: [
          { id: 's1', budgetItemId: 'i-groceries', budgetItemName: 'Groceries', memberId: null, memberName: null, amount: 20 },
          { id: 's2', budgetItemId: 'i-salary', budgetItemName: 'Pharmacy', memberId: null, memberName: null, amount: 20 },
        ],
      }),
      transfer({ id: 'x', payee: 'Stash' }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Tesco', {}, { timeout: 5000 })

    await user.click(screen.getByRole('button', { name: 'Search transactions' }))
    const box = screen.getByRole('searchbox', { name: 'Search transactions' })
    await user.type(box, 'pharm')
    expect(payees()).toEqual(['Market'])
    await user.clear(box)
    await user.type(box, 'transfer')
    expect(payees()).toEqual(['Stash'])
    await user.clear(box)
    await user.type(box, 'tes')
    expect(payees()).toEqual(['Tesco', 'Tesla'])
    await user.click(screen.getByRole('button', { name: 'Unassigned' }))
    expect(payees()).toEqual(['Tesco'])
  })
})

describe('TransactionsPage list — days, the filter badge and the KPIs', () => {
  it('groups rows under day headers, newest first, keeping the API order within a day', { timeout: 15000 }, async () => {
    const today = daysAgo(0)
    const yesterday = daysAgo(1)
    const earlier = daysAgo(5)
    mockLoad([
      tx({ id: 'o', payee: 'Old', date: '2024-03-05' }),
      tx({ id: 'a', payee: 'Alpha', date: today }),
      tx({ id: 'g', payee: 'Gamma', date: yesterday }),
      tx({ id: 'b', payee: 'Beta', date: today }),
      tx({ id: 'd', payee: 'Delta', date: earlier }),
    ])
    renderPage()
    const list = within(await screen.findByRole('region', { name: 'Transactions' }, { timeout: 5000 }))

    const headers = list.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headers).toHaveLength(4)
    expect(headers.slice(0, 2)).toEqual(['Today', 'Yesterday'])
    // jsdom's locale is en-US: "Tue Oct 6", with the year only for another year.
    const sameYear = earlier.slice(0, 4) === today.slice(0, 4)
    expect(headers[2]).toMatch(sameYear ? /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/ : /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{4}$/)
    expect(headers[3]).toBe('Tue Mar 5, 2024')
    expect(list.getByRole('heading', { name: 'Today', level: 2 })).toBeInTheDocument()
    expect(payees()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Old'])
  })

  it('counts what is left to assign in a badge on the Unassigned filter, whose name stays "Unassigned"', { timeout: 15000 }, async () => {
    mockLoad([tx({ id: 'a', payee: 'Tesco' }), tx({ id: 'b', payee: 'Cafe' }), tx({ id: 'c', payee: 'Lidl', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' })])
    mockPut.mockResolvedValue({ data: tx({ id: 'a', payee: 'Tesco', budgetItemId: 'i-groceries', budgetItemName: 'Groceries' }) })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Tesco', {}, { timeout: 5000 })

    const filter = screen.getByRole('button', { name: 'Unassigned' })
    expect(filter).toHaveTextContent('Unassigned2')
    expect(filter).toHaveAccessibleDescription('2 to assign')

    await user.click(screen.getByRole('button', { name: 'Assign Tesco' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign Tesco' }), 'i-groceries')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unassigned' })).toHaveAccessibleDescription('1 to assign'))
    expect(screen.getByRole('button', { name: 'Unassigned' })).toHaveTextContent('Unassigned1')
  })

  it('shows Income and Spent for the month, unsigned, the (i) saying what Spent counts', { timeout: 15000 }, async () => {
    const day = daysAgo(0)
    mockLoad([
      tx({ id: 'i', payee: 'Payday', type: 1, amount: 2500, date: day }),
      tx({ id: 'e', payee: 'Tesco', amount: 40, date: day }),
      transfer({ id: 'x', payee: 'Stash', date: day, departedOn: day }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Payday', {}, { timeout: 5000 })

    expect(screen.getByLabelText(/^Income for .+: €2,500\.00$/)).toHaveTextContent(/^€2,500\.00$/)
    expect(screen.getByLabelText(/^Spent in .+: €40\.00$/)).toHaveTextContent(/^€40\.00$/)
    // No "N transactions" count any more.
    expect(screen.queryByText(/^\d+ transactions?$/)).not.toBeInTheDocument()

    await user.hover(screen.getByRole('button', { name: 'About spent' }))
    const hint = await screen.findByRole('tooltip')
    expect(hint).toHaveTextContent(/transfer fees and payments from jars included, less refunds received that month/)
    expect(hint).toHaveTextContent(/Transfers between your own accounts and payments still waiting for their EUR amount are not counted/)
  })
})
