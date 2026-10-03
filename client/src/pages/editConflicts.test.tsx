import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'
import { TransactionsPage } from './TransactionsPage'
import { AccountsPage } from './AccountsPage'

// D11: an edit form sends the version it loaded; when someone else saved the record first the
// server answers 409, and the form shows why and reloads the record instead of losing the page.

const MESSAGE = 'Someone else changed this. Reload and try again.'
const conflict = () =>
  Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { status: 409, title: MESSAGE } } })

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-10-10', payee: 'Tesco', amount: 12.5, currency: 'EUR',
    type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: null, accountName: null,
    transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null,
    isSplit: false, splits: [],
    version: 'AAAAAAAAB9E=',
    ...over,
  }
}

function transfer(over: Partial<TransactionDto> = {}): TransactionDto {
  return tx({
    id: 't-tr', payee: 'Move', type: 2, amount: 100, date: '2026-10-05',
    accountId: 'a-joint', accountName: 'Joint', transferAccountId: 'a-rainy', transferAccountName: 'Rainy Day',
    transferStatus: 'InTransit', departedOn: '2026-10-05', receivedOn: null, returnedOn: null, fee: null,
    feeBudgetItemId: null, feeBudgetItemName: null,
    departureConfirmedByStatement: false, receiptConfirmedByStatement: false, returnConfirmedByStatement: false,
    ...over,
  })
}

function accountsFixture(): AccountDto[] {
  return [
    { id: 'a-joint', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 1250, openingDate: '2026-01-01', currentBalance: 1250, displayOrder: 0, version: 'AAAAAAAAC1E=' },
    { id: 'a-rainy', name: 'Rainy Day', type: 1, currency: 'EUR', openingBalance: 500, openingDate: '2026-01-01', currentBalance: 500, displayOrder: 1, version: 'AAAAAAAAC1I=' },
  ]
}

/** The register reads `first` until someone else's save lands, then `then`. */
function mockRegister(first: TransactionDto[], then: TransactionDto[]) {
  let reads = 0
  mockGet.mockImplementation((url: string) => {
    if (url === '/transactions') return Promise.resolve({ data: reads++ === 0 ? first : then })
    if (url === '/accounts') return Promise.resolve({ data: accountsFixture() })
    if (url === '/members') return Promise.resolve({ data: [] })
    return Promise.resolve({ data: null })
  })
}

describe('edit conflicts (D11)', () => {
  beforeEach(() => {
    resetApiMocks()
  })

  it('a transaction edit sends its version; a 409 shows why and reloads the row into the open form', { timeout: 20000 }, async () => {
    const theirs = tx({ payee: 'Tesco Extra', amount: 15, version: 'AAAAAAAAB+A=' })
    mockRegister([tx()], [theirs])
    mockPut.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ data: { ...theirs, amount: 20, version: 'AAAAAAAAB+E=' } })
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)

    await user.click(await screen.findByLabelText('Edit transaction: Tesco', {}, { timeout: 5000 }))
    await user.clear(screen.getByLabelText('Edit amount'))
    await user.type(screen.getByLabelText('Edit amount'), '20')
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1', expect.objectContaining({ amount: 20, version: 'AAAAAAAAB9E=' })))
    expect(await screen.findByText(MESSAGE, {}, { timeout: 5000 })).toBeInTheDocument()
    // The form stays open on what the other login saved, the page with it.
    expect(screen.getByLabelText('Edit payee')).toHaveValue('Tesco Extra')
    expect(screen.getByLabelText('Edit amount')).toHaveValue('15')

    // Redone on top, the save carries the version just read and goes through.
    await user.clear(screen.getByLabelText('Edit amount'))
    await user.type(screen.getByLabelText('Edit amount'), '20')
    await user.click(screen.getByLabelText('Save transaction'))
    await waitFor(() => expect(mockPut).toHaveBeenLastCalledWith('/transactions/t1', expect.objectContaining({ payee: 'Tesco Extra', amount: 20, version: 'AAAAAAAAB+A=' })))
    await waitFor(() => expect(screen.queryByLabelText('Edit payee')).not.toBeInTheDocument())
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument()
  })

  it('a transfer edit sends its version; a 409 keeps the dialog open on the transfer as saved since', { timeout: 20000 }, async () => {
    const theirs = transfer({ receivedOn: '2026-10-06', transferStatus: 'Completed', payee: 'Top up', version: 'AAAAAAAAB+I=' })
    mockRegister([transfer()], [theirs])
    mockPut.mockRejectedValueOnce(conflict())
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)

    await user.click(await screen.findByLabelText('Edit transfer: Move', {}, { timeout: 5000 }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    await user.clear(within(dialog).getByLabelText('Transfer amount'))
    await user.type(within(dialog).getByLabelText('Transfer amount'), '120')
    await user.click(within(dialog).getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t-tr/transfer', expect.objectContaining({ amount: 120, version: 'AAAAAAAAB9E=' })))
    const reopened = await screen.findByRole('dialog', { name: 'Edit transfer' }, { timeout: 5000 })
    expect(await within(reopened).findByText(MESSAGE, {}, { timeout: 5000 })).toBeInTheDocument()
    // Both legs as the other login left them: the receipt they confirmed and the note.
    expect(within(reopened).getByLabelText('Transfer receipt date')).toHaveValue('2026-10-06')
    expect(within(reopened).getByLabelText('Transfer note')).toHaveValue('Top up')
    expect(within(reopened).getByLabelText('Transfer amount')).toHaveValue('100')
  })

  it('a split sends its version; a 409 shows why and reopens the split editor on the slices saved since', { timeout: 20000 }, async () => {
    // #308 review P2-1: the split editor loads the slices and saves them back whole.
    const lines = budgetMonth({
      key: '2026-10',
      month: 10,
      categories: [
        budgetCategory({
          id: 'c-living', name: 'Living',
          items: [budgetItem({ id: 'i-food', name: 'Food' }), budgetItem({ id: 'i-home', name: 'Home' }), budgetItem({ id: 'i-fun', name: 'Fun' })],
        }),
      ],
    })
    const slice = (id: string, budgetItemId: string, budgetItemName: string, amount: number) =>
      ({ id, budgetItemId, budgetItemName, memberId: null, memberName: null, amount })
    const loaded = tx({ isSplit: true, splits: [slice('s1', 'i-food', 'Food', 7.5), slice('s2', 'i-home', 'Home', 5)] })
    const theirs = tx({ isSplit: true, splits: [slice('s3', 'i-food', 'Food', 2.5), slice('s4', 'i-fun', 'Fun', 10)], version: 'AAAAAAAAB+A=' })
    let reads = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/transactions') return Promise.resolve({ data: reads++ === 0 ? [loaded] : [theirs] })
      if (url === '/accounts' || url === '/members') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: lines })
    })
    mockPut.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ data: { ...theirs, version: 'AAAAAAAAB+E=' } })
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />)

    await user.click(await screen.findByLabelText('Split transaction: Tesco', {}, { timeout: 5000 }))
    await user.clear(screen.getByLabelText('Split line 1 amount'))
    await user.type(screen.getByLabelText('Split line 1 amount'), '10')
    await user.clear(screen.getByLabelText('Split line 2 amount'))
    await user.type(screen.getByLabelText('Split line 2 amount'), '2.5')
    await user.click(screen.getByLabelText('Save split'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1/splits', expect.objectContaining({ version: 'AAAAAAAAB9E=' })))
    expect(await screen.findByText(MESSAGE, {}, { timeout: 5000 })).toBeInTheDocument()
    // The editor stays open on the split the other login saved, to redo the change on top.
    await waitFor(() => expect(screen.getByLabelText('Split line 2 category')).toHaveValue('i-fun'), { timeout: 5000 })
    expect(screen.getByLabelText('Split line 2 amount')).toHaveValue('10')

    // Saved again, the split carries the version just read and goes through.
    await user.click(screen.getByLabelText('Save split'))
    await waitFor(() => expect(mockPut).toHaveBeenLastCalledWith('/transactions/t1/splits', expect.objectContaining({ version: 'AAAAAAAAB+A=' })))
    await waitFor(() => expect(screen.queryByLabelText('Save split')).not.toBeInTheDocument())
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument()
  })

  it('an account edit sends its version; a 409 shows why and refills the form from the latest read', { timeout: 20000 }, async () => {
    const theirs = accountsFixture().map((a) => (a.id === 'a-joint' ? { ...a, name: 'Household', version: 'AAAAAAAAC2E=' } : a))
    let reads = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: reads++ === 0 ? accountsFixture() : theirs })
      return Promise.resolve({ data: [] })
    })
    mockPut.mockRejectedValueOnce(conflict())
    const user = userEvent.setup()
    renderWithProviders(<AccountsPage />)

    await user.click(await screen.findByRole('button', { name: 'Edit Joint' }, { timeout: 5000 }))
    await user.clear(screen.getByLabelText('Name for Joint'))
    await user.type(screen.getByLabelText('Name for Joint'), 'Shared')
    await user.click(screen.getByRole('button', { name: 'Save Joint' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/a-joint', expect.objectContaining({ name: 'Shared', version: 'AAAAAAAAC1E=' })))
    expect(await screen.findByText(MESSAGE, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByLabelText('Name for Household', {}, { timeout: 5000 })).toHaveValue('Household')
  })
})
