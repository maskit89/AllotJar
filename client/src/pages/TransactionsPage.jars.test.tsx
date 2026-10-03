import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, JarAccountLedgerDto, TransactionDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { TransactionsPage } from './TransactionsPage'

// The jar prompts (rules 78/79/80) on the register: "Savings" backs the Holiday and Car jars,
// "Everyday" backs none; "Holiday" is the Holiday jar's savings line, "Rent" is an ordinary line.

function budget(): BudgetMonthDto {
  return {
    id: 'm1', key: '2026-09', year: 2026, month: 9, baseCurrency: 'EUR',
    totalIncome: 3000, totalPlanned: 1000, remainingToBudget: 2000, isBalanced: false,
    categories: [
      {
        id: 'c1', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 1000, totalActual: 0,
        items: [
          { id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1000, actualAmount: 0, remaining: 1000, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false },
        ],
      },
      {
        id: 'c2', name: 'Jars', kind: 'Savings', displayOrder: 1, totalPlanned: 100, totalActual: 0,
        items: [
          { id: 'i-holiday', name: 'Holiday', displayOrder: 0, plannedAmount: 100, actualAmount: 0, remaining: 100, savingsId: 'j-hol', savingsAvailable: 400, dueDay: null, isPaid: false },
        ],
      },
    ],
  }
}

function accountsFixture(): AccountDto[] {
  return [
    { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, currentBalance: 100, displayOrder: 0 },
    { id: 'a2', name: 'Savings', type: 1, currency: 'EUR', openingBalance: 500, currentBalance: 500, displayOrder: 1 },
  ]
}

function ledgers(): JarAccountLedgerDto[] {
  return [
    {
      accountId: 'a2', accountName: 'Savings', currency: 'EUR', asOf: '2026-09-26',
      accountBalance: 500, unallocated: 0, positiveAllocations: 500, hasBackingDeficit: false,
      unreconciledAllocations: 0, requiresReview: false,
      jars: [
        { jarId: 'j-hol', name: 'Holiday', balance: 400, isArchived: false },
        { jarId: 'j-car', name: 'Car', balance: 100, isArchived: false },
        { jarId: 'j-old', name: 'Old boat', balance: 0, isArchived: true },
      ],
    },
  ]
}

function tx(over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't1', date: '2026-09-10', payee: 'Tesco', amount: 12.5, currency: 'EUR',
    type: 0, bankReference: null,
    budgetItemId: null, budgetItemName: null, accountId: 'a2', accountName: 'Savings',
    transferAccountId: null, transferAccountName: null,
    memberId: null, memberName: null,
    isSplit: false, splits: [],
    ...over,
  }
}

/** `ledgerData` null makes the jar ledger read fail (the hook then knows no ledgers). */
function mockLoad(transactions: TransactionDto[], ledgerData: JarAccountLedgerDto[] | null = ledgers()) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/transactions') return Promise.resolve({ data: transactions })
    if (url === '/accounts') return Promise.resolve({ data: accountsFixture() })
    if (url === '/members') return Promise.resolve({ data: [] })
    if (url.startsWith('/jars/ledger')) {
      return ledgerData ? Promise.resolve({ data: ledgerData }) : Promise.reject(new Error('ledger read failed'))
    }
    return Promise.resolve({ data: budget() })
  })
}

const renderPage = () => renderWithProviders(<TransactionsPage />)

async function openAddModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add transaction' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('TransactionsPage jar prompts', () => {
  beforeEach(() => {
    resetApiMocks()
  })

  // Rule 78 — income into a jar-backed account asks how it is divided; other accounts never ask.
  it('asks how income into a jar-backed account is divided and posts jarAllocations', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ payee: 'Salary', amount: 500, type: 1 }) })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openAddModal(user)
    await user.selectOptions(screen.getByLabelText('Transaction type'), '1')
    await user.type(screen.getByLabelText('Transaction payee'), 'Salary')
    await user.type(screen.getByLabelText('Transaction amount'), '500')

    // Everyday backs no jars: no prompt.
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a1')
    expect(screen.queryByTestId('add-jar-allocation')).not.toBeInTheDocument()

    // Savings backs Holiday and Car (the archived jar is not offered).
    await user.selectOptions(screen.getByLabelText('Transaction account'), 'a2')
    expect(await screen.findByTestId('add-jar-allocation')).toBeInTheDocument()
    expect(screen.queryByLabelText('Amount for Old boat')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount for Holiday'), '300')
    await user.type(screen.getByLabelText('Amount for Car'), '200')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({
          type: 1,
          accountId: 'a2',
          jarAllocations: [
            { jarId: 'j-hol', amount: 300 },
            { jarId: 'j-car', amount: 200 },
          ],
        }),
      ),
    )
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('paidFromJarId')
  })

  // O9b (answered 1 October 2026): left empty, a refund of a payment from a completed jar or a
  // paid cycle goes back into that jar on the server; the prompt says so instead of "unallocated".
  it('O9b: a refund\'s jar prompt says what leaving it empty does', { timeout: 15000 }, async () => {
    mockLoad([tx({ id: 't-sofa', payee: 'Sofa shop', amount: 150, budgetItemId: 'i-holiday', budgetItemName: 'Holiday' })])
    const user = userEvent.setup()
    renderPage()

    await openAddModal(user)
    await user.selectOptions(screen.getByLabelText('Transaction type'), '-1')
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a2')

    const prompt = await screen.findByTestId('add-jar-allocation')
    expect(prompt).toHaveTextContent(
      'Left empty, a refund of a payment from a completed jar, or of the payment a cycle was marked paid with, goes back into that jar; any other stays unallocated.',
    )
    expect(prompt).not.toHaveTextContent('Leave a jar empty to keep that money unallocated.')
  })

  it('leaves income unallocated when the prompt is dismissed (no jarAllocations sent)', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ payee: 'Salary', amount: 500, type: 1 }) })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openAddModal(user)
    await user.selectOptions(screen.getByLabelText('Transaction type'), '1')
    await user.type(screen.getByLabelText('Transaction amount'), '500')
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a2')
    expect(await screen.findByTestId('add-jar-allocation')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('jarAllocations')
  })

  // Rule 79 — a payment from a jar-backed account on a line that is not a jar asks which jar.
  it('asks which jar a payment on a non-jar line comes from and posts paidFromJarId', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ budgetItemId: 'i-rent', budgetItemName: 'Rent' }) })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openAddModal(user)
    await user.type(screen.getByLabelText('Transaction payee'), 'Tesco')
    await user.type(screen.getByLabelText('Transaction amount'), '12')
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a2')
    // No line yet: the payment draws from unallocated money, nothing to ask.
    expect(screen.queryByLabelText('Which jar in Savings does this come from?')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Assign transaction to'), 'i-rent')
    const paidFrom = await screen.findByLabelText('Which jar in Savings does this come from?')
    await user.selectOptions(paidFrom, 'j-hol')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions',
        expect.objectContaining({ type: 0, accountId: 'a2', budgetItemId: 'i-rent', paidFromJarId: 'j-hol' }),
      ),
    )
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('jarAllocations')
  })

  it('never asks for a payment on a jar line (it draws from that jar)', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ budgetItemId: 'i-holiday', budgetItemName: 'Holiday' }) })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openAddModal(user)
    await user.type(screen.getByLabelText('Transaction amount'), '12')
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a2')
    await user.selectOptions(screen.getByLabelText('Assign transaction to'), 'i-holiday')
    expect(screen.queryByLabelText('Which jar in Savings does this come from?')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][1]).toEqual(expect.objectContaining({ budgetItemId: 'i-holiday' }))
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('paidFromJarId')
  })

  it('prompts on inline assign to a non-jar line and sends the jar with the assignment', { timeout: 15000 }, async () => {
    mockLoad([tx()])
    mockPut.mockResolvedValue({ data: tx({ budgetItemId: 'i-rent', budgetItemName: 'Rent' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Assign Tesco'), 'i-rent')

    // Nothing is saved until the jar question is answered.
    const dialog = within(await screen.findByRole('dialog', { name: 'Which jar does this come from?' }, { timeout: 5000 }))
    expect(mockPut).not.toHaveBeenCalled()
    await user.selectOptions(dialog.getByLabelText('Which jar in Savings does this come from?'), 'j-car')
    await user.click(dialog.getByRole('button', { name: 'Use this jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-rent', paidFromJarId: 'j-car' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('"Unallocated" answers the inline prompt with a null jar', { timeout: 15000 }, async () => {
    mockLoad([tx()])
    mockPut.mockResolvedValue({ data: tx({ budgetItemId: 'i-rent', budgetItemName: 'Rent' }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Assign Tesco'), 'i-rent')
    const dialog = within(await screen.findByRole('dialog', { name: 'Which jar does this come from?' }, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Unallocated' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-rent', paidFromJarId: null }),
    )
  })

  it('assigns a jar line, or a line from a jar-less account, without prompting', { timeout: 15000 }, async () => {
    mockLoad([tx(), tx({ id: 't2', payee: 'Cafe', accountId: 'a1', accountName: 'Everyday' })])
    mockPut.mockImplementation((url: string, body: { budgetItemId: string }) =>
      Promise.resolve({ data: tx({ id: url.split('/')[2], budgetItemId: body.budgetItemId, budgetItemName: 'x' }) }),
    )
    const user = userEvent.setup()
    renderPage()

    // The Holiday line is the Holiday jar's own line: the payment draws from that jar.
    await user.click(await screen.findByLabelText('Assign Tesco', {}, { timeout: 5000 }))
    await user.selectOptions(screen.getByLabelText('Assign Tesco'), 'i-holiday')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t1/assignment', { budgetItemId: 'i-holiday' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Everyday backs no jars: an ordinary line never asks either.
    await user.click(screen.getByLabelText('Assign Cafe'))
    await user.selectOptions(screen.getByLabelText('Assign Cafe'), 'i-rent')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/transactions/t2/assignment', { budgetItemId: 'i-rent' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Rule 74 — the server's refusal is shown word for word, not as a generic failure.
  it('shows a below-zero refusal verbatim', { timeout: 15000 }, async () => {
    mockLoad([])
    const message =
      'Savings would be -50.00 EUR on 2026-09-10. An account never goes below zero here: record the money that reached it first, or correct this amount.'
    mockPost.mockRejectedValue({ response: { status: 400, data: { errors: { Amount: [message] } } } })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openAddModal(user)
    await user.type(screen.getByLabelText('Transaction amount'), '550')
    await user.selectOptions(await screen.findByLabelText('Transaction account', {}, { timeout: 5000 }), 'a2')
    await user.click(dialog.getByRole('button', { name: 'Add transaction' }))

    expect(await screen.findByText(message, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Could not add that transaction.')).not.toBeInTheDocument()
  })

  // Rule 78 on a transfer receipt confirmed from the register (rule 71's in-transit row).
  it('asks how a confirmed receipt into a jar-backed account is divided and posts jarAllocations', { timeout: 15000 }, async () => {
    const inTransit = tx({
      id: 't-in', payee: 'Stash', type: 2, amount: 150, accountId: 'a1', accountName: 'Everyday',
      transferAccountId: 'a2', transferAccountName: 'Savings', transferStatus: 'InTransit', departedOn: '2026-09-30', receivedOn: null,
    })
    mockLoad([inTransit])
    mockPut.mockResolvedValue({ data: { ...inTransit, transferStatus: 'Completed', receivedOn: '2026-09-30' } })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Confirm receipt: Stash' }, { timeout: 5000 }))
    expect(await screen.findByTestId('receipt-t-in-jar-allocation')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount for Holiday'), '100')
    await user.click(screen.getByRole('button', { name: 'Save transfer leg' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t-in/transfer-legs', {
        receivedOn: '2026-09-30',
        jarAllocations: [{ jarId: 'j-hol', amount: 100 }],
      }),
    )
    await waitFor(() => expect(screen.queryByText('In transit')).not.toBeInTheDocument())
  })

  // P3-10 on the leg path (#282 review P2-1): a receipt still pledged to a jar archived while the
  // money was in transit is refused with the restore hint, whether or not another jar is live (with
  // none live, no answer would be sent and the server would keep the pledge).
  it.each([
    ['another jar still live', false],
    ['every jar archived', true],
  ])('refuses to confirm a receipt pledged to an archived jar (%s)', { timeout: 15000 }, async (_case, allArchived) => {
    const inTransit = tx({
      id: 't-in', payee: 'Stash', type: 2, amount: 150, accountId: 'a1', accountName: 'Everyday',
      transferAccountId: 'a2', transferAccountName: 'Savings', transferStatus: 'InTransit', departedOn: '2026-09-30', receivedOn: null,
      jarAllocations: [
        { accountId: 'a2', jarId: 'j-old', jarName: 'Old boat', amount: 100 },
        { accountId: 'a2', jarId: null, jarName: null, amount: 50 },
      ],
    })
    const data = ledgers()
    if (allArchived) data[0].jars = data[0].jars.map((j) => ({ ...j, isArchived: true, balance: 0 }))
    mockLoad([inTransit], data)
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Confirm receipt: Stash' }, { timeout: 5000 }))
    await user.click(await screen.findByRole('button', { name: 'Save transfer leg' }))

    expect(
      await screen.findByText('This entry moved money in or out of Old boat, which is archived. Restore Old boat on the Jars page to change this entry.'),
    ).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('lets a departure from a jar-backed account name the jar it left', { timeout: 15000 }, async () => {
    const pending = tx({
      id: 't-pend', payee: 'To Everyday', type: 2, amount: 40, accountId: 'a2', accountName: 'Savings',
      transferAccountId: 'a1', transferAccountName: 'Everyday', transferStatus: 'PendingReview', departedOn: null, receivedOn: '2026-10-01',
    })
    mockLoad([pending])
    mockPut.mockResolvedValue({ data: { ...pending, transferStatus: 'Completed', departedOn: '2026-10-01' } })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add departure date: To Everyday' }, { timeout: 5000 }))
    await user.selectOptions(await screen.findByLabelText('From jar'), 'j-car')
    await user.click(screen.getByRole('button', { name: 'Save transfer leg' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t-pend/transfer-legs', { departedOn: '2026-10-01', fromJarId: 'j-car' }),
    )
  })

  // Rule 80 / 78 in the transfer form.
  it('a transfer names the jar it leaves and, once dated as received, how the receipt is divided', { timeout: 15000 }, async () => {
    mockLoad([])
    mockPost.mockResolvedValue({ data: tx({ payee: 'Top up', type: 2, amount: 50, accountId: 'a2', transferAccountId: 'a1', transferAccountName: 'Everyday' }) })
    const user = userEvent.setup()
    renderPage()

    await openAddModal(user)
    await user.click(await screen.findByRole('button', { name: 'Transfer' }, { timeout: 5000 }))
    await user.type(screen.getByLabelText('Transfer amount'), '50')
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a1')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a2')
    // Everyday backs no jars: no "From jar". Savings does: its jars can be answered while the
    // money is in transit, for the day it arrives.
    expect(screen.queryByLabelText('From jar')).not.toBeInTheDocument()
    expect(await screen.findByTestId('transfer-jar-allocation')).toBeInTheDocument()
    expect(screen.getByText(/the jars get their amounts on the day it reaches Savings/)).toBeInTheDocument()
    // The departure date defaults to today (UTC), so the receipt date is today too, whatever day the suite runs.
    const receivedOn = new Date().toISOString().slice(0, 10)
    await user.type(screen.getByLabelText('Transfer receipt date'), receivedOn)
    expect(screen.queryByText(/the jars get their amounts on the day it reaches/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount for Car'), '50')

    // Swap the direction: the money now leaves Savings, so it may name the jar it comes from.
    await user.selectOptions(screen.getByLabelText('Transfer from account'), 'a2')
    await user.selectOptions(screen.getByLabelText('Transfer to account'), 'a1')
    expect(screen.queryByTestId('transfer-jar-allocation')).not.toBeInTheDocument()
    await user.selectOptions(await screen.findByLabelText('From jar'), 'j-hol')
    await user.click(screen.getByLabelText('Transfer completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Record transfer' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/transactions/transfer',
        expect.objectContaining({ fromAccountId: 'a2', toAccountId: 'a1', receivedOn, fromJarId: 'j-hol' }),
      ),
    )
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('jarAllocations')
  })

  // W07: editing a transfer re-answers its jar questions, pre-filled from the stored split.
  it('pre-fills a transfer edit with its stored jar answers and sends them back', { timeout: 15000 }, async () => {
    const back = tx({
      id: 't-back', payee: 'Back to savings', type: 2, amount: 80, accountId: 'a1', accountName: 'Everyday',
      transferAccountId: 'a2', transferAccountName: 'Savings', transferStatus: 'Completed',
      departedOn: '2026-09-10', receivedOn: '2026-09-11',
      jarAllocations: [{ accountId: 'a2', jarId: 'j-car', jarName: 'Car', amount: 30 }],
    })
    const out = tx({
      id: 't-out', payee: 'Out of savings', type: 2, amount: 40, accountId: 'a2', accountName: 'Savings',
      transferAccountId: 'a1', transferAccountName: 'Everyday', transferStatus: 'InTransit',
      departedOn: '2026-09-12', receivedOn: null,
      jarAllocations: [{ accountId: 'a2', jarId: 'j-hol', jarName: 'Holiday', amount: -40 }],
    })
    mockLoad([back, out])
    mockPut.mockImplementation((url: string) => Promise.resolve({ data: url.includes('t-back') ? back : out }))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Edit transfer: Back to savings', {}, { timeout: 5000 }))
    expect(await screen.findByLabelText('Amount for Car')).toHaveValue('30')
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-back/transfer',
        expect.objectContaining({ fromJarId: null, jarAllocations: [{ jarId: 'j-car', amount: 30 }] }),
      ),
    )

    await user.click(await screen.findByLabelText('Edit transfer: Out of savings', {}, { timeout: 5000 }))
    expect(await screen.findByLabelText('From jar')).toHaveValue('j-hol')
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-out/transfer',
        expect.objectContaining({ fromJarId: 'j-hol', jarAllocations: null }),
      ),
    )
  })

  // W07 P2-7: until the ledgers are known (loading, or the read failed) the form can't show the
  // jar questions, so an edit sends the stored answers back rather than resetting them.
  it('a transfer edit keeps its stored jar answers when the jar ledgers could not be read', { timeout: 15000 }, async () => {
    const out = tx({
      id: 't-out', payee: 'Out of savings', type: 2, amount: 100, accountId: 'a2', accountName: 'Savings',
      transferAccountId: 'a1', transferAccountName: 'Everyday', transferStatus: 'InTransit',
      departedOn: '2026-09-12', receivedOn: null, fee: 2, feeBudgetItemId: 'i-rent', feeBudgetItemName: 'Rent',
      jarAllocations: [{ accountId: 'a2', jarId: 'j-hol', jarName: 'Holiday', amount: -100 }],
    })
    const back = tx({
      id: 't-back', payee: 'Back to savings', type: 2, amount: 80, accountId: 'a1', accountName: 'Everyday',
      transferAccountId: 'a2', transferAccountName: 'Savings', transferStatus: 'Completed',
      departedOn: '2026-09-10', receivedOn: '2026-09-11',
      jarAllocations: [{ accountId: 'a2', jarId: 'j-car', jarName: 'Car', amount: 30 }],
    })
    mockLoad([out, back], null)
    mockPut.mockImplementation((url: string) => Promise.resolve({ data: url.includes('t-back') ? back : out }))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Edit transfer: Out of savings', {}, { timeout: 5000 }))
    expect(screen.queryByLabelText('From jar')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-out/transfer',
        expect.objectContaining({ fromJarId: 'j-hol', jarAllocations: null, fee: 2, feeBudgetItemId: 'i-rent', payee: 'Out of savings' }),
      ),
    )

    await user.click(await screen.findByLabelText('Edit transfer: Back to savings', {}, { timeout: 5000 }))
    expect(screen.queryByLabelText('Amount for Car')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save transfer' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-back/transfer',
        expect.objectContaining({ fromJarId: null, jarAllocations: [{ jarId: 'j-car', amount: 30 }] }),
      ),
    )
  })

  it('labels a stored jar split on the register row', { timeout: 15000 }, async () => {
    mockLoad([
      tx({
        id: 't-sal', payee: 'Salary', type: 1, amount: 500,
        jarAllocations: [
          { accountId: 'a2', jarId: 'j-hol', jarName: 'Holiday', amount: 300 },
          { accountId: 'a2', jarId: null, jarName: null, amount: 200 },
        ],
      }),
      tx({
        id: 't-tyres', payee: 'Tyres', amount: 80, budgetItemId: 'i-rent', budgetItemName: 'Rent',
        jarAllocations: [{ accountId: 'a2', jarId: 'j-car', jarName: 'Car', amount: -80 }],
      }),
      tx({ id: 't-plain', payee: 'Plain' }),
    ])
    renderPage()

    expect(await screen.findByText('→ Holiday 300.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('from Car')).toBeInTheDocument()
    expect(screen.queryByText(/^from /)).not.toHaveTextContent('Plain')
  })

  it('pre-fills the edit form from the stored split and re-sends the answer', { timeout: 15000 }, async () => {
    const salary = tx({
      id: 't-sal', payee: 'Salary', type: 1, amount: 500,
      jarAllocations: [
        { accountId: 'a2', jarId: 'j-hol', jarName: 'Holiday', amount: 300 },
        { accountId: 'a2', jarId: null, jarName: null, amount: 200 },
      ],
    })
    mockLoad([salary])
    mockPut.mockResolvedValue({ data: salary })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Edit transaction: Salary', {}, { timeout: 5000 }))
    const holiday = screen.getByLabelText('Amount for Holiday')
    expect(holiday).toHaveValue('300')
    expect(screen.getByLabelText('Amount for Car')).toHaveValue('')
    await user.type(screen.getByLabelText('Amount for Car'), '100')
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/transactions/t-sal',
        expect.objectContaining({
          type: 1,
          accountId: 'a2',
          jarAllocations: [
            { jarId: 'j-hol', amount: 300 },
            { jarId: 'j-car', amount: 100 },
          ],
        }),
      ),
    )
  })

  it('pre-fills the paid-from jar when editing a payment and sends it back', { timeout: 15000 }, async () => {
    const tyres = tx({
      id: 't-tyres', payee: 'Tyres', amount: 80, budgetItemId: 'i-rent', budgetItemName: 'Rent',
      jarAllocations: [{ accountId: 'a2', jarId: 'j-car', jarName: 'Car', amount: -80 }],
    })
    mockLoad([tyres])
    mockPut.mockResolvedValue({ data: tyres })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Edit transaction: Tyres', {}, { timeout: 5000 }))
    const select = screen.getByLabelText('From jar')
    expect(select).toHaveValue('j-car')
    await user.selectOptions(select, 'j-hol')
    await user.click(screen.getByLabelText('Save transaction'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t-tyres', expect.objectContaining({ paidFromJarId: 'j-hol' })),
    )
  })

  it('splitting a payment across a jar line and an ordinary line asks one paid-from jar', { timeout: 15000 }, async () => {
    mockLoad([tx({ amount: 100 })])
    mockPut.mockResolvedValue({ data: tx({ amount: 100, isSplit: true, splits: [] }) })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByLabelText('Split transaction: Tesco', {}, { timeout: 5000 }))
    // Only jar lines so far: nothing to ask.
    await user.selectOptions(screen.getByLabelText('Split line 1 category'), 'i-holiday')
    await user.type(screen.getByLabelText('Split line 1 amount'), '70')
    expect(screen.queryByLabelText('From jar')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Split line 2 category'), 'i-rent')
    await user.type(screen.getByLabelText('Split line 2 amount'), '30')
    await user.selectOptions(await screen.findByLabelText('From jar'), 'j-car')
    await user.click(screen.getByLabelText('Save split'))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/transactions/t1/splits', {
        allocations: [
          { budgetItemId: 'i-holiday', amount: 70, memberId: null },
          { budgetItemId: 'i-rent', amount: 30, memberId: null },
        ],
        paidFromJarId: 'j-car',
      }),
    )
  })
})
