import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar, ledger, schedule } from '../test/fixtures/jars'

const accountsData = [account()]

let fundsData: JarDto[] = []
let ledgerData: JarAccountLedgerDto[] = []

const renderPage = () => renderWithProviders(<JarsPage />)

describe('JarsPage', () => {
  beforeEach(() => {
    resetApiMocks()
    // The form asks the server for a schedule preview whenever a jar can be planned; answer
    // with nothing plannable unless a test cares about the preview.
    mockPost.mockResolvedValue({ data: {} })
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
      jar(),
      jar({ id: 'f2', name: 'Holiday', kind: 1, recurMonths: null, targetAmount: 1000, currentBalance: -40, plannedThisMonth: 0, remainingThisMonth: 0, status: 'Overspent', targetDate: null, deadline: null, fundingCompletesOn: null }),
    ]

    renderPage()

    expect(await screen.findByText('Home insurance', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Holiday')).toBeInTheDocument()
    // Each jar shows its balance and a funded-percentage pill (120 of 300 = 40%).
    expect(screen.getByText(/120.00/)).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('shows a status chip, this month\'s plan and the funding horizon on the cards', { timeout: 15000 }, async () => {
    fundsData = [
      // OnTrack: no chip; the month line carries plan · in · to go (rule 14) and the horizon
      // says when funding completes against the deadline it serves (rule 36).
      jar({ plannedThisMonth: 25, contributedThisMonth: 10, remainingThisMonth: 15, status: 'OnTrack' }),
      jar({ id: 'f2', name: 'Roof', kind: 1, recurMonths: null, status: 'Behind', targetDate: '2026-01-01', deadline: '2026-01-01', fundingCompletesOn: null }),
      jar({ id: 'f3', name: 'Sofa', kind: 1, recurMonths: null, status: 'FullyFunded', currentBalance: 300, plannedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null }),
      // A goal with neither a deadline nor a monthly amount plans nothing and says so (rule 17).
      jar({ id: 'f4', name: 'Someday', kind: 1, recurMonths: null, targetAmount: 0, targetDate: null, status: 'Unscheduled', plannedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null }),
    ]

    renderPage()

    expect(await screen.findByText(/Plan .*25\.00 · in .*10\.00 · to go .*15\.00/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/Funded by Nov 2026 · due .*, then it repeats/)).toBeInTheDocument()
    // Attention + celebration states surface as chips.
    expect(screen.getByText('Behind')).toBeInTheDocument()
    expect(screen.getByText(/^Due /)).toBeInTheDocument()
    expect(screen.getByText('Funded')).toBeInTheDocument()
    // A funded jar with nothing left to plan reads "Fully funded", not a bare dash.
    expect(screen.getByText('Fully funded')).toBeInTheDocument()
    expect(screen.getByText('Needs a plan')).toBeInTheDocument()
    expect(screen.getByText('Add a deadline or a monthly amount to plan contributions')).toBeInTheDocument()
  })

  // Rule 34 (P55): a jar in the user's private account first shows what sharing would expose;
  // nothing is shared until they choose "Share the account and continue".
  it('warns before a jar shares a private account, then saves with shareAccount', { timeout: 15000 }, async () => {
    const warning = "'Joint Current' is private. A jar is part of the household budget, so the account it lives in is visible to everyone."
    const jarPosts: unknown[] = []
    mockPost.mockImplementation((url: string, body: unknown) => {
      if (url !== '/jars') return Promise.resolve({ data: {} })
      jarPosts.push(body)
      return jarPosts.length === 1
        ? Promise.reject({ response: { status: 400, data: { errors: { accountPrivate: [warning] } } } })
        : Promise.resolve({ data: jar({ id: 'f9', name: 'Vacation' }) })
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Vacation')
    await user.type(dialog.getByLabelText('Target amount'), '1200')
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2027-06-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText(warning)).toBeInTheDocument()
    expect(jarPosts).toHaveLength(1)
    expect(jarPosts[0]).not.toHaveProperty('shareAccount')
    await user.click(dialog.getByRole('button', { name: 'Share the account and continue' }))

    await waitFor(() => expect(jarPosts).toHaveLength(2))
    expect(jarPosts[1]).toEqual(expect.objectContaining({ name: 'Vacation', shareAccount: true }))
  })

  // P2-2 of the #277 review: the warning names one account. Switching "Held in" to another
  // account drops it, so "Share the account and continue" can never share an account it didn't name.
  it('drops the rule 34 warning when the account changes, so it never shares another account', { timeout: 20000 }, async () => {
    const warning = "'Joint Current' is private. A jar is part of the household budget, so the account it lives in is visible to everyone."
    const other = { id: 'acc2', name: 'My Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1, isPrivate: true } as AccountDto
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [...accountsData, other] })
      if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: ledgerData })
      if (url === '/jars') return Promise.resolve({ data: fundsData })
      return Promise.resolve({ data: {} })
    })
    const jarPosts: Array<Record<string, unknown>> = []
    mockPost.mockImplementation((url: string, body: Record<string, unknown>) => {
      if (url !== '/jars') return Promise.resolve({ data: {} })
      jarPosts.push(body)
      return jarPosts.length === 1
        ? Promise.reject({ response: { status: 400, data: { errors: { accountPrivate: [warning] } } } })
        : Promise.resolve({ data: jar({ id: 'f9', name: 'Vacation', fundingAccountId: 'acc2' }) })
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Vacation')
    await user.type(dialog.getByLabelText('Target amount'), '1200')
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2027-06-01' } })
    await user.selectOptions(dialog.getByLabelText('Funding account'), 'acc1')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    expect(await dialog.findByText(warning)).toBeInTheDocument()

    await user.selectOptions(dialog.getByLabelText('Funding account'), 'acc2')
    expect(dialog.queryByText(warning)).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Share the account and continue' })).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    await waitFor(() => expect(jarPosts).toHaveLength(2))
    expect(jarPosts[1]).toEqual(expect.objectContaining({ fundingAccountId: 'acc2' }))
    expect(jarPosts[1]).not.toHaveProperty('shareAccount')
  })

  it('adds a fund from the New jar modal', { timeout: 15000 }, async () => {
    fundsData = []
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Vacation', kind: 0, targetAmount: 1200, status: 'OnTrack' }) })
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

    // Recurring shows Next due + Repeats and always saves toward its due date; Goal swaps to a
    // "How to save" choice (rule 17): by a deadline (the default) or a fixed amount each month.
    expect(dialog.getByLabelText('Next due date')).toBeInTheDocument()
    expect(dialog.getByLabelText('Repeat cycle')).toBeInTheDocument()
    expect(dialog.queryByLabelText('How to save')).not.toBeInTheDocument()
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1')
    expect(dialog.queryByLabelText('Repeat cycle')).not.toBeInTheDocument()
    const how = dialog.getByLabelText('How to save') as HTMLSelectElement
    expect(how.value).toBe('1')
    expect(within(how).getByRole('option', { name: 'By a deadline' })).toBeInTheDocument()
    expect(within(how).getByRole('option', { name: 'A fixed amount each month' })).toBeInTheDocument()
    expect(dialog.getByLabelText('Deadline')).toBeInTheDocument()
    await user.selectOptions(how, '2')
    expect(dialog.queryByLabelText('Deadline')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Monthly amount')).toBeInTheDocument()
  })

  it('previews the schedule the server plans as you type (POST /jars/schedule)', { timeout: 15000 }, async () => {
    fundsData = []
    mockPost.mockImplementation((url: string) =>
      url === '/jars/schedule' ? Promise.resolve({ data: schedule() }) : Promise.resolve({ data: {} }),
    )
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    await user.type(dialog.getByLabelText('Target amount'), '300')
    // Nothing to plan until the recurring jar has its due date (rule 17): no request, no preview.
    expect(dialog.queryByTestId('jar-schedule-preview')).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-01' } })
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    // What is previewed is what gets planned: the server's months, its funding-completion date
    // and the deadline it serves (rules 35, 36), phrased for a repeating jar.
    expect(preview).toHaveTextContent(/Sets aside .*100\.00 a month from Sep 2026 to Nov 2026, funded by .* for the deadline on .*, then it repeats every year\./)
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', {
      jarId: null,
      kind: 0,
      targetAmount: 300,
      targetDate: '2026-12-01',
      accrual: 1,
      monthlyContribution: null,
      includeDeadlineMonth: false,
      recurMonths: 12,
      initialAllocation: 0,
    })
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

  it('edits a Goal that saves a fixed amount each month: the method and amount are echoed and sent (rule 16)', { timeout: 15000 }, async () => {
    // An ongoing pot: no target, a fixed monthly amount. The form must open on that method,
    // show the amount, and send it back (with no deadline) on save.
    fundsData = [
      jar({ kind: 1, accrual: 2, targetAmount: 0, targetDate: null, recurMonths: null, monthlyContribution: 50, plannedThisMonth: 50, remainingThisMonth: 50, deadline: null, fundingCompletesOn: null, status: 'Ongoing' }),
    ]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText('Ongoing', {}, { timeout: 5000 })).toBeInTheDocument()
    await user.click(screen.getByLabelText('Edit Home insurance'))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('How to save')).toHaveValue('2')
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('50')
    expect(dialog.queryByLabelText('Deadline')).not.toBeInTheDocument()
    await user.clear(dialog.getByLabelText('Monthly amount'))
    await user.type(dialog.getByLabelText('Monthly amount'), '75')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1', {
        name: 'Home insurance',
        kind: 1,
        targetAmount: 0,
        targetDate: null,
        accrual: 2,
        monthlyContribution: 75,
        includeDeadlineMonth: false,
        fundingAccountId: 'acc1',
        recurMonths: null,
      }),
    )
  })

  it('echoes the stored deadline-month option and account when editing (rule 36)', { timeout: 15000 }, async () => {
    // The plan finishes the month before the deadline unless the jar opted into the deadline
    // month; an unrelated save must carry that choice back, not silently reset it.
    fundsData = [jar({ targetDate: '2026-12-15', deadline: '2026-12-15', includeDeadlineMonth: true, fundingCompletesOn: '2026-12-31' })]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Include the deadline month')).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        '/jars/f1',
        expect.objectContaining({
          targetDate: '2026-12-15',
          accrual: 1,
          includeDeadlineMonth: true,
          fundingAccountId: 'acc1',
        }),
      ),
    )
  })

  it('offers "Already set aside" + "Set aside on" on create only — no allocation field on edit', { timeout: 15000 }, async () => {
    fundsData = [jar()]
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
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Holiday', kind: 1, targetAmount: 1000, currentBalance: 400 }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '1000')
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-06-01' } })
    await user.type(dialog.getByLabelText('Already set aside'), '400')
    fireEvent.change(dialog.getByLabelText('Set aside on'), { target: { value: '2026-09-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', {
        name: 'Holiday',
        kind: 1,
        targetAmount: 1000,
        targetDate: '2027-06-01',
        accrual: 1,
        monthlyContribution: null,
        includeDeadlineMonth: false,
        fundingAccountId: 'acc1',
        recurMonths: null,
        initialAllocation: 400,
        initialAllocationDate: '2026-09-01',
      }),
    )
    // Neither a retired opening-balance field nor its as-of date is sent any more.
    const body = mockPost.mock.calls.find((c) => c[0] === '/jars')![1] as Record<string, unknown>
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
    fundsData = [jar({ currentBalance: null, plannedThisMonth: 0, contributedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, status: 'Unavailable' })]

    renderPage()

    expect(await screen.findByText('Not available', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('Held in Joint Current')).toBeInTheDocument()
    // Never counted as zero: no % pill, and the hero footnote says one jar is left out.
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.getByText(/1 jar with an unavailable balance is not counted/)).toBeInTheDocument()
  })

  it('summarises each jar-backed account\'s unallocated money and flags a backing deficit (rule 70)', { timeout: 15000 }, async () => {
    fundsData = [jar()]
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
    fundsData = [jar({ currentBalance: 400 })]
    ledgerData = [ledger()]
    const moved = ledger({ unallocated: 500, jars: [{ jarId: 'f1', name: 'Home insurance', balance: 500, isArchived: false }] })
    mockPost.mockResolvedValue({ data: moved })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Move money from Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Every jar-backed account's ledger was loaded (a move may cross accounts): the jar's own
    // account shows its unallocated money and each jar's balance.
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/jars/ledger'))
    const held = await dialog.findByLabelText('Money held in Joint Current', {}, { timeout: 5000 })
    expect(within(held).getByText('Unallocated funds').parentElement!.textContent).toContain('600.00')
    expect(within(held).getByText('Home insurance').parentElement!.textContent).toContain('400.00')

    // This jar is preselected as the source; swap so money comes FROM unallocated INTO it.
    expect(dialog.getByLabelText('Move from')).toHaveValue('f1')
    await user.selectOptions(dialog.getByLabelText('Move from'), 'unallocated:acc1')
    await user.selectOptions(dialog.getByLabelText('Move to'), 'f1')
    await user.type(dialog.getByLabelText('Move amount'), '100')
    fireEvent.change(dialog.getByLabelText('Move date'), { target: { value: '2026-09-20' } })
    await user.type(dialog.getByLabelText('Move note'), 'Top up')
    fundsData = [jar({ currentBalance: 500 })]
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
    fundsData = [jar({ currentBalance: 100 })]
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
    fundsData = [jar()]
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
      jar(),
      jar({ id: 'f2', name: 'Holiday', kind: 0 }),
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
    fundsData = [jar({ currentBalance: 350 })]
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
