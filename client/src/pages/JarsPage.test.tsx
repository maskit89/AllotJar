import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar, ledger, schedule, scheduleMonth } from '../test/fixtures/jars'
import { jarAction, jarNote } from '../test/rowMenu'

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
    // Each jar shows its balance, and its glass jar fills to the funded percentage (120 of 300 = 40%).
    expect(screen.getByText('€120.00')).toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: 'Home insurance funding progress' })
    expect(progress).toHaveAttribute('aria-valuenow', '40')
    expect(progress).toHaveAttribute('aria-valuetext', '40% funded')
  })

  it('shows a status chip, this month\'s plan and the funding horizon on the cards', { timeout: 15000 }, async () => {
    fundsData = [
      // OnTrack: no chip; the month line carries plan · in · to go (rule 14) and the horizon
      // says when funding completes against the deadline it serves (rule 36).
      jar({ plannedThisMonth: 25, contributedThisMonth: 10, remainingThisMonth: 15, status: 'OnTrack' }),
      jar({ id: 'f2', name: 'Roof', kind: 1, recurMonths: null, status: 'Behind', targetDate: '2026-01-01', deadline: '2026-01-01', fundingCompletesOn: null }),
      jar({ id: 'f3', name: 'Sofa', kind: 1, recurMonths: null, status: 'FullyFunded', currentBalance: 300, plannedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null }),
      // A target-less goal with neither a deadline nor a monthly amount plans nothing and says
      // what would plan it: a date alone can't, so it is asked for a target too (rule 17).
      jar({ id: 'f4', name: 'Someday', kind: 1, recurMonths: null, targetAmount: 0, targetDate: null, status: 'Unscheduled', plannedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null }),
    ]

    const user = userEvent.setup()
    renderPage()

    // The card's one line is the horizon; the month's plan sits in the ⋯'s note.
    expect(await screen.findByText(/^Due .* · yearly$/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await jarNote(user, 'Home insurance')).toContainEqual(expect.stringMatching(/^Plan .*25\.00 · in .*10\.00 · to go .*15\.00$/))
    // Attention + celebration states surface as chips.
    expect(screen.getByText('Behind')).toBeInTheDocument()
    expect(screen.getByText(/^Needed by /)).toBeInTheDocument()
    // A funded jar with nothing left to plan reads "Funded" (its chip), not a bare dash; its ⋯'s
    // note doesn't say it again.
    expect(within(screen.getByRole('article', { name: 'Sofa' })).getByText('Funded')).toBeInTheDocument()
    const sofaNote = await jarNote(user, 'Sofa')
    expect(sofaNote).not.toContainEqual(expect.stringMatching(/funded|Nothing to set aside/i))
    // A jar with no usable plan: the chip on the card, what would plan it in the ⋯'s note.
    expect(within(screen.getByRole('article', { name: 'Someday' })).getByText('Needs a plan')).toBeInTheDocument()
    expect(screen.queryByText('Give it a target and a date, or a monthly amount')).not.toBeInTheDocument()
    expect(await jarNote(user, 'Someday')).toContain('Give it a target and a date, or a monthly amount')
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
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-06-01' } })
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
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-06-01' } })
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
    // A jar that repeats (a Recurring jar) needs its next due date before it can be added.
    await user.selectOptions(dialog.getByLabelText('Repeats'), '12')
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

  it('asks no Type: Repeats (default "Doesn’t repeat") and the fixed-monthly switch decide the kind; no renews checkbox, no Accrual/How-to-save dropdown', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    // No Type to pick: the kind follows from whether the jar repeats and how it saves.
    expect(dialog.queryByLabelText('Jar type')).not.toBeInTheDocument()
    // The name's example is a one-off, like the default answer below (a yearly bill would mislead).
    expect(dialog.getByLabelText('Jar name')).toHaveAttribute('placeholder', 'e.g. New sofa')
    // The renewal bit and the saving method are derived from those answers too, so the
    // standalone checkbox and the Accrual / "How to save" dropdowns are gone.
    expect(dialog.queryByLabelText('Renews each year')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Accrual method')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('How to save')).not.toBeInTheDocument()

    // A new jar doesn't repeat (a Goal): the date is the one the money is needed by.
    const repeats = dialog.getByLabelText('Repeats') as HTMLSelectElement
    expect(repeats.value).toBe('0')
    expect(repeats.selectedOptions[0].textContent).toBe('Doesn’t repeat')
    expect(within(repeats).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Doesn’t repeat',
      'Monthly',
      'Every 3 months',
      'Every 6 months',
      'Yearly',
    ])
    expect(dialog.getByRole('button', { name: 'What repeating means' })).toBeInTheDocument()
    expect(dialog.getByLabelText('Needed by')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Next due date')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Deadline')).not.toBeInTheDocument()

    // Picking a cadence makes it a Recurring jar: the same date becomes its next due date.
    await user.selectOptions(repeats, 'Yearly')
    expect(dialog.getByLabelText('Next due date')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Needed by')).not.toBeInTheDocument()

    // The fixed-monthly switch (rule 17) swaps the date for a monthly amount and hides Repeats.
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    expect(dialog.queryByLabelText('Next due date')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Needed by')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Repeats')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Monthly amount')).toBeInTheDocument()
    expect(dialog.getByText('Target (optional)')).toBeInTheDocument()
  })

  it('keeps the cadence while the fixed-monthly switch hides it (JAR-019)', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.selectOptions(dialog.getByLabelText('Repeats'), '6') // Every 6 months
    expect(dialog.getByLabelText('Next due date')).toBeInTheDocument()

    // The switch swaps the date for "Each month" and hides Repeats (JAR-019)…
    const fixed = dialog.getByLabelText('Set aside a fixed amount each month')
    // Its words on screen are few; what it is for sits behind its info button.
    expect(dialog.getByText('Fixed amount each month')).toBeInTheDocument()
    fireEvent.focus(dialog.getByRole('button', { name: 'What a fixed amount means' }))
    expect((await dialog.findByRole('tooltip', {}, { timeout: 5000 })).textContent).toMatch(
      /No date in mind\? Set aside the same amount every month, for a pot you keep topping up \(an emergency fund\)\. The target is optional\./,
    )
    await user.click(fixed)
    expect(dialog.queryByLabelText('Repeats')).not.toBeInTheDocument()
    // A new jar has nothing repeating yet to stop, so the switch adds no warning.
    expect(dialog.queryByText(/It will stop repeating/)).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Next due date')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Monthly amount')).toBeInTheDocument()

    // …and choosing a date again brings both back with the cadence chosen, not reset to "Doesn’t repeat".
    await user.click(dialog.getByLabelText('Save by a date'))
    const repeats = dialog.getByLabelText('Repeats') as HTMLSelectElement
    expect(repeats.value).toBe('6')
    expect(repeats.selectedOptions[0].textContent).toBe('Every 6 months')
    expect(dialog.getByLabelText('Next due date')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Needed by')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Monthly amount')).not.toBeInTheDocument()
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

    // A jar that repeats yearly (a Recurring jar).
    await user.selectOptions(dialog.getByLabelText('Repeats'), '12')
    await user.type(dialog.getByLabelText('Target amount'), '300')
    // Nothing to plan until the recurring jar has its due date (rule 17): no request, no preview.
    expect(dialog.queryByTestId('jar-schedule-preview')).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-01' } })
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    // What is previewed is what gets planned: the server's monthly amount and the months it runs,
    // the last one being when funding completes (rules 35, 36). The fields above say the rest.
    expect(preview).toHaveTextContent(/^.100\.00 a month · Sep 2026 – Nov 2026$/)
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

  it('switching to a fixed amount carries the planned monthly amount over, and back keeps the date', { timeout: 15000 }, async () => {
    fundsData = []
    mockPost.mockImplementation((url: string) =>
      url === '/jars/schedule' ? Promise.resolve({ data: schedule() }) : Promise.resolve({ data: {} }),
    )
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Sofa')
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
    await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })

    // The plan's 100.00 a month fills "Each month"; the name and target stay as typed.
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('100')
    expect(dialog.getByLabelText('Jar name')).toHaveValue('Sofa')
    expect(dialog.getByLabelText('Target amount')).toHaveValue('300')

    // Back to a date: the date is still there.
    await user.click(dialog.getByLabelText('Save by a date'))
    expect(dialog.getByLabelText('Needed by')).toHaveValue('2026-12-01')
  })

  it('carries the plan rounded up to the cent, afresh on each switch, and keeps an amount typed by hand (rule 35)', { timeout: 20000 }, async () => {
    fundsData = []
    // Rule 35: 100 over three months floors to 33.33 and leaves the cent in the last month.
    mockPost.mockImplementation((url: string, body: { accrual: number; targetAmount: number }) => {
      if (url !== '/jars/schedule') return Promise.resolve({ data: {} })
      if (body.accrual !== 1) return Promise.resolve({ data: schedule({ accrual: 2, estimatedMonths: 3 }) })
      const months =
        body.targetAmount === 100
          ? [scheduleMonth(2026, 9, 33.33), scheduleMonth(2026, 10, 33.33), scheduleMonth(2026, 11, 33.34)]
          : [scheduleMonth(2026, 9, 200), scheduleMonth(2026, 10, 200), scheduleMonth(2026, 11, 200)]
      return Promise.resolve({ data: schedule({ months, total: body.targetAmount, remaining: body.targetAmount }) })
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Target amount'), '100')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent('€100.00 in total'), { timeout: 5000 })

    // 33.34 a month finishes in the same three months; 33.33 would need a fourth for a cent.
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('33.34')
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ accrual: 2, monthlyContribution: 33.34 })), { timeout: 5000 })

    // A new target by a date, then fixed again: the carried amount follows the new plan.
    await user.click(dialog.getByLabelText('Save by a date'))
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), '600')
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent('€200.00 a month'), { timeout: 5000 })
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('200')

    // An amount typed by hand stays through the same round trip.
    await user.clear(dialog.getByLabelText('Monthly amount'))
    await user.type(dialog.getByLabelText('Monthly amount'), '150')
    await user.click(dialog.getByLabelText('Save by a date'))
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), '100')
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent('€100.00 in total'), { timeout: 5000 })
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('150')
  })

  // O3b (answered 1 October 2026): the edit preview says which later months keep the amount the
  // user typed on their line, including one past the months the schedule plans.
  it('O3b: the edit preview lists the months that keep a hand-typed amount', { timeout: 15000 }, async () => {
    fundsData = [jar()]
    mockPost.mockImplementation((url: string) =>
      url === '/jars/schedule'
        ? Promise.resolve({
            data: schedule({
              months: [scheduleMonth(2026, 10, 75), scheduleMonth(2026, 11, 150, { byHand: true })],
              byHandLater: [scheduleMonth(2027, 1, 40, { byHand: true })],
            }),
          })
        : Promise.resolve({ data: {} }),
    )
    const user = userEvent.setup()

    renderPage()
    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent(/Kept as typed: Nov 2026 .*150\.00, Jan 2027 .*40\.00$/)
  })

  it('blocks a recurring jar without a due date, client-side', { timeout: 15000 }, async () => {
    fundsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Jar name'), 'Road tax')
    await user.type(dialog.getByLabelText('Target amount'), '150')
    // It repeats yearly, so it needs a next due date to roll forward from.
    await user.selectOptions(dialog.getByLabelText('Repeats'), '12')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Give the jar its next due date.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('edits a Goal that saves a fixed amount each month: the switch and amount are echoed and sent (rule 16)', { timeout: 15000 }, async () => {
    // An ongoing pot: no target, a fixed monthly amount. The form must open with the
    // fixed-monthly switch ticked, show the amount, and send it back (with no date) on save.
    fundsData = [
      jar({ kind: 1, accrual: 2, targetAmount: 0, targetDate: null, recurMonths: null, monthlyContribution: 50, plannedThisMonth: 50, remainingThisMonth: 50, deadline: null, fundingCompletesOn: null, status: 'Ongoing' }),
    ]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText('€50.00 every month', {}, { timeout: 5000 })).toBeInTheDocument()
    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Set aside a fixed amount each month')).toBeChecked()
    expect(dialog.getByLabelText('Monthly amount')).toHaveValue('50')
    expect(dialog.queryByLabelText('Needed by')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Repeats')).not.toBeInTheDocument()
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
        monthOnly: false,
        fundingAccountId: 'acc1',
        recurMonths: null,
        version: null,
      }),
    )
  })

  it('editing a Recurring jar and ticking the fixed-monthly switch changes its kind: sends kind 1, accrual 2, no cadence, no date and the monthly amount', { timeout: 15000 }, async () => {
    // A yearly jar whose open cycle (W03) is due 2027-01-01. The switch turns it into a Goal that
    // saves a set amount each month, as the old Type select could; its cadence and date go with it.
    fundsData = [jar({ kind: 0, recurMonths: 12, targetDate: '2026-01-01', deadline: '2027-01-01' })]
    mockPut.mockResolvedValue({
      data: jar({ kind: 1, accrual: 2, recurMonths: null, targetDate: null, deadline: null, monthlyContribution: 40, plannedThisMonth: 40, remainingThisMonth: 40, fundingCompletesOn: null, estimatedMonthsToTarget: 5 }),
    })
    const user = userEvent.setup()

    renderPage()

    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Repeats')).toHaveValue('12')
    expect(dialog.getByLabelText('Next due date')).toHaveValue('2027-01-01')
    expect(dialog.queryByText(/It will stop repeating/)).not.toBeInTheDocument()
    await user.click(dialog.getByLabelText('Set aside a fixed amount each month'))
    // The switch says what it does to a jar that repeats before anything is saved.
    expect(dialog.getByText('It will stop repeating.')).toBeInTheDocument()
    await user.type(dialog.getByLabelText('Monthly amount'), '40')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1', {
        name: 'Home insurance',
        kind: 1,
        targetAmount: 300,
        targetDate: null,
        accrual: 2,
        monthlyContribution: 40,
        includeDeadlineMonth: false,
        monthOnly: false,
        fundingAccountId: 'acc1',
        recurMonths: null,
        version: null,
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

    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // It lives under "More options", which starts open because the jar already uses it.
    expect(dialog.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'true')
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

  // D11: a save refused because someone else changed the jar refills the form from the latest
  // read. The other editor may have ticked the deadline-month option, which lives under "More
  // options": the refill opens the fold so the ticked box is in view rather than hidden behind it.
  it('a 409 on save refills the form from the latest jar and opens "More options" when it now includes the deadline month (D11, rule 36)', { timeout: 15000 }, async () => {
    const message = 'Someone else changed this. Reload and try again.'
    const mine = jar({ targetDate: '2026-12-15', deadline: '2026-12-15', includeDeadlineMonth: false, version: 'AAAAAAAAB9E=' })
    const theirs = jar({ targetDate: '2026-12-15', deadline: '2026-12-15', includeDeadlineMonth: true, fundingCompletesOn: '2026-12-31', version: 'AAAAAAAAB+A=' })
    fundsData = [mine]
    mockPut.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { status: 409, title: message } } }),
    )
    const user = userEvent.setup()

    renderPage()

    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // The jar doesn't use the deadline month yet, so the fold starts closed.
    expect(dialog.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'false')
    expect(dialog.queryByLabelText('Include the deadline month')).not.toBeInTheDocument()

    // Someone else saved first (their jar is what GET /jars now returns); this save is refused.
    fundsData = [theirs]
    await user.clear(dialog.getByLabelText('Jar name'))
    await user.type(dialog.getByLabelText('Jar name'), 'House insurance')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ name: 'House insurance', version: 'AAAAAAAAB9E=' })))
    expect(await dialog.findByText(message, {}, { timeout: 5000 })).toBeInTheDocument()
    // The form was refilled from the latest read, and the option they ticked is shown, not folded away.
    expect(mockGet).toHaveBeenCalledWith('/jars', { params: { includeArchived: true } })
    expect(dialog.getByLabelText('Jar name')).toHaveValue('Home insurance')
    expect(dialog.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'true')
    expect(dialog.getByLabelText('Include the deadline month')).toBeChecked()
  })

  it('offers "Already set aside" + "Set aside on" under More options on create only — no allocation field on edit', { timeout: 15000 }, async () => {
    fundsData = [jar()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Both sit under "More options" (rule 77), folded away until opened.
    expect(dialog.queryByLabelText('Already set aside')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'More options' }))
    expect(dialog.getByLabelText('Already set aside')).toBeInTheDocument()
    // The date defaults to today and can't be in the future (rule 77).
    const setAsideOn = dialog.getByLabelText('Set aside on') as HTMLInputElement
    const today = new Date().toISOString().slice(0, 10)
    expect(setAsideOn.value).toBe(today)
    expect(setAsideOn.max).toBe(today)
    // What it means sits behind the field's info button, naming the account it divides.
    fireEvent.focus(dialog.getByRole('button', { name: 'What setting money aside does' }))
    expect((await dialog.findByRole('tooltip', {}, { timeout: 5000 })).textContent).toMatch(/Divides money already in Joint Current into this jar\. It doesn.t add money\./)
    expect(dialog.queryByText('Saved so far')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Opening balance')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel edit' }))

    await jarAction(user, 'Home insurance', 'Edit')
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Nothing to fold away on this edit (the 1st-of-month date has no deadline-month option
    // either), so there is no "More options" at all.
    expect(dialog.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Already set aside')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Set aside on')).not.toBeInTheDocument()
    expect(dialog.queryByText('Opening balance')).not.toBeInTheDocument()
    // The account select stays enabled on edit (the server refuses a change while the jar holds money).
    expect(dialog.getByLabelText('Funding account')).toBeEnabled()
  })

  it('a second click on "More options" folds it away again (JAR-086)', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const more = dialog.getByRole('button', { name: 'More options' })
    expect(more).toHaveAttribute('aria-controls', 'jar-more-options')
    expect(more).toHaveAttribute('aria-expanded', 'false')

    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(dialog.getByLabelText('Already set aside')).toBeInTheDocument()
    expect(dialog.getByLabelText('Set aside on')).toBeInTheDocument()

    // The button toggles: a second click closes the fold and its fields leave the document.
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(dialog.queryByLabelText('Already set aside')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Set aside on')).not.toBeInTheDocument()
    expect(document.getElementById('jar-more-options')).toBeNull()
  })

  it('sends the initial allocation and its date with the create payload (rule 77)', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Holiday', kind: 1, targetAmount: 1000, currentBalance: 400 }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // A new jar doesn't repeat (a Goal), so there is no Type to pick: just the name, the
    // target and the date the money is needed by.
    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '1000')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-06-01' } })
    await user.click(dialog.getByRole('button', { name: 'More options' }))
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
        monthOnly: false,
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

  it('shows "Not available" when the jar\'s balance is null, and the account it is held in', { timeout: 15000 }, async () => {
    fundsData = [jar({ currentBalance: null, plannedThisMonth: 0, contributedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, status: 'Unavailable' })]
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText('Not available', {}, { timeout: 5000 })).toBeInTheDocument()
    // The amount says it, so no Unavailable chip repeats it (as on the Dashboard's jars card).
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
    // Nothing to measure against: the target is in the ⋯'s note, not "Not available of €300.00".
    expect(within(screen.getByRole('article', { name: 'Home insurance' })).queryByText(/of €/)).not.toBeInTheDocument()
    const note = await jarNote(user, 'Home insurance')
    expect(note).toContain('Held in Joint Current')
    expect(note).toContain('Target €300.00')
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

    await jarAction(user, 'Home insurance', 'Move money')
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
    await user.click(dialog.getByRole('button', { name: 'Move money' }))

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

    await jarAction(user, 'Home insurance', 'Move money')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await dialog.findByLabelText('Move from', {}, { timeout: 5000 })
    await user.type(dialog.getByLabelText('Move amount'), '150')
    await user.click(dialog.getByRole('button', { name: 'Move money' }))

    expect(await dialog.findByText('Home insurance holds 100; it cannot supply 150.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still open for a correction
  })

  it('refuses a move whose source and destination are the same, without a request', { timeout: 15000 }, async () => {
    fundsData = [jar()]
    ledgerData = [ledger()]
    const user = userEvent.setup()

    renderPage()

    await jarAction(user, 'Home insurance', 'Move money')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await dialog.findByLabelText('Move from', {}, { timeout: 5000 })
    await user.selectOptions(dialog.getByLabelText('Move to'), 'f1')
    await user.type(dialog.getByLabelText('Move amount'), '10')
    await user.click(dialog.getByRole('button', { name: 'Move money' }))

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

    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Archiving takes two clicks: the first arms the button, the second acts.
    await user.click(dialog.getByRole('button', { name: 'Archive jar' }))
    expect(mockPut).not.toHaveBeenCalled()
    await user.click(dialog.getByRole('button', { name: 'Really archive?' }))

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

    await jarAction(user, 'Home insurance', 'Edit')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Archive jar' }))
    await user.click(dialog.getByRole('button', { name: 'Really archive?' }))

    expect(await dialog.findByText(/still holds 350/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Home insurance')).toBeInTheDocument() // still listed
  })

  it('shows an empty state when there are no funds', { timeout: 15000 }, async () => {
    fundsData = []

    renderPage()

    expect(await screen.findByText(/No jars yet/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
