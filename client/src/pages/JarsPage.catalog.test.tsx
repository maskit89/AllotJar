import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarDto, MeResponse } from '../types'

// Same api-control harness as JarsPage.test.tsx / the other *.catalog.test.tsx files:
// vi.hoisted so the mock factory can reference the fns, importOriginal spread so the
// rest of api.ts (refreshSession, setSessionHandlers, …) keeps working under the mock
// (the AuthProvider reaches into them on mount).
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
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format
// (€1,234.56), independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

// A fully-populated JarDto; accrual defaults to TargetByDate (1) — the method every
// genuinely-new jar saves — so the edit preview is live unless a test overrides it.
function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    coverStart: null,
    coverEnd: null,
    accrual: 1,
    recurMonths: 12,
    openingBalance: 0,
    openingAsOf: null,
    fundingAccountId: null,
    isArchived: false,
    currentBalance: 120,
    requiredMonthlyContribution: 25,
    projectedFullyFundedDate: '2026-11-01',
    status: 'OnTrack',
    ...over,
  }
}

// Account name deliberately doesn't collide with any jar name so its <option> never
// creates a duplicate text match.
const JOINT: AccountDto = {
  id: 'acc1', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0,
}

function me(role: number): MeResponse {
  return { userId: 'u1', email: 'chris@x.com', displayName: 'Chris', role, ownerId: 'u1', memberId: null }
}

// Route the three endpoints JarsPage + AuthProvider hit on mount: /jars, /accounts and
// /auth/me. A non-numeric /auth/me role leaves the AuthContext at its Owner default
// (canWrite = true); pass meRole to downgrade it (the read-only gating case).
function mockLoads(opts: { jars?: JarDto[]; accounts?: AccountDto[]; meRole?: number; jarsError?: boolean } = {}) {
  const { jars = [], accounts = [], meRole, jarsError = false } = opts
  mockGet.mockImplementation((url: string) => {
    if (url === '/jars') return jarsError ? Promise.reject(new Error('boom')) : Promise.resolve({ data: jars })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/auth/me') return Promise.resolve({ data: meRole === undefined ? {} : me(meRole) })
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

async function openNewJar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('JarsPage — catalog (JAR)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56
    mockLoads()
  })

  // --- List, hero, card & empty state --------------------------------------

  it('JAR-002: the hero sums Total saved / Monthly / Active jars across the list', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [
        jar({ id: 'f1', name: 'Home insurance', currentBalance: 120, requiredMonthlyContribution: 25 }),
        jar({ id: 'f2', name: 'Holiday', currentBalance: 300, requiredMonthlyContribution: 50 }),
      ],
    })

    renderPage()

    const hero = (await screen.findByText('Total saved', {}, { timeout: 5000 })).closest('section')!
    // Total saved = Σ currentBalance (120 + 300); the gold number carries its accessible name.
    expect(within(hero).getByLabelText('Total saved: €420.00')).toBeInTheDocument()
    // Monthly = Σ requiredMonthlyContribution (25 + 50), rendered with a leading "+".
    expect(within(hero).getByText('Monthly').closest('div')!.textContent).toContain('+€75.00')
    // Active jars = the count of jars in the list.
    expect(within(hero).getByText('Active jars').closest('div')!.textContent).toContain('2')
    expect(screen.getByRole('heading', { name: 'Your jars' })).toBeInTheDocument()
  })

  it('JAR-004: fill % clamps to 0–100 (overshoot pins 100%, negative pins 0%)', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [
        // 250 of 100 → 250% → clamps to 100 (status kept quiet so the % pill still shows).
        jar({ id: 'f1', name: 'Overshoot', targetAmount: 100, currentBalance: 250, status: 'OnTrack', requiredMonthlyContribution: 0, projectedFullyFundedDate: null }),
        // −40 of 1000 → −4% → clamps to 0; balance renders as a negative.
        jar({ id: 'f2', name: 'Negative', targetAmount: 1000, currentBalance: -40, status: 'Overspent', requiredMonthlyContribution: 0, projectedFullyFundedDate: null }),
      ],
    })

    renderPage()

    // The jar graphic + progressbar clamp at 100 / 0, never past the track.
    expect(await screen.findByRole('img', { name: 'Overshoot: 100% funded' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Negative: 0% funded' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Overshoot funding progress' })).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('progressbar', { name: 'Negative funding progress' })).toHaveAttribute('aria-valuenow', '0')
    // The pill echoes the clamped percentage; the negative balance renders with its sign.
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByText('-€40.00')).toBeInTheDocument()
  })

  it('JAR-005: the % pill is hidden for a FullyFunded jar and a target-less jar', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [
        jar({ id: 'f1', name: 'Sofa', targetAmount: 300, currentBalance: 300, status: 'FullyFunded', requiredMonthlyContribution: 0, projectedFullyFundedDate: null }),
        jar({ id: 'f2', name: 'Slush', targetAmount: 0, currentBalance: 500, status: 'Unfunded', requiredMonthlyContribution: 0, projectedFullyFundedDate: null }),
      ],
    })

    renderPage()

    // Sofa: the teal "Funded" chip, and NO "100%" pill next to it (would be redundant).
    expect(await screen.findByText('Funded', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('100%')).not.toBeInTheDocument()

    // Slush (target ≤ 0): no pill, no "of €…" suffix — just the bare balance — and "No target yet".
    const slush = screen.getByRole('img', { name: 'Slush: 0% funded' }).parentElement!
    expect(within(slush).getByText('€500.00')).toBeInTheDocument()
    expect(within(slush).queryByText(/of €/)).not.toBeInTheDocument()
    expect(within(slush).getByText('No target yet')).toBeInTheDocument()
  })

  it('JAR-009: a failed /jars load shows the error banner and no cards', { timeout: 15000 }, async () => {
    // /accounts is separately .catch-guarded, so only /jars failing drives the banner.
    mockLoads({ jarsError: true })

    renderPage()

    expect(await screen.findByText('Could not load your jars.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your jars' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('JAR-011: a read-only login sees the cards + hero but no New jar / Edit controls', { timeout: 15000 }, async () => {
    mockLoads({ meRole: 3, jars: [jar()] }) // ReadOnly ⇒ canWrite false once /auth/me resolves

    renderPage()

    // The card and hero totals render for everyone…
    expect(await screen.findByText('Home insurance', {}, { timeout: 5000 })).toBeInTheDocument()
    const hero = screen.getByText('Total saved').closest('section')!
    expect(within(hero).getByLabelText('Total saved: €120.00')).toBeInTheDocument()
    // …but once the ReadOnly role lands, the create + edit affordances disappear.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New jar' })).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByLabelText('Edit Home insurance')).not.toBeInTheDocument()
  })

  // --- Creating a jar (New jar modal) --------------------------------------

  it('JAR-013: a Goal create sends kind:1, recurMonths:null and the chosen target date', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'New kitchen', kind: 1, targetAmount: 5000, recurMonths: null, targetDate: '2027-01-01', status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'New kitchen')
    await user.type(dialog.getByLabelText('Target amount'), '5000')
    fireEvent.change(dialog.getByLabelText('Target date'), { target: { value: '2027-01-01' } })
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/jars',
          expect.objectContaining({ name: 'New kitchen', kind: 1, targetAmount: 5000, recurMonths: null, targetDate: '2027-01-01', accrual: 1 }),
        ),
      { timeout: 5000 },
    )
    expect(await screen.findByText('New kitchen', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('JAR-015: "Saved so far" is sent as the openingBalance on create', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Car repairs', kind: 1, targetAmount: 600, openingBalance: 150, currentBalance: 150, status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Car repairs')
    await user.type(dialog.getByLabelText('Target amount'), '600')
    // The field's visible label reads "Saved so far" on create; its aria-label stays "Opening balance".
    expect(dialog.getByText('Saved so far')).toBeInTheDocument()
    await user.type(dialog.getByLabelText('Opening balance'), '150')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ openingBalance: 150 })),
      { timeout: 5000 },
    )
  })

  it('JAR-020: Recurring offers the four cadence options, defaulting to Yearly (12)', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user) // Recurring is the default type

    const repeats = dialog.getByLabelText('Repeat cycle') as HTMLSelectElement
    for (const label of ['Yearly', 'Every 6 months', 'Every 3 months', 'Monthly']) {
      expect(within(repeats).getByRole('option', { name: label })).toBeInTheDocument()
    }
    expect(repeats.value).toBe('12') // Yearly selected by default
  })

  it('JAR-021: "Held in" lists the accounts and sends the picked id as fundingAccountId', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [JOINT] })
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Wheels', kind: 1, fundingAccountId: 'acc1', status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    const held = dialog.getByLabelText('Funding account') as HTMLSelectElement
    expect(within(held).getByRole('option', { name: 'No account' })).toBeInTheDocument()
    expect(within(held).getByRole('option', { name: 'Joint Current' })).toBeInTheDocument()

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal (no due-date guard)
    await user.type(dialog.getByLabelText('Jar name'), 'Wheels')
    await user.type(dialog.getByLabelText('Target amount'), '400')
    await user.selectOptions(held, 'acc1')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ fundingAccountId: 'acc1' })),
      { timeout: 5000 },
    )
  })

  it('JAR-021: with no accounts, "Held in" offers only "No account" plus the earmark helper', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [] })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    const held = dialog.getByLabelText('Funding account') as HTMLSelectElement
    expect(within(held).getAllByRole('option')).toHaveLength(1)
    expect(within(held).getByRole('option', { name: 'No account' })).toBeInTheDocument()
    expect(dialog.getByText(/Add accounts to earmark/)).toBeInTheDocument()
  })

  it('JAR-027: a Goal with target 0 and no date is accepted (Unfunded, "No target yet")', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Someday', kind: 1, targetAmount: 0, targetDate: null, recurMonths: null, currentBalance: 0, requiredMonthlyContribution: 0, projectedFullyFundedDate: null, status: 'Unfunded' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Someday')
    // Leave Target + Target date blank — the target/date guards apply only to Recurring.
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ kind: 1, targetAmount: 0, targetDate: null })),
      { timeout: 5000 },
    )
    expect(await screen.findByText('Someday', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('No target yet')).toBeInTheDocument()
  })

  it('JAR-028: a target with >4 decimals is rounded half-up to scale 4 on the wire', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name: 'Precise', kind: 1, targetAmount: 100.1235, status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Precise')
    await user.type(dialog.getByLabelText('Target amount'), '100.123456')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    // parseMinor rounds HALF-UP on the 5th fractional digit: 100.123456 → 100.1235.
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ targetAmount: 100.1235 })),
      { timeout: 5000 },
    )
  })

  it('JAR-031: a failed create keeps the modal open with the add-error banner', { timeout: 15000 }, async () => {
    mockPost.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    await user.type(dialog.getByLabelText('Jar name'), 'Doomed')
    await user.type(dialog.getByLabelText('Target amount'), '100')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Could not add that jar.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still open
    expect(dialog.getByRole('button', { name: 'Add jar' })).toBeEnabled() // saving cleared
    expect(screen.queryByText('Doomed')).not.toBeInTheDocument() // no card added
  })

  // --- Create-time validation ----------------------------------------------

  it('JAR-023: an empty or whitespace-only name is rejected client-side, no POST', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // Blank name.
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    expect(await dialog.findByText('Give the jar a name.', {}, { timeout: 5000 })).toBeInTheDocument()

    // Whitespace-only name (client trims before the check).
    await user.type(dialog.getByLabelText('Jar name'), '   ')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    expect(dialog.getByText('Give the jar a name.')).toBeInTheDocument()

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('JAR-024: a negative or non-numeric target is rejected with "Enter valid amounts."', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal isolates the amount check
    await user.type(dialog.getByLabelText('Jar name'), 'Bad target')
    await user.type(dialog.getByLabelText('Target amount'), '-5')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    expect(await dialog.findByText('Enter valid amounts.', {}, { timeout: 5000 })).toBeInTheDocument()

    // A malformed value is rejected the same way.
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), 'abc')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))
    expect(dialog.getByText('Enter valid amounts.')).toBeInTheDocument()

    expect(mockPost).not.toHaveBeenCalled()
  })

  it('JAR-025: a Recurring create with target ≤ 0 is blocked client-side', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user) // Recurring is the default

    await user.type(dialog.getByLabelText('Jar name'), 'Road tax')
    // Leave Target blank (parses to 0) — the create-only Recurring guard demands a real target.
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Give the recurring jar a target amount.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // --- Editing a jar --------------------------------------------------------

  it('JAR-035: editing echoes the stored accrual method (importer StraightLine survives)', { timeout: 15000 }, async () => {
    // The form has no Accrual control; a rename must send editingJar.accrual, not force TargetByDate.
    mockLoads({ jars: [jar({ accrual: 0, coverStart: '2026-01-01', coverEnd: '2026-12-31' })] })
    mockPut.mockResolvedValue({ data: jar({ accrual: 0, name: 'Living Costs' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.clear(dialog.getByLabelText('Jar name'))
    await user.type(dialog.getByLabelText('Jar name'), 'Living Costs')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ name: 'Living Costs', accrual: 0 })),
      { timeout: 5000 },
    )
  })

  it('JAR-037: switching a passed Recurring jar to Goal keeps its real anchor date', { timeout: 15000 }, async () => {
    // The DTO carries the stored anchor (2026-01-01), not the rolled effective date.
    mockLoads({ jars: [jar({ kind: 0, targetAmount: 500, targetDate: '2026-01-01', recurMonths: 12 })] })
    mockPut.mockResolvedValue({ data: jar({ kind: 1, targetDate: '2026-01-01', recurMonths: null, status: 'Behind' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // The prefilled "Next due" shows the anchor, not the rolled 2027-01-01.
    expect(dialog.getByLabelText('Next due date')).toHaveValue('2026-01-01')

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // → Goal
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ kind: 1, recurMonths: null, targetDate: '2026-01-01' })),
      { timeout: 5000 },
    )
  })

  it('JAR-039: a non-standard recurMonths is preserved as an extra Repeats option', { timeout: 15000 }, async () => {
    // accrual 0 keeps the preview suppressed so this focuses purely on the cadence select.
    mockLoads({ jars: [jar({ kind: 0, accrual: 0, recurMonths: 24, targetDate: '2026-06-01', targetAmount: 300 })] })
    mockPut.mockResolvedValue({ data: jar({ recurMonths: 24 }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const repeats = dialog.getByLabelText('Repeat cycle') as HTMLSelectElement
    // The stored 24 shows as an extra, pre-selected option so a save can't silently rewrite it.
    expect(within(repeats).getByRole('option', { name: 'Every 24 months' })).toBeInTheDocument()
    expect(repeats.value).toBe('24')

    await user.click(dialog.getByRole('button', { name: 'Save jar' }))
    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ recurMonths: 24 })),
      { timeout: 5000 },
    )
  })

  it('JAR-041: the edit preview recomputes live from the Opening field', { timeout: 15000 }, async () => {
    // No target date ⇒ the remainder spreads over 12 months (clock-independent). base =
    // editedOpening + (currentBalance − storedOpening). Target 300, currentBalance 120,
    // storedOpening 0 → base 120, remaining 180 ÷12 = €15.00; nudging Opening to 60 → base
    // 180, remaining 120 ÷12 = €10.00.
    mockLoads({ jars: [jar({ targetAmount: 300, openingBalance: 0, currentBalance: 120, targetDate: null, accrual: 1 })] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText(/€15\.00/)).toBeInTheDocument()

    await user.clear(dialog.getByLabelText('Opening balance'))
    await user.type(dialog.getByLabelText('Opening balance'), '60')
    expect(await dialog.findByText(/€10\.00/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(dialog.queryByText(/€15\.00/)).not.toBeInTheDocument()
  })

  it('JAR-042: no preview renders for a non-TargetByDate (StraightLine) jar', { timeout: 15000 }, async () => {
    // The client's TargetByDate mirror wouldn't match the server's StraightLine figure, so it's hidden.
    mockLoads({ jars: [jar({ accrual: 0, targetAmount: 300, targetDate: null })] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), '900')

    expect(dialog.queryByText(/Sets aside/)).not.toBeInTheDocument()
  })

  it('JAR-043: a failed edit save keeps the modal open with the save-error banner', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()] })
    mockPut.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.clear(dialog.getByLabelText('Jar name'))
    await user.type(dialog.getByLabelText('Jar name'), 'Renamed')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    expect(await dialog.findByText('Could not save that jar.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save jar' })).toBeEnabled()
  })

  // --- Archiving ------------------------------------------------------------

  it('JAR-046: a failed archive shows the archive-error banner and keeps the jar', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar()] })
    mockPut.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Home insurance', {}, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Archive Home insurance' })) // arm
    await user.click(dialog.getByRole('button', { name: 'Confirm archive Home insurance' })) // act

    expect(await dialog.findByText('Could not archive that jar.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Home insurance')).toBeInTheDocument() // still listed
  })

  it('JAR-049: cancelling an armed archive fires no request and resets the button', { timeout: 15000 }, async () => {
    mockLoads({ jars: [jar({ id: 'f1', name: 'Holiday' })] })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByLabelText('Edit Holiday', {}, { timeout: 5000 }))
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    // Arm the archive, then cancel out of the modal entirely.
    await user.click(dialog.getByRole('button', { name: 'Archive Holiday' }))
    expect(dialog.getByRole('button', { name: 'Confirm archive Holiday' })).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel edit' }))

    expect(mockPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText('Holiday')).toBeInTheDocument()

    // Re-opening shows the Archive button reset (confirmArchive cleared on close).
    await user.click(screen.getByLabelText('Edit Holiday'))
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByRole('button', { name: 'Archive Holiday' })).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Confirm archive Holiday' })).not.toBeInTheDocument()
  })
})
