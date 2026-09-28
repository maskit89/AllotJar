import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarCycleDto, JarDto, JarPaymentDto } from '../types'

// W03 — the Recurring jar's cycle lifecycle on the Jars page (rules 19–24, 57, 83): the
// Deadline missed / Funded late states and what they say (JAR-088), marking a cycle paid by
// choosing the payment (JAR-089, JAR-090), dismissing a missed deadline (JAR-091), the
// last-cycle line and its "Paid it?" link for a cycle that rolled forward unpaid (JAR-092),
// and the write gating of the new actions (JAR-093).
//
// Same api-control harness as the sibling *.catalog.test.tsx files.
const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { JarsPage } from './JarsPage'
import { AuthProvider } from '../auth/AuthContext'
import { setMoneyFormat } from '../lib/money'

// A recurring jar (target 600 due 1 Sep, repeating yearly) whose cycle has been missed: it
// holds 450, so it is 150 short, and the whole remainder is planned now (rule 20).
function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Road tax',
    kind: 0,
    targetAmount: 600,
    targetDate: '2026-09-01',
    accrual: 1,
    monthlyContribution: null,
    includeDeadlineMonth: false,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-09-27',
    isArchived: false,
    currentBalance: 450,
    plannedThisMonth: 150,
    contributedThisMonth: 0,
    remainingThisMonth: 150,
    deadline: '2026-09-01',
    fundingCompletesOn: null,
    estimatedMonthsToTarget: null,
    shortfall: 150,
    lastCycle: null,
    completedOn: null,
    canDelete: false,
    skippedThisMonth: false,
    status: 'DeadlineMissed',
    ...over,
  }
}

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
    baseAmount: 580,
    fxPending: false,
    accountId: 'acc1',
    accountName: 'Joint Current',
    budgetItemName: 'Road tax',
    fromJar: true,
    ...over,
  }
}

const JOINT: AccountDto = {
  id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0,
}

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
      return Promise.resolve({
        data: opts.meRole === undefined ? {} : { userId: 'u1', email: 'alex@x.com', displayName: 'Alex', role: opts.meRole, ownerId: 'u1', memberId: null },
      })
    }
    return Promise.resolve({ data: {} })
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <JarsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('JarsPage — recurring cycles (W03)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    setMoneyFormat('en-GB')
  })

  it('JAR-088: a missed cycle reads "Deadline missed" with the date and shortfall, and offers Dismiss and Mark paid', async () => {
    mockLoads({ jars: [jar()] })

    renderPage()

    expect(await screen.findByText('Deadline missed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/^Deadline .*Sep.*2026 missed · €150\.00 short$/)).toBeInTheDocument()
    expect(screen.getByText('Mark the cycle paid, or dismiss it to save toward the next one')).toBeInTheDocument()
    expect(screen.getByLabelText("Dismiss Road tax's missed deadline")).toBeInTheDocument()
    expect(screen.getByLabelText('Mark Road tax paid')).toBeInTheDocument()
  })

  it('JAR-088: a cycle funded after its deadline reads "Funded late" and nothing short (rule 57)', async () => {
    mockLoads({ jars: [jar({ currentBalance: 600, plannedThisMonth: 0, remainingThisMonth: 0, shortfall: 0, status: 'FundedLate' })] })

    renderPage()

    expect(await screen.findByText('Funded late', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/^Funded after the deadline on .*Sep.*2026$/)).toBeInTheDocument()
    expect(screen.getByLabelText("Dismiss Road tax's missed deadline")).toBeInTheDocument()
  })

  it('JAR-089: Mark paid lists the jar\'s own payments, and confirming one posts it against the open cycle', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()], payments: { '/jars/f1/payments': [payment(), payment({ id: 'tx2', date: '2026-08-30', payee: 'Insurance Co', amount: 120 })] } })
    mockPost.mockResolvedValue({ data: advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Paid', paymentTransactionId: 'tx1', paymentPayee: 'Transport Malta', paidOn: '2026-09-03', paidAmount: 580, closedOn: '2026-09-27' }) }) })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Mark Road tax paid', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByText(/Which payment settled the cycle due .*Sep.*2026\?/)).toBeInTheDocument()
    // Only the jar's own payments are asked for until the user widens the list.
    expect(mockGet).toHaveBeenCalledWith('/jars/f1/payments')
    const first = await dialog.findByRole('radio', { name: /Transport Malta on .*Sep.*2026, €580\.00/ }, { timeout: 5000 })
    expect(dialog.getByRole('radio', { name: /Insurance Co on .*Aug.*2026, €120\.00/ })).toBeInTheDocument()
    expect(dialog.getAllByText('From this jar')).toHaveLength(2)
    // Nothing can be confirmed until a payment is chosen (rule 83: the user picks, never the app).
    expect(dialog.getByLabelText('Confirm Road tax paid')).toBeDisabled()

    await user.click(first)
    await user.click(dialog.getByLabelText('Confirm Road tax paid'))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/paid', { deadline: '2026-09-01', paymentTransactionId: 'tx1' }),
      { timeout: 5000 },
    )
    // The card now shows the next cycle and how the last one ended.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    expect(screen.getByText(/^Last cycle · due .*Sep.*2026 · paid .*Sep.*2026 \(€580\.00\), after the deadline$/)).toBeInTheDocument()
    expect(screen.getByText(/^Funded by Aug 2027 · due .*Sep.*2027, then it repeats$/)).toBeInTheDocument()
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
    await user.click(await screen.findByLabelText('Mark Road tax paid', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(await dialog.findByText(/No payments from Road tax yet\./, {}, { timeout: 5000 })).toBeInTheDocument()
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
    await user.click(await screen.findByLabelText("Dismiss Road tax's missed deadline", {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByText('Move Road tax on to its next cycle?')).toBeInTheDocument()
    expect(dialog.getByText(/Road tax missed its deadline on .*Sep.*2026 — €150\.00 short\./)).toBeInTheDocument()
    expect(dialog.getByText(/Dismissing keeps the €450\.00 it holds for the next cycle, records nothing as paid/)).toBeInTheDocument()
    // The way out for a bill that was in fact paid.
    expect(dialog.getByRole('button', { name: 'Mark the cycle paid' })).toBeInTheDocument()

    // Cancel leaves the notice in place.
    await user.click(dialog.getByLabelText('Keep the missed deadline'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.getByText('Deadline missed')).toBeInTheDocument()

    await user.click(screen.getByLabelText("Dismiss Road tax's missed deadline"))
    const again = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(again.getByLabelText("Dismiss Road tax's missed deadline"))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/dismiss', { deadline: '2026-09-01' }), { timeout: 5000 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Dismiss Road tax's missed deadline")).not.toBeInTheDocument()
    expect(screen.getByText(/^Last cycle · due .*Sep.*2026 · missed$/)).toBeInTheDocument()
    expect(screen.getByText(/^Funded by Aug 2027 · due .*Sep.*2027, then it repeats$/)).toBeInTheDocument()
  })

  it('JAR-091: the dismiss dialog hands over to Mark paid for a bill that was in fact paid', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()], payments: { '/jars/f1/payments': [payment()] } })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText("Dismiss Road tax's missed deadline", {}, { timeout: 5000 }))
    const dismiss = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dismiss.getByRole('button', { name: 'Mark the cycle paid' }))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Mark Road tax paid')).toBeInTheDocument()
    expect(await dialog.findByRole('radio', { name: /Transport Malta/ }, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('JAR-092: a cycle that rolled forward funded but unpaid shows the last-cycle line with "Paid it?", which marks that cycle, not the open one', { timeout: 15000 }, async () => {
    // Healthy jar saving toward 1 Sep 2027; last September's cycle was funded on time (rule 21)
    // and rolled forward, but no payment was recorded against it.
    mockLoads({ jars: [advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Funded', closedOn: '2026-09-01' }) })], payments: { '/jars/f1/payments': [payment()] } })
    mockPost.mockResolvedValue({ data: advanced({ lastCycle: cycle({ deadline: '2026-09-01', outcome: 'Paid', paymentTransactionId: 'tx1', paymentPayee: 'Transport Malta', paidOn: '2026-09-03', paidAmount: 580, closedOn: '2026-09-01' }) }) })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText(/^Last cycle · due .*Sep.*2026 · funded on time, payment not recorded$/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Deadline missed')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText(/^Record the payment for Road tax's cycle due .*Sep.*2026$/))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText(/Which payment settled the cycle due .*Sep.*2026\?/)).toBeInTheDocument()
    expect(dialog.getByText(/This only records the payment against that cycle; nothing is moved\./)).toBeInTheDocument()
    await user.click(await dialog.findByRole('radio', { name: /Transport Malta/ }, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Confirm Road tax paid'))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars/f1/cycles/paid', { deadline: '2026-09-01', paymentTransactionId: 'tx1' }),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText(/^Last cycle · due .*Sep.*2026 · paid .*Sep.*2026 \(€580\.00\), after the deadline$/)).toBeInTheDocument()
    expect(screen.queryByText('Paid it? Record the payment')).not.toBeInTheDocument()
  })

  it('JAR-093: a Goal, an unavailable jar and a read-only viewer get no cycle actions', async () => {
    mockLoads({
      jars: [
        jar({ id: 'f2', name: 'Holiday', kind: 1, recurMonths: null, targetDate: '2027-06-01', deadline: '2027-06-01', shortfall: null, status: 'Behind' }),
        jar({ id: 'f3', name: 'Boiler', currentBalance: null, shortfall: null, plannedThisMonth: 0, remainingThisMonth: 0, status: 'Unavailable' }),
      ],
    })

    renderPage()

    expect(await screen.findByText('Holiday', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Holiday paid')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Boiler paid')).not.toBeInTheDocument()
    expect(screen.queryByText(/Dismiss/)).not.toBeInTheDocument()
  })

  it('JAR-093: a viewer sees the missed state but cannot mark paid or dismiss', async () => {
    mockLoads({ jars: [jar({ lastCycle: cycle() })], meRole: 3 })

    renderPage()

    expect(await screen.findByText('Deadline missed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Road tax paid')).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Dismiss Road tax's missed deadline")).not.toBeInTheDocument()
    expect(screen.queryByText('Paid it? Record the payment')).not.toBeInTheDocument()
  })
})
