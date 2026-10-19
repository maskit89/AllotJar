import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JarCycleDto, JarDto, JarPaymentDto } from '../types'

// W03 — the Recurring jar's cycle lifecycle on the Jars page (rules 19–24, 57, 83): the
// Deadline missed / Funded late states and what they say (JAR-088), marking a cycle paid by
// choosing the payment (JAR-089, JAR-090), dismissing a missed deadline (JAR-091), the
// last-cycle line and its "Record the payment" action for a cycle that rolled forward unpaid (JAR-092),
// and the write gating of the new actions (JAR-093). The actions sit in each jar's ⋯ menu, whose
// note carries what the card leaves out: a missed deadline's date and the last-cycle line.
//
// Same shared api mock as the sibling *.catalog.test.tsx files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar as sharedJar } from '../test/fixtures/jars'
import { me } from '../test/fixtures/me'
import { setMoneyFormat } from '../lib/money'
import { jarAction, jarNote, menuItems } from '../test/rowMenu'

// A recurring jar (target 600 due 1 Sep, repeating yearly) whose cycle has been missed: it
// holds 450, so it is 150 short, and the whole remainder is planned now (rule 20).
const jar = (over: Partial<JarDto> = {}) =>
  sharedJar({
    name: 'Road tax',
    targetAmount: 600,
    targetDate: '2026-09-01',
    balanceAsOf: '2026-09-27',
    currentBalance: 450,
    plannedThisMonth: 150,
    remainingThisMonth: 150,
    deadline: '2026-09-01',
    fundingCompletesOn: null,
    shortfall: 150,
    status: 'DeadlineMissed',
    ...over,
  })

// The same jar once the server has moved it on to the next cycle (1 Sep 2027).
function advanced(over: Partial<JarDto> = {}): JarDto {
  return jar({
    deadline: '2027-09-01',
    plannedThisMonth: 12.5,
    remainingThisMonth: 12.5,
    fundingCompletesOn: '2027-08-31',
    shortfall: null,
    status: 'OnTrack',
    ...over,
  })
}

function cycle(over: Partial<JarCycleDto> = {}): JarCycleDto {
  return {
    id: 'c1',
    deadline: '2025-09-01',
    targetAmount: 600,
    outcome: 'Funded',
    balanceAtDeadline: 600,
    paymentTransactionId: null,
    paymentPayee: null,
    paidOn: null,
    paidAmount: null,
    paidOnTime: false,
    closedOn: '2025-09-01',
    ...over,
  }
}

function payment(over: Partial<JarPaymentDto> = {}): JarPaymentDto {
  return {
    id: 'tx1',
    date: '2026-09-03',
    payee: 'Transport Malta',
    amount: 580,
    currency: 'EUR',
    fxPending: false,
    accountId: 'acc1',
    accountName: 'Joint Current',
    budgetItemName: 'Road tax',
    fromJar: true,
    ...over,
  }
}

const JOINT = account()

let jarsData: JarDto[] = []
let paymentsData: Record<string, JarPaymentDto[]> = {}

function mockLoads(opts: { jars?: JarDto[]; meRole?: number; payments?: Record<string, JarPaymentDto[]> } = {}) {
  jarsData = opts.jars ?? []
  paymentsData = opts.payments ?? {}
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
    if (url === '/jars') return Promise.resolve({ data: jarsData })
    if (url.startsWith('/jars/f1/payments')) return Promise.resolve({ data: paymentsData[url] ?? [] })
    if (url === '/accounts') return Promise.resolve({ data: [JOINT] })
    if (url === '/auth/me') {
      return Promise.resolve({ data: opts.meRole === undefined ? {} : me({ role: opts.meRole }) })
    }
    return Promise.resolve({ data: {} })
  })
}

const renderPage = () => renderWithProviders(<JarsPage />)

describe('JarsPage — recurring cycles (W03)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    setMoneyFormat('en-GB')
  })

  it('JAR-088: a missed cycle reads "Deadline missed" with the date and shortfall, and offers Dismiss and Mark paid', async () => {
    mockLoads({ jars: [jar()] })
    const user = userEvent.setup()

    renderPage()

    // The chip says the deadline was missed, the card how much is short (in red), the ⋯'s note
    // when the deadline was: each fact once.
    const card = within(await screen.findByRole('article', { name: 'Road tax' }, { timeout: 5000 }))
    expect(card.getByText('Deadline missed')).toBeInTheDocument()
    expect(card.getByText('€150.00 short').closest('p')).toHaveClass('text-bad')
    const note = await jarNote(user, 'Road tax')
    expect(note).toContainEqual(expect.stringMatching(/^Deadline .*Sep.*2026$/))
    expect(note.join(' ')).not.toMatch(/missed|short/)
    const items = (await menuItems(user, 'Road tax: more actions')).map((i) => i.name)
    expect(items).toEqual(expect.arrayContaining(['Dismiss', 'Mark paid']))
    // Dismiss says what it dismisses, as the card's button did.
    expect(screen.getByRole('menuitem', { name: "Dismiss Road tax's missed deadline" })).toBeInTheDocument()
  })

  it('JAR-088: a cycle funded after its deadline reads "Funded late" and nothing short (rule 57)', async () => {
    mockLoads({ jars: [jar({ currentBalance: 600, plannedThisMonth: 0, remainingThisMonth: 0, shortfall: 0, status: 'FundedLate' })] })
    const user = userEvent.setup()

    renderPage()

    // The chip says it was funded after its deadline; the ⋯'s note says which deadline.
    const card = within(await screen.findByRole('article', { name: 'Road tax' }, { timeout: 5000 }))
    expect(card.getByText('Funded late')).toBeInTheDocument()
    expect(card.queryByText(/Funded after/)).not.toBeInTheDocument()
    expect(screen.queryByText(/short/)).not.toBeInTheDocument()
    expect(await jarNote(user, 'Road tax')).toContainEqual(expect.stringMatching(/^Deadline .*Sep.*2026$/))
    expect((await menuItems(user, 'Road tax: more actions')).map((i) => i.name)).toContain('Dismiss')
    expect(screen.getByRole('menuitem', { name: "Dismiss Road tax's missed deadline" })).toBeInTheDocument()
  })

  it('JAR-089: Mark paid lists the jar\'s own payments, and confirming one posts it against the open cycle', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()], payments: { '/jars/f1/payments': [payment(), payment({ id: 'tx2', date: '2026-08-30', payee: 'Insurance Co', amount: 120 })] } })
    mockPost.mockResolvedValue({ data: advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Paid', paymentTransactionId: 'tx1', paymentPayee: 'Transport Malta', paidOn: '2026-09-03', paidAmount: 580, closedOn: '2026-09-27' }) }) })
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Road tax', 'Mark paid')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByText('Mark Road tax paid')).toBeInTheDocument()
    // The question sits behind the title's (i) (restyle PR 18).
    fireEvent.focus(dialog.getByRole('button', { name: 'About marking paid' }))
    expect(within(await dialog.findByRole('tooltip')).getByText(/Which payment settled the cycle due .*Sep.*2026\?/)).toBeInTheDocument()
    // Only the jar's own payments are asked for until the user widens the list.
    expect(mockGet).toHaveBeenCalledWith('/jars/f1/payments')
    const first = await dialog.findByRole('radio', { name: /Transport Malta on .*Sep.*2026, €580\.00/ }, { timeout: 5000 })
    expect(dialog.getByRole('radio', { name: /Insurance Co on .*Aug.*2026, €120\.00/ })).toBeInTheDocument()
    // "From this jar" is a status chip in the outline tone, one per row, with the amount beside it.
    const chips = dialog.getAllByText('From this jar')
    expect(chips).toHaveLength(2)
    chips.forEach((chip) => expect(chip).toHaveAttribute('data-tone', 'line'))
    expect(dialog.getByText('€580.00')).toBeInTheDocument()
    // Nothing can be confirmed until a payment is chosen (rule 83: the user picks, never the app).
    expect(dialog.getByLabelText('Confirm Road tax paid')).toBeDisabled()

    await user.click(first)
    await user.click(dialog.getByLabelText('Confirm Road tax paid'))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/paid', { deadline: '2026-09-01', paymentTransactionId: 'tx1' }),
      { timeout: 5000 },
    )
    // The card now shows the next cycle, and its ⋯'s note how the last one ended.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    expect(screen.getByText(/^Due .*Sep.*2027 · yearly$/)).toBeInTheDocument()
    expect(await jarNote(user, 'Road tax')).toContainEqual(expect.stringMatching(/^Last cycle paid .*Sep.*2026 \(€580\.00\), late$/))
  })

  it('JAR-114: a payment still waiting for its budget-currency amount is listed but cannot be chosen', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [jar()],
      payments: { '/jars/f1/payments': [payment({ id: 'tx9', payee: 'US insurer', amount: 650, currency: 'USD', fxPending: true })] },
    })
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Road tax', 'Mark paid')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const waiting = await dialog.findByRole('radio', { name: /US insurer/ }, { timeout: 5000 })
    expect(waiting).toBeDisabled()
    expect(dialog.getByText(/Needs its amount entered on Transactions first/)).toBeInTheDocument()
    expect(dialog.getByLabelText('Confirm Road tax paid')).toBeDisabled()
  })

  it('JAR-090: "Show payments from other accounts" re-asks with all=true; a refused mark shows the server\'s message', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [jar()],
      payments: {
        '/jars/f1/payments': [],
        '/jars/f1/payments?all=true': [payment({ id: 'tx3', accountId: 'acc2', accountName: 'Cash', budgetItemName: null, fromJar: false })],
      },
    })
    mockPost.mockRejectedValue({
      response: { status: 400, data: { errors: { PaymentTransactionId: ['Choose the payment that settled the bill — money out, not income, a transfer or a refund.'] } } },
    })
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Road tax', 'Mark paid')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(await dialog.findByText(/No payments from Road tax yet\./, {}, { timeout: 5000 })).toBeInTheDocument()
    // The empty list's one line and its quiet way out, to the Transactions page.
    expect(dialog.getByRole('link', { name: 'Record the payment first' })).toHaveAttribute('href', '/transactions')
    await user.click(dialog.getByLabelText('Show payments from other accounts'))

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/f1/payments?all=true'), { timeout: 5000 })
    const other = await dialog.findByRole('radio', { name: /Transport Malta on .*Sep.*2026, €580\.00/ }, { timeout: 5000 })
    expect(dialog.queryByText('From this jar')).not.toBeInTheDocument()
    expect(dialog.getByText(/Cash/)).toBeInTheDocument()

    await user.click(other)
    await user.click(dialog.getByLabelText('Confirm Road tax paid'))

    expect(await dialog.findByText(/Choose the payment that settled the bill/, {}, { timeout: 5000 })).toBeInTheDocument()
    // The modal stays open; the jar is unchanged.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Deadline missed')).toBeInTheDocument()

    await user.click(dialog.getByLabelText('Cancel marking paid'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
  })

  it('JAR-091: Dismiss explains what happens, posts the open cycle\'s deadline, and the jar moves on to its next due date', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()] })
    mockPost.mockResolvedValue({ data: advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Missed', balanceAtDeadline: 400, closedOn: '2026-09-27' }) }) })
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Road tax', "Dismiss Road tax's missed deadline")
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    // A short title and one line naming the next cycle; the explanation behind the (i) (restyle PR 18).
    expect(dialog.getByText('Move Road tax to its next cycle')).toBeInTheDocument()
    expect(dialog.getByText(/^What it holds carries to the cycle due .*Sep.*2027; nothing is recorded as paid\.$/)).toBeInTheDocument()
    fireEvent.focus(dialog.getByRole('button', { name: 'About moving on' }))
    const hint = within(await dialog.findByRole('tooltip'))
    expect(hint.getByText(/Road tax missed its deadline on .*Sep.*2026 — €150\.00 short\./)).toBeInTheDocument()
    expect(hint.getByText(/Dismissing keeps the €450\.00 it holds for the next cycle, records nothing as paid/)).toBeInTheDocument()
    // The way out for a bill that was in fact paid: the quiet action at the footer's left, before Cancel and the one primary.
    expect(dialog.getByRole('button', { name: 'Mark the cycle paid' })).toBeInTheDocument()
    expect(dialog.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent).slice(-3)).toEqual([
      'Mark the cycle paid',
      'Keep the missed deadline',
      "Dismiss Road tax's missed deadline",
    ])

    // Cancel leaves the notice in place.
    await user.click(dialog.getByLabelText('Keep the missed deadline'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.getByText('Deadline missed')).toBeInTheDocument()

    await jarAction(user, 'Road tax', "Dismiss Road tax's missed deadline")
    const again = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(again.getByLabelText("Dismiss Road tax's missed deadline"))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/dismiss', { deadline: '2026-09-01' }), { timeout: 5000 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    expect(screen.getByText(/^Due .*Sep.*2027 · yearly$/)).toBeInTheDocument()
    expect(await jarNote(user, 'Road tax')).toContain('Last cycle missed')
    expect((await menuItems(user, 'Road tax: more actions')).map((i) => i.name)).not.toContain('Dismiss')
  })

  it('JAR-091: the dismiss dialog hands over to Mark paid for a bill that was in fact paid', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()], payments: { '/jars/f1/payments': [payment()] } })
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Road tax', "Dismiss Road tax's missed deadline")
    const dismiss = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dismiss.getByRole('button', { name: 'Mark the cycle paid' }))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Mark Road tax paid')).toBeInTheDocument()
    expect(await dialog.findByRole('radio', { name: /Transport Malta/ }, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('JAR-092: a cycle that rolled forward funded but unpaid shows the last-cycle line with "Record the payment", which marks that cycle, not the open one', { timeout: 15000 }, async () => {
    // Healthy jar saving toward 1 Sep 2027; last September's cycle was funded on time (rule 21)
    // and rolled forward, but no payment was recorded against it.
    mockLoads({ jars: [advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Funded', closedOn: '2026-09-01' }) })], payments: { '/jars/f1/payments': [payment()] } })
    mockPost.mockResolvedValue({ data: advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Paid', paymentTransactionId: 'tx1', paymentPayee: 'Transport Malta', paidOn: '2026-09-03', paidAmount: 580, closedOn: '2026-09-01' }) }) })
    const user = userEvent.setup()

    renderPage()

    expect(await jarNote(user, 'Road tax')).toContain('Last cycle funded on time')
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    expect((await menuItems(user, 'Road tax: more actions')).map((i) => i.name)).toContain('Record the payment')
    await user.click(screen.getByRole('menuitem', { name: /^Record the payment for Road tax's cycle due .*Sep.*2026$/ }))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // The closed cycle's question sits behind the title's (i) (restyle PR 18).
    fireEvent.focus(dialog.getByRole('button', { name: 'About marking paid' }))
    const hint = within(await dialog.findByRole('tooltip'))
    expect(hint.getByText(/Which payment settled the cycle due .*Sep.*2026\?/)).toBeInTheDocument()
    expect(hint.getByText(/This only records the payment against that cycle; nothing is moved\./)).toBeInTheDocument()
    await user.click(await dialog.findByRole('radio', { name: /Transport Malta/ }, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Confirm Road tax paid'))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/paid', { deadline: '2026-09-01', paymentTransactionId: 'tx1' }),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(await jarNote(user, 'Road tax')).toContainEqual(expect.stringMatching(/^Last cycle paid .*Sep.*2026 \(€580\.00\), late$/))
    expect((await menuItems(user, 'Road tax: more actions')).map((i) => i.name)).not.toContain('Record the payment')
  })

  it('JAR-093: a Goal and an unavailable jar get no cycle actions', async () => {
    mockLoads({
      jars: [
        jar({ id: 'f2', name: 'Holiday', kind: 1, recurMonths: null, targetDate: '2027-06-01', deadline: '2027-06-01', shortfall: null, status: 'Behind' }),
        jar({ id: 'f3', name: 'Boiler', currentBalance: null, shortfall: null, plannedThisMonth: 0, remainingThisMonth: 0, status: 'Unavailable' }),
      ],
    })

    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Holiday', {}, { timeout: 5000 })).toBeInTheDocument()
    for (const name of ['Holiday', 'Boiler']) {
      const items = (await menuItems(user, `${name}: more actions`)).map((i) => i.name)
      expect(items).not.toContain('Mark paid')
      expect(items).not.toContain('Dismiss')
      expect(items).not.toContain('Record the payment')
      await user.keyboard('{Escape}')
    }
  })

  it('JAR-121: a jar due in a month names the month on the card, in Dismiss, in Mark paid and on the last-cycle line', { timeout: 15000 }, async () => {
    // Due "Sep 2026" (the 1st, given as just the month), missed and €150 short.
    mockLoads({ jars: [jar({ monthOnly: true })], payments: { '/jars/f1/payments': [payment()] } })
    const user = userEvent.setup()

    renderPage()

    expect(await jarNote(user, 'Road tax')).toContain('Deadline Sep 2026')
    expect(screen.getByText('€150.00 short')).toBeInTheDocument()
    await jarAction(user, 'Road tax', "Dismiss Road tax's missed deadline")
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('What it holds carries to the cycle due Sep 2027; nothing is recorded as paid.')).toBeInTheDocument()
    fireEvent.focus(dialog.getByRole('button', { name: 'About moving on' }))
    expect(within(await dialog.findByRole('tooltip')).getByText(/^Road tax missed its Sep 2026 deadline — €150\.00 short\./)).toBeInTheDocument()
    await user.click(dialog.getByLabelText('Keep the missed deadline'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })

    await jarAction(user, 'Road tax', 'Mark paid')
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    fireEvent.focus(dialog.getByRole('button', { name: 'About marking paid' }))
    expect(within(await dialog.findByRole('tooltip')).getByText(/Which payment settled the cycle due Sep 2026\?/)).toBeInTheDocument()
  })

  it('JAR-121: funded late and the last cycle, for a jar due in a month', async () => {
    mockLoads({
      jars: [
        jar({ monthOnly: true, currentBalance: 600, plannedThisMonth: 0, remainingThisMonth: 0, shortfall: 0, status: 'FundedLate' }),
        advanced({ id: 'f2', name: 'Licence', monthOnly: true, lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Funded', closedOn: '2026-09-01' }) }),
      ],
    })

    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Funded late', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await jarNote(user, 'Road tax')).toContain('Deadline Sep 2026')
    expect(screen.getByText('Due Sep 2027 · yearly')).toBeInTheDocument()
    expect(await jarNote(user, 'Licence')).toContain('Last cycle funded on time')
    await menuItems(user, 'Licence: more actions')
    expect(screen.getByRole('menuitem', { name: "Record the payment for Licence's cycle due Sep 2026" })).toBeInTheDocument()
  })

  it('JAR-093: a viewer sees the missed state but cannot mark paid or dismiss', async () => {
    mockLoads({ jars: [jar({ lastCycle: cycle() })], meRole: 3 })

    renderPage()

    expect(await screen.findByText('Deadline missed', {}, { timeout: 5000 })).toBeInTheDocument()
    // No ⋯ (so no Mark paid, Dismiss or Record the payment): only the (i) with the card's note.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Road tax: more actions' })).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'About Road tax' })).toBeInTheDocument()
  })
})
