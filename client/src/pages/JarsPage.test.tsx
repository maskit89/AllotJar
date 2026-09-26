import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'

const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { JarsPage } from './JarsPage'
import { AuthProvider } from '../auth/AuthContext'

function fund(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    coverStart: null,
    coverEnd: null,
    accrual: 0,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-09-26',
    isArchived: false,
    currentBalance: 120,
    requiredMonthlyContribution: 25,
    projectedFullyFundedDate: '2026-11-01',
    status: 'OnTrack',
    ...over,
  }
}

// Account names deliberately don't collide with fund names so the funding-account
// <option>s don't create duplicate text matches.
const accountsData: AccountDto[] = [
  { id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
]

let fundsData: JarDto[] = []
let ledgerData: JarAccountLedgerDto[] = []

function ledger(over: Partial<JarAccountLedgerDto> = {}): JarAccountLedgerDto {
  return {
    accountId: 'acc1',
    accountName: 'Joint Current',
    currency: 'EUR',
    asOf: '2026-09-26',
    accountBalance: 1000,
    unallocated: 600,
    positiveAllocations: 400,
    hasBackingDeficit: false,
    unreconciledAllocations: 0,
    requiresReview: false,
    jars: [{ jarId: 'f1', name: 'Home insurance', balance: 400, isArchived: false }],
    ...over,
  }
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

describe('JarsPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    fundsData = []
    ledgerData = []
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accountsData })
      if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: ledgerData })
      if (url === '/jars') return Promise.resolve({ data: fundsData })
      return Promise.resolve({ data: {} })
    })
  })

  it('lists funds as jars with their balances and funded percentage', { timeout: 15000 }, async () => {
    fundsData = [
      fund(),
      fund({ id: 'f2', name: 'Holiday', kind: 0, targetAmount: 1000, currentBalance: -40, requiredMonthlyContribution: 0, status: 'Overspent', targetDate: null, projectedFullyFundedDate: null }),
    ]

    renderPage()

    expect(await screen.findByText('Home insurance', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Holiday')).toBeInTheDocument()
    // Each jar shows its balance and a funded-percentage pill (120 of 300 = 40%).
    expect(screen.getByText(/120.00/)).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('shows a status chip and the projected finish on the cards', { timeout: 15000 }, async () => {
    fundsData = [
      fund({ requiredMonthlyContribution: 25, status: 'OnTrack', projectedFullyFundedDate: '2026-11-01' }),
      fund({ id: 'f2', name: 'Roof', status: 'Behind', targetDate: '2026-01-01' }),
      fund({ id: 'f3', name: 'Sofa', status: 'FullyFunded', currentBalance: 300, requiredMonthlyContribution: 0 }),
    ]

    renderPage()

    // OnTrack jar: no chip, but the pace line carries the projection.
    expect((await screen.findAllByText(/full by Nov 2026/, {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    // Attention + celebration states surface as chips.
    expect(screen.getByText('Behind')).toBeInTheDocument()
    expect(screen.getByText('Funded')).toBeInTheDocument()
    // A €0/mo funded jar reads "Fully funded", not a bare dash.
    expect(screen.getByText('Fully funded')).toBeInTheDocument()
  })

  it('adds a fund from the New jar modal', { timeout: 15000 }, async () => {
    fundsData = []
    mockPost.mockResolvedValue({ data: fund({ id: 'f9', name: 'Vacation', kind: 0, targetAmount: 1200, status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Vacation')
    await user.type(dialog.getByLabelText('Target amount'), '1200')
    // A recurring jar needs its next due date before it can be added.
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2027-06-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/jars',
        expect.objectContaining({
          name: 'Vacation',
          targetAmount: 1200,
          kind: 0,
          accrual: 1,
          targetDate: '2027-06-01',
          recurMonths: 12,
        }),
      ),
    )
    expect(await screen.findByText('Vacation', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('offers Recurring/Goal as the jar Type and drops the renews checkbox', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const type = dialog.getByLabelText('Jar type')
    expect(within(type).getByRole('option', { name: 'Recurring' })).toBeInTheDocument()
    expect(within(type).getByRole('option', { name: 'Goal' })).toBeInTheDocument()
    // The renewal bit is now derived from Type, so the standalone checkbox is gone —
    // and so is the Accrual dropdown (new jars save by target date).
    expect(dialog.queryByLabelText('Renews each year')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Accrual method')).not.toBeInTheDocument()

    // Recurring shows Next due + Repeats; Goal swaps to an optional target date.
    expect(dialog.getByLabelText('Next due date')).toBeInTheDocument()
    expect(dialog.getByLabelText('Repeat cycle')).toBeInTheDocument()
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1')
    expect(dialog.queryByLabelText('Repeat cycle')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Target date')).toBeInTheDocument()
  })

  it('previews the monthly set-aside as you type', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    await user.type(dialog.getByLabelText('Target amount'), '1200')
    // No date yet: the remainder spreads over 12 months -> 100.00/mo.
    expect(dialog.getByText(/100\.00/)).toBeInTheDocument()
    expect(dialog.getByText(/remainder spreads over 12 months/)).toBeInTheDocument()
  })

  it('blocks a recurring jar without a due date, client-side', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Road tax')
    await user.type(dialog.getByLabelText('Target amount'), '150')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Give the recurring jar its next due date.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('lets a legacy date-less recurring jar be edited without inventing a date', { timeout: 15000 }, async () => {
    // Imported/legacy recurring jars can lack a date/target; the create-only guard
    // must not block a plain rename on edit (would 400 the server too, pre-fix).
    fundsData = [fund({ kind: 0, targetDate: null, targetAmount: 0, recurMonths: 12 })]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.clear(dialog.getByLabelText('Jar name'))
    await user.type(dialog.getByLabelText('Jar name'), 'Living Costs')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ name: 'Living Costs' })))
    expect(dialog.queryByText(/needs its next due date/)).not.toBeInTheDocument()
  })

  it('echoes the stored cover window and account when editing', { timeout: 15000 }, async () => {
    // The form doesn't surface the cover window; an unrelated edit must not wipe it.
    fundsData = [
      fund({ coverStart: '2026-01-01', coverEnd: '2026-12-31' }),
    ]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/jars/f1',
        expect.objectContaining({
          coverStart: '2026-01-01',
          coverEnd: '2026-12-31',
          fundingAccountId: 'acc1',
        }),
      ),
    )
  })

  it('offers "Already set aside" + "Set aside on" on create only — no allocation field on edit', { timeout: 15000 }, async () => {
    fundsData = [fund()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Already set aside')).toBeInTheDocument()
    // The date defaults to today and can't be in the future (rule 77).
    const setAsideOn = dialog.getByLabelText('Set aside on') as HTMLInputElement
    const today = new Date().toISOString().slice(0, 10)
    expect(setAsideOn.value).toBe(today)
    expect(setAsideOn.max).toBe(today)
    expect(dialog.getByText(/Divides money already in Joint Current into this jar\. It doesn.t add money\./)).toBeInTheDocument()
    expect(dialog.queryByText('Saved so far')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Opening balance')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel edit' }))

    await user.click(screen.getByLabelText('Edit Home insurance'))
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.queryByLabelText('Already set aside')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Set aside on')).not.toBeInTheDocument()
    expect(dialog.queryByText('Opening balance')).not.toBeInTheDocument()
    // The account select stays enabled on edit (the server refuses a change while the jar holds money).
    expect(dialog.getByLabelText('Funding account')).toBeEnabled()
  })

  it('sends the initial allocation and its date with the create payload (rule 77)', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: fund({ id: 'f9', name: 'Holiday', kind: 1, targetAmount: 1000, currentBalance: 400 }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '1000')
    await user.type(dialog.getByLabelText('Already set aside'), '400')
    fireEvent.change(dialog.getByLabelText('Set aside on'), { target: { value: '2026-09-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', {
        name: 'Holiday',
        kind: 1,
        targetAmount: 1000,
        targetDate: null,
        coverStart: null,
        coverEnd: null,
        accrual: 1,
        fundingAccountId: 'acc1',
        recurMonths: null,
        initialAllocation: 400,
        initialAllocationDate: '2026-09-01',
      }),
    )
    // Neither a retired opening-balance field nor its as-of date is sent any more.
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>
    expect(body).not.toHaveProperty('openingBalance')
    expect(body).not.toHaveProperty('openingAsOf')
  })

  it('requires an account: "Held in" has no "No account" option and the first account is preselected', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const held = dialog.getByLabelText('Funding account') as HTMLSelectElement
    expect(within(held).queryByRole('option', { name: 'No account' })).not.toBeInTheDocument()
    expect(within(held).getAllByRole('option').map((o) => o.textContent)).toEqual(['Joint Current'])
    expect(held.value).toBe('acc1')
  })

  it('shows "Not available" with an Unavailable chip when the jar\'s balance is null, and the account it is held in', { timeout: 15000 }, async () => {
    fundsData = [fund({ currentBalance: null, requiredMonthlyContribution: 0, projectedFullyFundedDate: null, status: 'Unavailable' })]

    renderPage()

    expect(await screen.findByText('Not available', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('Held in Joint Current')).toBeInTheDocument()
    // Never counted as zero: no % pill, and the hero footnote says one jar is left out.
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.getByText(/1 jar with an unavailable balance is not counted/)).toBeInTheDocument()
  })

  it('summarises each jar-backed account\'s unallocated money and flags a backing deficit (rule 70)', { timeout: 15000 }, async () => {
    fundsData = [fund()]
    ledgerData = [
      ledger(),
      ledger({ accountId: 'acc2', accountName: 'Rainy Day', accountBalance: 350, unallocated: 0, positiveAllocations: 400, hasBackingDeficit: true, jars: [{ jarId: 'f2', name: 'Repairs', balance: 400, isArchived: false }] }),
    ]

    renderPage()

    const summary = within(await screen.findByRole('region', { name: 'Unallocated' }, { timeout: 5000 }))
    expect(summary.getByText('Joint Current').closest('li')!.textContent).toMatch(/600\.00 unallocated/)
    expect(summary.getByText('Jars exceed account money')).toBeInTheDocument()
    expect(summary.getByText('Rainy Day').closest('li')!.textContent).toContain('Jars exceed account money')
  })

  it('moves money from unallocated funds into the jar and refreshes the list', { timeout: 15000 }, async () => {
    fundsData = [fund({ currentBalance: 400 })]
    ledgerData = [ledger()]
    const moved = ledger({ unallocated: 500, jars: [{ jarId: 'f1', name: 'Home insurance', balance: 500, isArchived: false }] })
    mockPost.mockResolvedValue({ data: moved })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move money from Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // The ledger for this jar's account was loaded: unallocated and each jar's balance show.
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/ledger?accountId=acc1'))
    const held = await dialog.findByLabelText('Money held in Joint Current', {}, { timeout: 5000 })
    expect(within(held).getByText('Unallocated funds').parentElement!.textContent).toContain('600.00')
    expect(within(held).getByText('Home insurance').parentElement!.textContent).toContain('400.00')

    // This jar is preselected as the source; swap so money comes FROM unallocated INTO it.
    expect(dialog.getByLabelText('Move from')).toHaveValue('f1')
    await user.selectOptions(dialog.getByLabelText('Move from'), 'unallocated')
    await user.selectOptions(dialog.getByLabelText('Move to'), 'f1')
    await user.type(dialog.getByLabelText('Move amount'), '100')
    fireEvent.change(dialog.getByLabelText('Move date'), { target: { value: '2026-09-20' } })
    await user.type(dialog.getByLabelText('Move note'), 'Top up')
    fundsData = [fund({ currentBalance: 500 })]
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars/reallocations', {
        accountId: 'acc1',
        sourceJarId: null,
        destinationJarId: 'f1',
        amount: 100,
        date: '2026-09-20',
        note: 'Top up',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The list re-reads GET /jars: the card (and hero) now show the moved-in balance.
    expect((await screen.findAllByText(/500\.00/, {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText(/400\.00/)).not.toBeInTheDocument()
  })

  it('shows the server\'s message when a move is refused (rule 68)', { timeout: 15000 }, async () => {
    fundsData = [fund({ currentBalance: 100 })]
    ledgerData = [ledger()]
    mockPost.mockRejectedValue({
      response: { status: 400, data: { errors: { Amount: ['Home insurance holds 100; it cannot supply 150.'] } } },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move money from Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await dialog.findByLabelText('Move from', {}, { timeout: 5000 })
    await user.type(dialog.getByLabelText('Move amount'), '150')
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    expect(await dialog.findByText('Home insurance holds 100; it cannot supply 150.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still open for a correction
  })

  it('refuses a move whose source and destination are the same, without a request', { timeout: 15000 }, async () => {
    fundsData = [fund()]
    ledgerData = [ledger()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move money from Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await dialog.findByLabelText('Move from', {}, { timeout: 5000 })
    await user.selectOptions(dialog.getByLabelText('Move to'), 'f1')
    await user.type(dialog.getByLabelText('Move amount'), '10')
    await user.click(dialog.getByRole('button', { name: 'Confirm move' }))

    expect(await dialog.findByText(/Choose two different places/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('archives a fund from its edit modal', { timeout: 15000 }, async () => {
    fundsData = [
      fund(),
      fund({ id: 'f2', name: 'Holiday', kind: 0 }),
    ]
    mockPut.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Archiving takes two clicks: the first arms the button, the second acts.
    await user.click(dialog.getByRole('button', { name: 'Archive Home insurance' }))
    expect(mockPut).not.toHaveBeenCalled()
    await user.click(dialog.getByRole('button', { name: 'Confirm archive Home insurance' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1/archive', { archived: true }),
    )
    await waitFor(() => expect(screen.queryByText('Home insurance')).not.toBeInTheDocument())
  })

  it('shows the server\'s reason when archiving is refused while the jar holds money (rule 26)', { timeout: 15000 }, async () => {
    fundsData = [fund({ currentBalance: 350 })]
    mockPut.mockRejectedValue({
      response: { status: 400, data: { errors: { Id: ['Home insurance still holds 350. Move it to another jar or to unallocated funds before archiving.'] } } },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Archive Home insurance' }))
    await user.click(dialog.getByRole('button', { name: 'Confirm archive Home insurance' }))

    expect(await dialog.findByText(/still holds 350/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Home insurance')).toBeInTheDocument() // still listed
  })

  it('shows an empty state when there are no funds', { timeout: 15000 }, async () => {
    fundsData = []

    renderPage()

    expect(await screen.findByText(/No jars yet/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
