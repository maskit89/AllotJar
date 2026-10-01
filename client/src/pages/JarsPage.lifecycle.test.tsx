import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JarDto } from '../types'

// W04 — completing and deleting a jar on the Jars page (rules 27, 55–56): Mark completed for a
// Goal and what the completed card says (JAR-094, JAR-095), Delete in the edit form for a jar
// that has never held money and its absence otherwise (JAR-096, JAR-097), and the server's
// refusals shown in its own words (JAR-098); an overdrawn Goal's dialog (O3a) and Reopen (O3c).
//
// Same shared api mock as the sibling *.catalog.test.tsx files.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar } from '../test/fixtures/jars'
import { me } from '../test/fixtures/me'
import { setMoneyFormat } from '../lib/money'

// A Goal saving 1,000 by a deadline: it holds 400 and plans 100 this month.
const goal = (over: Partial<JarDto> = {}) =>
  jar({
    id: 'g1',
    name: 'New laptop',
    kind: 1,
    targetAmount: 1000,
    targetDate: '2027-03-01',
    recurMonths: null,
    balanceAsOf: '2026-09-27',
    currentBalance: 400,
    plannedThisMonth: 100,
    remainingThisMonth: 100,
    deadline: '2027-03-01',
    fundingCompletesOn: '2027-02-28',
    ...over,
  })

// The same goal once the server has completed it: plans nothing, keeps its 400.
function completed(over: Partial<JarDto> = {}): JarDto {
  return goal({ completedOn: '2026-09-27', plannedThisMonth: 0, remainingThisMonth: 0, fundingCompletesOn: null, status: 'Completed', ...over })
}

const JOINT = account()

let jarsData: JarDto[] = []

function mockLoads(opts: { jars?: JarDto[]; meRole?: number } = {}) {
  jarsData = opts.jars ?? []
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
    if (url === '/jars') return Promise.resolve({ data: jarsData })
    if (url === '/accounts') return Promise.resolve({ data: [JOINT] })
    if (url === '/auth/me') {
      return Promise.resolve({ data: opts.meRole === undefined ? {} : me({ role: opts.meRole }) })
    }
    return Promise.resolve({ data: {} })
  })
}

const renderPage = () => renderWithProviders(<JarsPage />)

// An ASP.NET 400 with one field message, as axios surfaces it.
function validation(field: string, message: string) {
  return { response: { status: 400, data: { errors: { [field]: [message] } } } }
}

describe('JarsPage — completion and deletion (W04)', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    resetApiMocks()
    // The edit form previews its schedule (POST /jars/schedule) on a timer; answer it with
    // nothing plannable unless a test cares, so a late preview never reads an unset mock.
    mockPost.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    setMoneyFormat('en-GB')
  })

  it('JAR-094: a Goal offers Mark completed; confirming posts to /complete and the card reads Completed with the money still held', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal()] })
    mockPost.mockResolvedValue({ data: completed() })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Mark New laptop completed', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByText('Mark New laptop completed?')).toBeInTheDocument()
    // What the user is told: the money stays, the plan stops from this month on.
    expect(dialog.getByText(/holds €400\.00 of its €1,000\.00 target, €600\.00 short/)).toBeInTheDocument()
    expect(dialog.getByText(/stops the planned contributions from this month on/)).toBeInTheDocument()
    await user.click(dialog.getByLabelText('Confirm complete New laptop'))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/g1/complete'))
    expect(await screen.findByText('Completed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Completed · €400.00 left to move')).toBeInTheDocument()
    expect(screen.getByText(/^Completed on .*Sep.*2026 · no more contributions planned$/)).toBeInTheDocument()
    // The card still lets the money be moved and the jar edited, but not completed again.
    expect(screen.queryByLabelText('Mark New laptop completed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Move money from New laptop')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit New laptop')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('JAR-095: only a Goal with a known balance offers Mark completed; recurring and unavailable jars offer nothing, and a completed one leaves the Active count', async () => {
    mockLoads({
      jars: [
        goal({ id: 'r1', name: 'Road tax', kind: 0, recurMonths: 12 }),
        goal({ id: 'o1', name: 'Overdrawn', currentBalance: -20, status: 'Overspent' }),
        goal({ id: 'u1', name: 'Unknown', currentBalance: null, status: 'Unavailable' }),
        completed({ id: 'c1', name: 'Done' }),
        goal(),
      ],
    })

    renderPage()

    expect(await screen.findByLabelText('Mark New laptop completed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Road tax completed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Mark Road tax paid')).toBeInTheDocument()
    // O3a: an overdrawn Goal opens the dialog, which says how much to cover first (below).
    expect(screen.getByLabelText('Mark Overdrawn completed')).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Unknown completed')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Mark Done completed')).not.toBeInTheDocument()
    // Five jars listed, four active (rule 55: a completed goal stays listed but no longer saves).
    expect(screen.getByText('Active jars').nextSibling).toHaveTextContent('4')
  })

  // O3a (answered 1 October 2026): an overdrawn Goal still can't be completed (P41); the dialog
  // says how much to cover first and offers no confirm.
  it('O3a: an overdrawn Goal\'s dialog says how much to cover first, with nothing to confirm', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal({ currentBalance: -20, status: 'Overspent' })] })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Mark New laptop completed', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(
      dialog.getByText(
        'New laptop is €20.00 overdrawn. Cover the €20.00 shortfall from another jar or unallocated funds first, then mark it completed.',
      ),
    ).toBeInTheDocument()
    expect(dialog.queryByLabelText('Confirm complete New laptop')).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // O3c (answered 1 October 2026): a completed Goal offers Reopen, confirmed in a dialog; the
  // server replants it and the card reads as a live jar again.
  it('O3c: a completed Goal offers Reopen; confirming posts to /reopen and the card saves again', { timeout: 15000 }, async () => {
    mockLoads({ jars: [completed(), completed({ id: 'a1', name: 'Shelved', isArchived: true })] })
    mockPost.mockResolvedValue({ data: goal() })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Reopen New laptop', {}, { timeout: 5000 }))
    // An archived completed jar is restored first: it offers no Reopen.
    expect(screen.queryByLabelText('Reopen Shelved')).not.toBeInTheDocument()
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Reopen New laptop?')).toBeInTheDocument()
    expect(dialog.getByText(/holds €400\.00\. Reopening makes it active again/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
    await user.click(dialog.getByLabelText('Confirm reopen New laptop'))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/jars/g1/reopen'))
    expect(await screen.findByLabelText('Mark New laptop completed', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Reopen New laptop')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('JAR-098: the server\'s refusal to complete is shown in its own words and the jar is unchanged', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal()] })
    mockPost.mockRejectedValue(validation('Id', 'New laptop is 20.00 EUR overdrawn. Cover the 20.00 EUR shortfall from another jar or unallocated funds first, then mark it completed.'))
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Mark New laptop completed', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Confirm complete New laptop'))

    expect(
      await dialog.findByText(
        'New laptop is 20.00 EUR overdrawn. Cover the 20.00 EUR shortfall from another jar or unallocated funds first, then mark it completed.',
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Completed')).not.toBeInTheDocument()
  })

  it('JAR-096: a jar that has never held money offers Delete in its edit form, in two clicks; confirming calls DELETE and drops the card', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal({ canDelete: true, currentBalance: 0, plannedThisMonth: 100, status: 'OnTrack' })] })
    mockDelete.mockResolvedValue({ status: 204 })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Edit New laptop', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    // Both endings are offered: archive keeps history, delete removes the jar and its planned lines.
    expect(dialog.getByLabelText('Archive New laptop')).toBeInTheDocument()
    await user.click(dialog.getByLabelText('Delete New laptop'))
    expect(mockDelete).not.toHaveBeenCalled()
    await user.click(dialog.getByLabelText('Confirm delete New laptop'))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/jars/g1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('New laptop')).not.toBeInTheDocument()
  })

  it('JAR-097: a jar that has held money offers Archive but never Delete (rule 27)', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal({ canDelete: false })] })
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Edit New laptop', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByLabelText('Archive New laptop')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Delete New laptop')).not.toBeInTheDocument()
  })

  it('JAR-098: a refused delete is shown in the server\'s words and the jar stays', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal({ canDelete: true })] })
    mockDelete.mockRejectedValue(validation('Id', 'New laptop has held money, so it cannot be deleted. Archive it instead to keep its history.'))
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByLabelText('Edit New laptop', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Delete New laptop'))
    await user.click(dialog.getByLabelText('Confirm delete New laptop'))

    expect(
      await dialog.findByText('New laptop has held money, so it cannot be deleted. Archive it instead to keep its history.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('New laptop').length).toBeGreaterThan(0)
  })

  it('JAR-093: a viewer sees no Mark completed and no edit form', async () => {
    mockLoads({ jars: [goal({ canDelete: true })], meRole: 3 })

    renderPage()

    expect(await screen.findByText('New laptop', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark New laptop completed')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Edit New laptop')).not.toBeInTheDocument()
  })
})
