import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, JarDto, JarScheduleDto, JarScheduleRequest } from '../types'

// Supplements JarsPage.catalog.test.tsx (which already covers JAR-002/004/005/009/011/
// 013/014/015/020/021/023/024/025/027/028/031/035/037/039/041/042/043/046/049) and
// JarsPage.test.tsx (JAR-001/003/012/018/019/026/032/034/036/044/086). This file adds the
// remaining jsdom-observable JAR cases neither file asserts: the schedule preview's
// phrasing (JAR-016) and its hide/show gate (JAR-017), the loading state (JAR-008), the
// "What repeating means" InfoHint copy (JAR-022), a Unicode round-trip (JAR-030) and the
// W02 preview cases: the month list with its rounding remainder (JAR-083), the over-budget
// warning (JAR-084), the ongoing / already-funded wording (JAR-085), the deadline-month
// option under "More options" (JAR-086) and the long-schedule summary (JAR-087).
//
// Same shared api mock as the sibling *.catalog.test.tsx files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar, schedule, scheduleMonth } from '../test/fixtures/jars'
import { me } from '../test/fixtures/me'
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format (€1,234.56),
// independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

/** Answer /jars/schedule from `plan` (given the request) and every other POST with `data`. */
function mockPosts(plan: (request: JarScheduleRequest) => JarScheduleDto, data: unknown = {}) {
  mockPost.mockImplementation((url: string, body: unknown) =>
    url === '/jars/schedule' ? Promise.resolve({ data: plan(body as JarScheduleRequest) }) : Promise.resolve({ data }),
  )
}

// Route the three endpoints JarsPage + AuthProvider hit on mount: /jars, /accounts and
// /auth/me. `jarsPending` leaves the /jars request unresolved (the loading-state case);
// a non-numeric /auth/me role leaves the AuthContext at its Owner default (canWrite).
// Accounts default to one account because a jar can't be created without one (rule 73).
const JOINT = account()

function mockLoads(
  opts: { jars?: JarDto[]; accounts?: AccountDto[]; meRole?: number; jarsPending?: boolean } = {},
) {
  const { jars = [], accounts = [JOINT], meRole, jarsPending = false } = opts
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
    if (url === '/jars') return jarsPending ? new Promise<never>(() => {}) : Promise.resolve({ data: jars })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/auth/me') return Promise.resolve({ data: meRole === undefined ? {} : me({ role: meRole }) })
    return Promise.resolve({ data: {} })
  })
}

const renderPage = () => renderWithProviders(<JarsPage />)

async function openNewJar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

/**
 * Describe a jar that repeats yearly: pick the cadence in "Repeats" (a new jar doesn't repeat by
 * default), then type its target and next due date, which is enough for the server to plan it.
 */
async function describeRecurring(dialog: ReturnType<typeof within>, user: ReturnType<typeof userEvent.setup>, target = '300', due = '2026-12-01') {
  await user.selectOptions(dialog.getByLabelText('Repeats'), '12')
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

  it('JAR-016: the preview says "due …, then it repeats" in its cycle for a jar that repeats, and "needed by …" for one that doesn\'t', { timeout: 15000 }, async () => {
    mockPosts(() => schedule())
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await describeRecurring(dialog, user) // Repeats: Yearly
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent(/Sets aside €100\.00 a month from Sep 2026 to Nov 2026, funded by .*, next due .*, then it repeats every year\./)

    // A 3-month cycle names the cycle.
    await user.selectOptions(dialog.getByLabelText('Repeats'), '3')
    await waitFor(() => expect(preview).toHaveTextContent(/then it repeats every 3 months\./), { timeout: 5000 })
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 0, recurMonths: 3 })), { timeout: 5000 })

    // One that doesn't repeat (a Goal): the date is now "Needed by", and the preview reads
    // funded by …, needed by …, with nothing about repeating.
    await user.selectOptions(dialog.getByLabelText('Repeats'), '0')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 1, recurMonths: null, targetDate: '2026-12-01' })), { timeout: 5000 })
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).not.toHaveTextContent(/repeats/), { timeout: 5000 })
    expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent(/Sets aside €100\.00 a month from Sep 2026 to Nov 2026, funded by .*, needed by .*\./)
  })

  it('JAR-016: Repeats = Monthly previews "then it repeats every month", and Every 6 months names its cycle', { timeout: 15000 }, async () => {
    mockPosts(() => schedule())
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // The cadence is worded as the card words it (cadenceLabel): 1 → "month", never "1 months".
    await user.selectOptions(dialog.getByLabelText('Repeats'), '1') // Monthly
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-01' } })
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent(/Sets aside €100\.00 a month from Sep 2026 to Nov 2026, funded by .*, next due .*, then it repeats every month\./)
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 0, recurMonths: 1 }))

    // A 6-month cycle names the number of months.
    await user.selectOptions(dialog.getByLabelText('Repeats'), '6') // Every 6 months
    await waitFor(() => expect(preview).toHaveTextContent(/then it repeats every 6 months\./), { timeout: 5000 })
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 0, recurMonths: 6 })), { timeout: 5000 })
  })

  it('JAR-016: the preview reads "Add a date or a monthly amount to plan contributions." when the server answers with no plan (hasSchedule false)', { timeout: 15000 }, async () => {
    // The planner may answer a plannable-looking definition with no schedule; the preview then
    // says what would plan it, in the form's own words (not the old "Add a deadline or …").
    mockPosts(() => schedule({ hasSchedule: false, months: [], total: 0, remaining: 300, deadline: null, fundingCompletesOn: null }))
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent('Add a date or a monthly amount to plan contributions.')
    expect(preview).not.toHaveTextContent(/deadline/)
    expect(within(preview).queryByRole('listitem')).not.toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 1, targetAmount: 300, targetDate: '2026-12-01', recurMonths: null }))
  })

  it('JAR-017: the preview is hidden, and nothing is asked, while the target is blank, 0 or unparseable', { timeout: 15000 }, async () => {
    mockPosts(() => schedule())
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
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
    mockPosts(() => schedule({ remaining: 100, months: [scheduleMonth(2026, 9, 33.33), scheduleMonth(2026, 10, 33.33), scheduleMonth(2026, 11, 33.34)], total: 100 }))
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
      schedule({ months: [scheduleMonth(2026, 9, 100, { hasBudget: true, shortfall: 0 }), scheduleMonth(2026, 10, 100, { hasBudget: true, shortfall: 20 }), scheduleMonth(2026, 11, 100)] }),
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
        ? schedule({ accrual: 2, isOngoing: true, remaining: 0, months: [scheduleMonth(2026, 9, 50)], total: 50, deadline: null, fundingCompletesOn: null })
        : schedule({ remaining: 0, months: [], total: 0 }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // No date in mind: the switch swaps the date for "Each month" (a fixed-monthly Goal, no target).
    const fixed = dialog.getByLabelText('Set aside a fixed amount each month')
    await user.click(fixed)
    await user.type(dialog.getByLabelText('Monthly amount'), '50')
    const preview = await dialog.findByTestId('jar-schedule-preview', {}, { timeout: 5000 })
    expect(preview).toHaveTextContent('Sets aside €50.00 every month, ongoing.')
    // No month list for an open-ended plan.
    expect(within(preview).queryByRole('listitem')).not.toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ kind: 1, targetAmount: 0, accrual: 2, monthlyContribution: 50, targetDate: null }))

    // By a date with nothing left to save (already set aside, under More options, covers the target).
    await user.click(fixed)
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-12-01' } })
    await user.click(dialog.getByRole('button', { name: 'More options' }))
    await user.type(dialog.getByLabelText('Already set aside'), '300')
    await waitFor(() => expect(dialog.getByTestId('jar-schedule-preview')).toHaveTextContent('Already funded — nothing more to set aside.'), { timeout: 5000 })
  })

  it('JAR-086: "Include the deadline month" sits under More options, is offered only when the deadline is not the 1st, and is sent when ticked (rule 36)', { timeout: 15000 }, async () => {
    mockPosts((request) =>
      request.includeDeadlineMonth
        ? schedule({ months: [scheduleMonth(2026, 9, 75), scheduleMonth(2026, 10, 75), scheduleMonth(2026, 11, 75), scheduleMonth(2026, 12, 75)], deadline: '2026-12-15', fundingCompletesOn: '2026-12-31' })
        : schedule({ deadline: '2026-12-15' }),
    )
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // The option lives under "More options", which starts closed for a new jar.
    await describeRecurring(dialog, user)
    const more = dialog.getByRole('button', { name: 'More options' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    // Due on the 1st: the money must be there before the month begins, so there is no option.
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
    const uneven = Array.from({ length: 14 }, (_, i) => scheduleMonth(2026 + Math.floor((8 + i) / 12), ((8 + i) % 12) + 1, i === 13 ? 10.1 : 10))
    const even = Array.from({ length: 14 }, (_, i) => scheduleMonth(2026 + Math.floor((8 + i) / 12), ((8 + i) % 12) + 1, 10))
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

  // --- "What repeating means" InfoHint ---------------------------------------

  it('JAR-022: the "What repeating means" InfoHint explains a jar that repeats and one that doesn\'t', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // The trigger is a real <button> beside the Repeats label (outside the <label>).
    const hint = dialog.getByRole('button', { name: 'What repeating means' })
    fireEvent.focus(hint) // reveals the role="tooltip" popover
    const tip = await dialog.findByRole('tooltip', {}, { timeout: 5000 })
    // Its two headings, each followed by what that kind of jar does…
    expect(within(tip).getByText('A jar that repeats')).toBeInTheDocument()
    expect(tip.textContent).toMatch(/insurance, road tax, school fees/)
    expect(tip.textContent).toMatch(/saves toward each due date, you mark it paid when the bill is settled, and it starts again/)
    expect(within(tip).getByText('One that doesn\u2019t')).toBeInTheDocument()
    expect(tip.textContent).toMatch(/a sofa, a kitchen, a trip/)
    expect(tip.textContent).toMatch(/done when it\u2019s funded/)
    // …and a pot you simply top up is pointed at the fixed-amount option below.
    expect(tip.textContent).toMatch(/tick the fixed amount option below instead/)
  })

  // --- Create-time round-trip ----------------------------------------------

  it('JAR-030: a Unicode / emoji jar name round-trips verbatim (trimmed only)', { timeout: 15000 }, async () => {
    const name = 'Café ☕ fund 🎉'
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name, kind: 1, recurMonths: null, targetAmount: 50, targetDate: '2027-03-01', deadline: '2027-03-01', status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // A new jar doesn't repeat by default (a Goal), so only its "Needed by" date is asked.
    // Set the name in one shot (fireEvent.change) so surrogate-pair emoji aren't split
    // by per-keystroke typing; the field is controlled, so this drives the same onChange.
    fireEvent.change(dialog.getByLabelText('Jar name'), { target: { value: name } })
    await user.type(dialog.getByLabelText('Target amount'), '50')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-03-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    // The exact string reaches the wire (only trimmed) — no mojibake, no re-encoding.
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name })),
      { timeout: 5000 },
    )
    expect(await screen.findByText(name, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
