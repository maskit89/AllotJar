import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, JarDto, JarScheduleDto, JarScheduleMonthDto, JarScheduleRequest, MeResponse } from '../types'

// Supplements JarsPage.catalog.test.tsx (which already covers JAR-002/004/005/009/011/
// 013/015/020/021/023/024/025/027/028/031/035/037/039/041/042/043/046/049) and
// JarsPage.test.tsx (JAR-001/003/012/018/019/026/032/034/036/044). This file adds the
// remaining jsdom-observable JAR cases neither file asserts: the schedule preview's
// phrasing (JAR-016) and its hide/show gate (JAR-017), the loading state (JAR-008), the
// jar-types InfoHint copy (JAR-022), a Unicode round-trip (JAR-030) and the W02 preview
// cases: the month list with its rounding remainder (JAR-083), the over-budget warning
// (JAR-084), the ongoing / already-funded wording (JAR-085), the deadline-month option
// (JAR-086) and the long-schedule summary (JAR-087).
//
// Same shared api mock as the sibling *.catalog.test.tsx files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format (€1,234.56),
// independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

// A recurring jar saving 300 by 1 Dec, planned 25 this month.
function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    accrual: 1,
    monthlyContribution: null,
    includeDeadlineMonth: false,
    recurMonths: 12,
    fundingAccountId: 'acc1',
    balanceAsOf: '2026-09-26',
    isArchived: false,
    currentBalance: 120,
    plannedThisMonth: 25,
    contributedThisMonth: 0,
    remainingThisMonth: 25,
    deadline: '2026-12-01',
    fundingCompletesOn: '2026-11-30',
    estimatedMonthsToTarget: null,
    shortfall: null,
    lastCycle: null,
    completedOn: null,
    canDelete: false,
    skippedThisMonth: false,
    status: 'OnTrack',
    ...over,
  }
}

// The server's answer to POST /jars/schedule: the months the planner would seed.
function month(year: number, month: number, planned: number, over: Partial<JarScheduleMonthDto> = {}): JarScheduleMonthDto {
  return { year, month, planned, hasBudget: false, shortfall: null, ...over }
}

function schedule(over: Partial<JarScheduleDto> = {}): JarScheduleDto {
  return {
    accrual: 1,
    isOngoing: false,
    hasSchedule: true,
    balance: 0,
    remaining: 300,
    months: [month(2026, 9, 100), month(2026, 10, 100), month(2026, 11, 100)],
    total: 300,
    deadline: '2026-12-01',
    fundingCompletesOn: '2026-11-30',
    estimatedMonths: null,
    ...over,
  }
}

/** Answer /jars/schedule from `plan` (given the request) and every other POST with `data`. */
function mockPosts(plan: (request: JarScheduleRequest) => JarScheduleDto, data: unknown = {}) {
  mockPost.mockImplementation((url: string, body: unknown) =>
    url === '/jars/schedule' ? Promise.resolve({ data: plan(body as JarScheduleRequest) }) : Promise.resolve({ data }),
  )
}

function me(role: number): MeResponse {
  return { userId: 'u1', email: 'alex@x.com', displayName: 'Alex', role, ownerId: 'u1', memberId: null }
}

// Route the three endpoints JarsPage + AuthProvider hit on mount: /jars, /accounts and
// /auth/me. `jarsPending` leaves the /jars request unresolved (the loading-state case);
// a non-numeric /auth/me role leaves the AuthContext at its Owner default (canWrite).
// Accounts default to one account because a jar can't be created without one (rule 73).
const JOINT: AccountDto = {
  id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0,
}

function mockLoads(
  opts: { jars?: JarDto[]; accounts?: AccountDto[]; meRole?: number; jarsPending?: boolean } = {},
) {
  const { jars = [], accounts = [JOINT], meRole, jarsPending = false } = opts
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
    if (url === '/jars') return jarsPending ? new Promise<never>(() => {}) : Promise.resolve({ data: jars })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/auth/me') return Promise.resolve({ data: meRole === undefined ? {} : me(meRole) })
    return Promise.resolve({ data: {} })
  })
}

const renderPage = () => renderWithProviders(<JarsPage />)

async function openNewJar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

/** Type a recurring jar's target and due date, which is enough for the server to plan it. */
async function describeRecurring(dialog: ReturnType<typeof within>, user: ReturnType<typeof userEvent.setup>, target = '300', due = '2026-12-01') {
  await user.type(dialog.getByLabelText('Target amount'), target)
  fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: due } })
}

describe('JarsPage — catalog supplemental (JAR)', () => {
  beforeEach(() => {
    resetApiMocks()
    // The form asks the server for a schedule preview whenever a jar can be planned; answer
    // with nothing plannable unless a test cares about the preview.
    mockPost.mockResolvedValue({ data: {} })
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56
    mockLoads()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- List, hero & loading -------------------------------------------------

  it('JAR-008: shows "Loading…" over a still-rendered zeroed hero while /jars is in flight', { timeout: 15000 }, async () => {
    // /jars never resolves; Promise.all stays pending, so `loading` stays true.
    mockLoads({ jarsPending: true })

    renderPage()

    // The slate loading line shows…
    expect(await screen.findByText('Loading…', {}, { timeout: 5000 })).toBeInTheDocument()
    // …the hero still renders, zeroed, until data arrives (€0.00 / +€0.00 / 0)…
    const hero = screen.getByText('Total saved').closest('section')!
    expect(within(hero).getByLabelText('Total saved: €0.00')).toBeInTheDocument()
    expect(within(hero).getByText('This month').closest('div')!.textContent).toContain('+€0.00')
    expect(within(hero).getByText('Active jars').closest('div')!.textContent).toContain('0')
    // …and neither cards nor the empty state flash before the response resolves.
    expect(screen.queryByRole('heading', { name: 'Your jars' })).not.toBeInTheDocument()
    expect(screen.queryByText(/No jars yet/)).not.toBeInTheDocument()
  })

  // --- New jar modal: the schedule preview (POST /jars/schedule) -------------

  it('JAR-016: the preview says the plan repeats for a Recurring jar, in its cycle, and not for a Goal', { timeout: 15000 }, async () => {
    mockPosts(() => schedule())
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user) // Recurring is the default type

    await describeRecurring(dialog, user)
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent(/for the deadline on .*, then it repeats every year\./)

    // A 3-month cycle names the cycle.
    await user.selectOptions(dialog.getByLabelText('Repeat cycle'), '3')
    await waitFor(() => expect(preview).toHaveTextContent(/then it repeats every 3 months\./), { timeout: 5000 })
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 0, recurMonths: 3 })), { timeout: 5000 })

    // A Goal by a deadline: funded by … for the deadline on …, and nothing about repeating.
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1')
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2026-12-01' } })
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 1, recurMonths: null, targetDate: '2026-12-01' })), { timeout: 5000 })
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).not.toHaveTextContent(/repeats/), { timeout: 5000 })
    expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent(/Sets aside €100\.00 a month from Sep 2026 to Nov 2026, funded by .* for the deadline on .*\./)
  })

  it('JAR-017: the preview is hidden, and nothing is asked, while the target is blank, 0 or unparseable', { timeout: 15000 }, async () => {
    mockPosts(() => schedule())
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-01' } })
    const target = dialog.getByLabelText('Target amount')
    // Blank target → parses to 0 → nothing to plan.
    expect(dialog.queryByTestId('jar-schedule-preview')).not.toBeInTheDocument()
    // Explicit 0 → still nothing.
    await user.type(target, '0')
    // Unparseable → nothing.
    await user.clear(target)
    await user.type(target, 'abc')
    await new Promise((r) => setTimeout(r, 400)) // past the preview debounce
    expect(dialog.queryByTestId('jar-schedule-preview')).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
    // A positive parseable target brings the preview.
    await user.clear(target)
    await user.type(target, '300')
    expect(await dialog.findByText(/Sets aside/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ targetAmount: 300 }))
  })

  it('JAR-083: the preview lists each month\'s amount, the rounding remainder visibly in the last (rule 35)', { timeout: 15000 }, async () => {
    // 100 over three months: 33.33, 33.33 and 33.34 — never 33.33 × 3 = 99.99.
    mockPosts(() => schedule({ remaining: 100, months: [month(2026, 9, 33.33), month(2026, 10, 33.33), month(2026, 11, 33.34)], total: 100 }))
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await describeRecurring(dialog, user, '100')
    const preview = within(await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 }))
    // Uneven months are summarised by their total, then listed one by one.
    expect(preview.getByText(/Sets aside €100\.00 in total from Sep 2026 to Nov 2026/)).toBeInTheDocument()
    const rows = preview.getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toEqual(['Sep 2026€33.33', 'Oct 2026€33.33', 'Nov 2026€33.34'])
  })

  it('JAR-084: the preview flags the months whose budget the contribution would push over its income (rule 59)', { timeout: 15000 }, async () => {
    // October already has a budget; planting 100 there leaves it 20 over its income.
    mockPosts(() =>
      schedule({ months: [month(2026, 9, 100, { hasBudget: true, shortfall: 0 }), month(2026, 10, 100, { hasBudget: true, shortfall: 20 }), month(2026, 11, 100)] }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await describeRecurring(dialog, user)
    const preview = within(await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 }))
    // The warning names the month and the overrun; the plan is never trimmed to fit.
    expect(preview.getByRole('status')).toHaveTextContent('Over budget: Oct 2026 by €20.00. The full contribution stays planned; adjust other lines if you need to.')
    expect(preview.getByText(/Sets aside €100\.00 a month/)).toBeInTheDocument()
    // The month list shows, with the over-budget month's amount in rose.
    const october = preview.getByText('Oct 2026').closest('li')!
    expect(within(october).getByText('€100.00')).toHaveClass('text-rose-600')
    const september = preview.getByText('Sep 2026').closest('li')!
    expect(within(september).getByText('€100.00')).not.toHaveClass('text-rose-600')
  })

  it('JAR-085: an ongoing pot reads "every month, ongoing"; a funded jar reads "Already funded"', { timeout: 15000 }, async () => {
    mockPosts((request) =>
      request.accrual === 2
        ? schedule({ accrual: 2, isOngoing: true, remaining: 0, months: [month(2026, 9, 50)], total: 50, deadline: null, fundingCompletesOn: null })
        : schedule({ remaining: 0, months: [], total: 0 }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.selectOptions(dialog.getByLabelText('How to save'), '2') // a fixed amount each month
    await user.type(dialog.getByLabelText('Monthly amount'), '50')
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent('Sets aside €50.00 every month, ongoing.')
    // No month list for an open-ended plan.
    expect(within(preview).queryByRole('listitem')).not.toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 1, targetAmount: 0, accrual: 2, monthlyContribution: 50, targetDate: null }))

    // By a deadline with nothing left to save (already set aside covers the target).
    await user.selectOptions(dialog.getByLabelText('How to save'), '1')
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2026-12-01' } })
    await user.type(dialog.getByLabelText('Already set aside'), '300')
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent('Already funded — nothing more to set aside.'), { timeout: 5000 })
  })

  it('JAR-086: "Include the deadline month" is offered only when the deadline is not the 1st, and is sent when ticked (rule 36)', { timeout: 15000 }, async () => {
    mockPosts((request) =>
      request.includeDeadlineMonth
        ? schedule({ months: [month(2026, 9, 75), month(2026, 10, 75), month(2026, 11, 75), month(2026, 12, 75)], deadline: '2026-12-15', fundingCompletesOn: '2026-12-31' })
        : schedule({ deadline: '2026-12-15' }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // Due on the 1st: the money must be there before the month begins, so there is no option.
    await describeRecurring(dialog, user)
    expect(dialog.queryByLabelText('Include the deadline month')).not.toBeInTheDocument()

    // Due mid-month: the option appears, off by default — the plan finishes the month before.
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-15' } })
    const option = dialog.getByLabelText('Include the deadline month')
    expect(option).not.toBeChecked()
    expect(dialog.getByText(/Also set aside money in Dec 2026, the deadline month\./)).toBeInTheDocument()
    expect(dialog.getByText(/so the money is already in Joint Current on/)).toBeInTheDocument()
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ targetDate: '2026-12-15', includeDeadlineMonth: false })), { timeout: 5000 })
    expect(await dialog.findByText(/Sets aside €100\.00 a month from Sep 2026 to Nov 2026/, {}, { timeout: 5000 })).toBeInTheDocument()

    // Ticked: the preview is re-asked with the option and runs into December.
    await user.click(option)
    expect(await dialog.findByText(/Sets aside €75\.00 a month from Sep 2026 to Dec 2026/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ includeDeadlineMonth: true }))

    // …and the choice is saved with the jar.
    mockPosts(() => schedule(), jar({ id: 'f9', name: 'Road tax', targetDate: '2026-12-15', includeDeadlineMonth: true }))
    await user.type(dialog.getByLabelText('Jar name'), 'Road tax')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ targetDate: '2026-12-15', includeDeadlineMonth: true, accrual: 1 })),
      { timeout: 5000 },
    )
  })

  it('JAR-087: a long uneven schedule lists twelve months and counts the rest; a long even one is summarised only', { timeout: 15000 }, async () => {
    const uneven = Array.from({ length: 14 }, (_, i) => month(2026 + Math.floor((8 + i) / 12), ((8 + i) % 12) + 1, i === 13 ? 10.1 : 10))
    const even = Array.from({ length: 14 }, (_, i) => month(2026 + Math.floor((8 + i) / 12), ((8 + i) % 12) + 1, 10))
    mockPosts((request) =>
      request.targetAmount === 140.1
        ? schedule({ remaining: 140.1, months: uneven, total: 140.1, deadline: '2027-11-01', fundingCompletesOn: '2027-10-31' })
        : schedule({ remaining: 140, months: even, total: 140, deadline: '2027-11-01', fundingCompletesOn: '2027-10-31' }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await describeRecurring(dialog, user, '140.1', '2027-11-01')
    let preview = within(await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 }))
    expect(preview.getByText(/Sets aside €140\.10 in total from Sep 2026 to Oct 2027/)).toBeInTheDocument()
    // Twelve listed months plus the "… and N more" line.
    expect(preview.getAllByRole('listitem')).toHaveLength(13)
    expect(preview.getByText('… and 2 more months')).toBeInTheDocument()

    // An even long plan needs no list: the summary already says it all.
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), '140')
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent(/Sets aside €10\.00 a month from Sep 2026 to Oct 2027/), { timeout: 5000 })
    preview = within(dialog.getByTestId('jar-schedule-preview'))
    expect(preview.queryByRole('listitem')).not.toBeInTheDocument()
  })

  // --- Jar-types InfoHint ---------------------------------------------------

  it('JAR-022: the "About jar types" InfoHint explains Recurring and Goal', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // The trigger is a real <button> beside the Type label (outside the <label>).
    const hint = dialog.getByRole('button', { name: 'About jar types' })
    fireEvent.focus(hint) // reveals the role="tooltip" popover
    const tip = await dialog.findByRole('tooltip', {}, { timeout: 5000 })
    expect(tip.textContent).toContain('Recurring')
    expect(tip.textContent).toMatch(/Saves toward a due date, then repeats/)
    expect(tip.textContent).toContain('Goal')
    expect(tip.textContent).toMatch(/one-off savings target/)
    expect(tip.textContent).toMatch(/ongoing pot you top up by a fixed amount each month/)
  })

  // --- Create-time round-trip ----------------------------------------------

  it('JAR-030: a Unicode / emoji jar name round-trips verbatim (trimmed only)', { timeout: 15000 }, async () => {
    const name = 'Café ☕ fund 🎉'
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name, kind: 1, recurMonths: null, targetAmount: 50, targetDate: '2027-03-01', deadline: '2027-03-01', status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    // Set the name in one shot (fireEvent.change) so surrogate-pair emoji aren't split
    // by per-keystroke typing; the field is controlled, so this drives the same onChange.
    fireEvent.change(dialog.getByLabelText('Jar name'), { target: { value: name } })
    await user.type(dialog.getByLabelText('Target amount'), '50')
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-03-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    // The exact string reaches the wire (only trimmed) — no mojibake, no re-encoding.
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name })),
      { timeout: 5000 },
    )
    expect(await screen.findByText(name, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
