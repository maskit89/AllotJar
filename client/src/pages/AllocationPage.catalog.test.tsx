import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, AllocationProfileDto, AllocationResultDto, HouseholdMemberDto, MemberAllocationDto } from '../types'

// Colocated catalog tests for the Allocation screen (docs/testing/cases/14-allocation.md, prefix ALLOC).
// This file is ADDITIVE — it does not touch AllocationPage.test.tsx. It converts the P0/cheap-P1/P2
// cases whose behaviour is observable in a jsdom render (gating, labels/copy, the income-split
// segmented controls, hero + waterfall figures, InfoHints, client validation, Cancel/backdrop revert,
// the amber stranded / nothing-to-save notes, the committed banner and the no-source gating) and
// were previously marked Automated: No / Partial.
//
// The api mock, the importOriginal spread and the render helper deliberately mirror the sibling
// AllocationPage.test.tsx so both files share one convention.

const { mockGet, mockPut, mockPost, monthState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  // The app-wide selected month the page allocates (rule 29). Mutable so a case can move it
  // and rerender; reset to July 2026 in beforeEach.
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))

// The selected month comes from MonthContext (rule 29); pin it so assertions are clock-independent.
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AllocationPage } from './AllocationPage'
import { AuthProvider } from '../auth/AuthContext'

// Two owned accounts so the source-account select has more than one real option (ALLOC-011).
// Mutable so the savings-link tests can add savings-type accounts; reset in beforeEach.
function defaultAccounts(): AccountDto[] {
  return [
    { id: 'accJoint', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 },
    { id: 'accPot', name: 'Savings pot', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1 },
  ]
}
let accountsData: AccountDto[] = defaultAccounts()

// The standard profile the client always writes: source Joint, pocket 0, split Equally,
// send-savings-to Balance, lean 25, four rules FundEnvelopes/FundJars/FixedPerMember/SplitRemainder.
function profile(overrides: Partial<AllocationProfileDto> = {}): AllocationProfileDto {
  return {
    id: 'p1',
    name: 'Household allocation',
    sourceAccountId: 'accJoint',
    balanceLeanPercent: 25,
    rules: [
      { id: 'r0', order: 0, type: 0, split: 0, fixedAmountPerMember: 0 },
      { id: 'r1', order: 1, type: 1, split: 0, fixedAmountPerMember: 0 },
      { id: 'r2', order: 2, type: 2, split: 0, fixedAmountPerMember: 0 },
      { id: 'r3', order: 3, type: 3, split: 2, fixedAmountPerMember: 0 },
    ],
    ...overrides,
  }
}

// A preview builder. DTO amounts are major-unit decimals (the client converts to minor units for
// display), matching the worked-example July budget in the catalog.
function mkPreview(opts: {
  pool: number
  env: number
  jars: number
  pocketTotal: number
  pocketEach?: number
  savingsTotal: number
  members: MemberAllocationDto[]
  transfersCreated?: number
}): AllocationResultDto {
  const { pool, env, jars, pocketTotal, pocketEach = 0, savingsTotal, members, transfersCreated = 0 } = opts
  const per = (amount: number) => members.map((m) => ({ memberId: m.memberId, name: m.name, amount }))
  return {
    pool,
    envelopesTotal: env,
    jarsTotal: jars,
    transfersCreated,
    steps: [
      { type: 0, total: env, perMember: per(0) },
      { type: 1, total: jars, perMember: per(0) },
      { type: 2, total: pocketTotal, perMember: per(pocketEach) },
      { type: 3, total: savingsTotal, perMember: members.map((m) => ({ memberId: m.memberId, name: m.name, amount: m.residual })) },
    ],
    members,
  }
}

// The catalog worked example: pool 5,000, envelopes 2,000, jars 500, pocket 0 → shared 2,500 / savings 2,500.
function workedPreview(transfersCreated = 0): AllocationResultDto {
  return mkPreview({
    pool: 5000,
    env: 2000,
    jars: 500,
    pocketTotal: 0,
    savingsTotal: 2500,
    transfersCreated,
    members: [
      { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1250, savingsBalance: 1000, savingsAccountId: 'accC' },
      { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1250, savingsBalance: 500, savingsAccountId: 'accR' },
    ],
  })
}

// Mutable per-test fixtures the mock reads at call time.
let profileData: AllocationProfileDto | null = null
let previewData: AllocationResultDto = workedPreview()
// The selected month's budget (GET /budget/{year}/{month}); null = no budget yet (404).
let currentBudget: { year?: number; month?: number; categories?: unknown[] } | null = { year: 2026, month: 7, categories: [] }
// The saved member records the savings-link PUT echoes (name + DEFAULT income) — never the preview's figures.
let membersData: HouseholdMemberDto[] = []
let failProfile = false
let failAccounts = false
let failPreview = false

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/allocation/profile') {
      return failProfile ? Promise.reject(new Error('500')) : Promise.resolve({ data: profileData })
    }
    if (url === '/accounts') {
      return failAccounts ? Promise.reject(new Error('500')) : Promise.resolve({ data: accountsData })
    }
    if (url === `/budget/${monthState.year}/${monthState.month}`) {
      return currentBudget ? Promise.resolve({ data: currentBudget }) : Promise.reject({ response: { status: 404 } })
    }
    if (url === '/members') return Promise.resolve({ data: membersData })
    if (url.startsWith('/allocation/preview/')) {
      return failPreview ? Promise.reject(new Error('500')) : Promise.resolve({ data: previewData })
    }
    // Everything else the tree pulls on mount (/auth/me, /members, …) — a benign empty payload.
    return Promise.resolve({ data: [] })
  })
}

// AuthProvider only (no HouseholdProvider) — exactly as the sibling file's engine-render tests do:
// the household default keeps `loading` true forever, so the solo "Add people first" gate never
// triggers and the page renders the engine for these fixtures.
function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AllocationPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** "€5,000.00" → 5000, "-€500.00" → -500 (en-GB EUR: ',' grouping, '.' decimal). */
function money(text: string | null | undefined): number {
  const raw = (text ?? '').trim()
  const neg = raw.startsWith('-')
  const n = parseFloat(raw.replace(/[^\d.]/g, ''))
  return neg ? -n : n
}

/** Read a hero stat-tile's value by its label (the value span is the label span's sibling). */
function heroTileValue(label: string): number {
  return money(screen.getByText(label).nextElementSibling?.textContent)
}

async function openSettingsFromCard(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('How July is allocated', {}, { timeout: 5000 })
  await user.click(screen.getByRole('button', { name: 'Allocation settings' }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

async function openSetupModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Set up allocation' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('AllocationPage (catalog)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    localStorage.clear() // role → Owner, currency → EUR, format → comma-dot (en-GB) by default
    profileData = null
    accountsData = defaultAccounts()
    previewData = workedPreview()
    currentBudget = { year: 2026, month: 7, categories: [] }
    membersData = []
    monthState.year = 2026
    monthState.month = 7
    monthState.label = 'July 2026'
    failProfile = false
    failAccounts = false
    failPreview = false
    setupGet()
  })

  // ---- Gating & loading -----------------------------------------------------

  it('ALLOC-006: swallows failed profile + accounts fetches and falls to the setup empty-state', async () => {
    failProfile = true
    failAccounts = true

    renderPage()

    // No error boundary/crash — the .catch() defaults leave profile null → setup state.
    expect(await screen.findByText(/No allocation set up yet/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up allocation' })).toBeInTheDocument()
  })

  // ALLOC-007 (rewritten for rule 29) — the viewed month is the app-wide selected month, the same
  // one the Budget shows; the preview and the month's budget are read for it.
  it('ALLOC-007: the viewed month is the selected month (July heading, Allocate July, July preview)', async () => {
    profileData = profile()

    renderPage()

    expect(await screen.findByText('How July is allocated', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toHaveTextContent('Allocate July')
    const urls = mockGet.mock.calls.map((c) => c[0] as string)
    expect(urls).toContain('/allocation/preview/2026/7')
    expect(urls).toContain('/budget/2026/7')
    expect(urls).not.toContain('/budget/current')
  })

  it('ALLOC-007: moving the selected month reloads the preview for that month', async () => {
    profileData = profile()

    const view = renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    // The top bar moves to August: heading, button and preview follow.
    monthState.year = 2026
    monthState.month = 8
    monthState.label = 'August 2026'
    view.rerender(
      <MemoryRouter>
        <AuthProvider>
          <AllocationPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('How August is allocated', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toHaveTextContent('Allocate August')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/allocation/preview/2026/8'), { timeout: 5000 })
  })

  it('ALLOC-009: a read-only user sees the empty-state but no Set up button', async () => {
    localStorage.setItem('zbb.role', '3') // ReadOnly → canWrite false
    profileData = null

    renderPage()

    expect(await screen.findByText(/No allocation set up yet/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up allocation' })).not.toBeInTheDocument()
  })

  // ---- Settings modal: open, controls, InfoHints ----------------------------

  it('ALLOC-010: Set up opens the "Set up allocation" modal seeded with defaults', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    // Title is "Set up allocation" (not "Allocation settings") and the primary button reads "Set up".
    expect(screen.getByRole('dialog', { name: 'Set up allocation' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save allocation settings' })).toHaveTextContent('Set up')
    // Seeded defaults: source blank, pocket empty, split Equally, savings Balance, lean 25.
    expect(dialog.getByLabelText('Source account')).toHaveValue('')
    expect(dialog.getByLabelText('Pocket money per member')).toHaveValue('')
    expect(dialog.getByLabelText('Balance lean percent')).toHaveValue('25')
    expect(within(dialog.getByRole('group', { name: 'Split method' })).getByRole('button', { name: 'Equally' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog.getByRole('group', { name: 'Savings split method' })).getByRole('button', { name: 'Balance' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('ALLOC-011: the source select lists "Choose an account…" then each owned account', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const options = within(dialog.getByLabelText('Source account')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Choose an account…', 'Joint', 'Savings pot'])
  })

  it('ALLOC-013: the split control offers Equally / By income and writes the choice to both cost rules', async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const group = within(dialog.getByRole('group', { name: 'Split method' }))
    expect(group.getAllByRole('button').map((b) => b.textContent)).toEqual(['Equally', 'By income'])
    // Default is Equally; picking By income writes split=1 (ByIncomeRatio) to FundEnvelopes AND FundJars.
    await user.click(group.getByRole('button', { name: 'By income' }))
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const body = mockPut.mock.calls[0][1] as { rules: { type: number; split: number }[] }
    expect(body.rules.find((r) => r.type === 0)?.split).toBe(1)
    expect(body.rules.find((r) => r.type === 1)?.split).toBe(1)
  })

  it('ALLOC-014: the savings-split control offers Balance / Equally / By income (Balance default)', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const group = within(dialog.getByRole('group', { name: 'Savings split method' }))
    expect(group.getAllByRole('button').map((b) => b.textContent)).toEqual(['Balance', 'Equally', 'By income'])
    expect(group.getByRole('button', { name: 'Balance' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('ALLOC-015: the balance-lean input shows only while savings split = Balance', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const savings = within(dialog.getByRole('group', { name: 'Savings split method' }))
    expect(dialog.getByLabelText('Balance lean percent')).toBeInTheDocument()

    await user.click(savings.getByRole('button', { name: 'Equally' }))
    expect(dialog.queryByLabelText('Balance lean percent')).not.toBeInTheDocument()

    await user.click(savings.getByRole('button', { name: 'By income' }))
    expect(dialog.queryByLabelText('Balance lean percent')).not.toBeInTheDocument()

    await user.click(savings.getByRole('button', { name: 'Balance' }))
    expect(dialog.getByLabelText('Balance lean percent')).toBeInTheDocument()
  })

  it('ALLOC-016: all four opaque controls carry a named InfoHint', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    // The lean hint only exists while savings split = Balance (the default), so all four are present.
    for (const name of ['About the source account', 'About splitting shared costs', 'About the savings split', 'About balance lean']) {
      expect(dialog.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  // ---- Settings modal: save, validation, cancel/backdrop revert --------------

  it('ALLOC-012: the pocket-money amount round-trips into the FixedPerMember rule', async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    await user.selectOptions(dialog.getByLabelText('Source account'), 'accJoint')
    await user.type(dialog.getByLabelText('Pocket money per member'), '50')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const body = mockPut.mock.calls[0][1] as { rules: { type: number; fixedAmountPerMember: number }[] }
    expect(body.rules.find((r) => r.type === 2)?.fixedAmountPerMember).toBe(50)
  })

  it('ALLOC-019: editing an existing profile shows "Save" and PUTs the change with the profile id', async () => {
    profileData = profile()
    mockPut.mockResolvedValue({ data: profile({ rules: profile().rules.map((r) => (r.type <= 1 ? { ...r, split: 1 } : r)) }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSettingsFromCard(user)

    // A saved profile exists → the modal titles "Allocation settings" and the button reads "Save".
    expect(screen.getByRole('dialog', { name: 'Allocation settings' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save allocation settings' })).toHaveTextContent('Save')

    await user.click(within(dialog.getByRole('group', { name: 'Split method' })).getByRole('button', { name: 'By income' }))
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const body = mockPut.mock.calls[0][1] as { id: string; rules: { type: number; split: number }[] }
    expect(body.id).toBe('p1')
    expect(body.rules.find((r) => r.type === 0)?.split).toBe(1)
    expect(body.rules.find((r) => r.type === 1)?.split).toBe(1)
  })

  it('ALLOC-020: saving the profile clears a stale "Allocated" banner', async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: workedPreview(2) })
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()

    // Commit first so the banner is showing.
    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))
    expect(await screen.findByText(/2 savings transfers recorded as in transit/, {}, { timeout: 5000 })).toBeInTheDocument()

    // Now edit + save — the figures just changed, so the banner must clear (setCommitted(null)).
    await user.click(screen.getByRole('button', { name: 'Allocation settings' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const lean = dialog.getByLabelText('Balance lean percent')
    await user.clear(lean)
    await user.type(lean, '50')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    await waitFor(() => expect(screen.queryByText(/savings transfers recorded/)).not.toBeInTheDocument(), { timeout: 5000 })
  })

  it('ALLOC-021: Cancel reverts unsaved edits so a later Save cannot commit them', async () => {
    profileData = profile()
    const user = userEvent.setup()

    renderPage()
    let dialog = await openSettingsFromCard(user)

    // Discard-me edits.
    await user.click(within(dialog.getByRole('group', { name: 'Split method' })).getByRole('button', { name: 'By income' }))
    const pocket = dialog.getByLabelText('Pocket money per member')
    await user.clear(pocket)
    await user.type(pocket, '200')
    await user.click(dialog.getByRole('button', { name: 'Cancel settings' }))

    // Re-open: the form is re-seeded from the SAVED profile, not the cancelled edits.
    await user.click(screen.getByRole('button', { name: 'Allocation settings' }))
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(within(dialog.getByRole('group', { name: 'Split method' })).getByRole('button', { name: 'Equally' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog.getByLabelText('Pocket money per member')).toHaveValue('0')
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('ALLOC-022: closing via the ✕ (backdrop) also reverts unsaved edits', async () => {
    profileData = profile()
    const user = userEvent.setup()

    renderPage()
    let dialog = await openSettingsFromCard(user)

    // Edit the lean (while Balance is selected), then switch savings split away — both must revert.
    const lean = dialog.getByLabelText('Balance lean percent')
    await user.clear(lean)
    await user.type(lean, '0')
    await user.click(within(dialog.getByRole('group', { name: 'Savings split method' })).getByRole('button', { name: 'Equally' }))
    await user.click(dialog.getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'Allocation settings' }))
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(within(dialog.getByRole('group', { name: 'Savings split method' })).getByRole('button', { name: 'Balance' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog.getByLabelText('Balance lean percent')).toHaveValue('25')
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('UX-056: typing over a prefilled numeric field replaces the value (select-on-focus)', async () => {
    profileData = profile()
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSettingsFromCard(user)

    // The lean field is prefilled "25" — type WITHOUT clearing; the focus-time
    // selection makes "50" replace it instead of producing "255"/"525".
    const lean = dialog.getByLabelText('Balance lean percent')
    await user.type(lean, '50')
    expect(lean).toHaveValue('50')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const body = mockPut.mock.calls[0][1] as { balanceLeanPercent: number }
    expect(body.balanceLeanPercent).toBe(50)
  })

  it('ALLOC-023: an invalid pocket-money amount is blocked with a message and no PUT', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    await user.type(dialog.getByLabelText('Pocket money per member'), 'abc')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    expect(await screen.findByText('Enter a valid pocket-money amount.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument() // modal stays open
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('ALLOC-025: a non-integer / out-of-range balance lean is blocked with a message and no PUT', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const lean = dialog.getByLabelText('Balance lean percent')
    await user.clear(lean)
    await user.type(lean, '101')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    expect(await screen.findByText('Balance lean must be a whole number between 0 and 100.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('ALLOC-026: a balance lean of 100 persists', async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    const lean = dialog.getByLabelText('Balance lean percent')
    await user.clear(lean)
    await user.type(lean, '100')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect((mockPut.mock.calls[0][1] as { balanceLeanPercent: number }).balanceLeanPercent).toBe(100)
  })

  it('ALLOC-026: a blank balance lean defaults to 25', async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    await user.clear(dialog.getByLabelText('Balance lean percent'))
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect((mockPut.mock.calls[0][1] as { balanceLeanPercent: number }).balanceLeanPercent).toBe(25)
  })

  it('ALLOC-027: a profile-save failure surfaces an error and keeps the modal open', async () => {
    profileData = null
    mockPut.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    await user.selectOptions(dialog.getByLabelText('Source account'), 'accJoint')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    expect(await screen.findByText('Could not save the allocation profile.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  // ---- Hero tiles & reconciliation ------------------------------------------

  it('ALLOC-029/030: the hero shows the pool + two tiles that reconcile to it', async () => {
    profileData = profile()
    previewData = workedPreview()

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    expect(screen.getByText('Income to allocate')).toBeInTheDocument()
    expect(screen.getByText('€5,000.00')).toBeInTheDocument() // pool
    const shared = heroTileValue('Shared spending')
    const savings = heroTileValue('To savings')
    expect(shared).toBe(2500)
    expect(savings).toBe(2500)
    // Shared spending + To savings == Income to allocate, by construction.
    expect(shared + savings).toBeCloseTo(money('€5,000.00'), 2)
  })

  it('ALLOC-031/045/056: an over-committed month shows negative To savings that still reconciles, rose residuals and the nothing-to-save note', async () => {
    profileData = profile()
    // Envelopes 4,000 + jars 1,500 = 5,500 shared spending vs pool 5,000 → To savings −500.
    previewData = mkPreview({
      pool: 5000,
      env: 4000,
      jars: 1500,
      pocketTotal: 0,
      savingsTotal: -500,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: -250, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: -250, savingsBalance: 500, savingsAccountId: 'accR' },
      ],
    })

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    const shared = heroTileValue('Shared spending')
    const savings = heroTileValue('To savings')
    expect(shared).toBe(5500)
    expect(savings).toBe(-500)
    expect(shared + savings).toBeCloseTo(money('€5,000.00'), 2)

    // Negative residuals render in the rose tone.
    const roseResiduals = screen.getAllByText('-€250.00')
    expect(roseResiduals.length).toBe(2)
    expect(roseResiduals[0].className).toContain('text-rose-600')

    // Both members have savings accounts (nothing stranded) and To savings < 0 → the honest
    // overshoot note (the bland nothing-to-save copy is reserved for exactly zero).
    expect(screen.getByText(/overshoot the pooled income by €500\.00/)).toBeInTheDocument()
  })

  it('ALLOC-032: with a profile but a failed preview, no hero renders and the preview error shows', async () => {
    profileData = profile()
    failPreview = true

    renderPage()

    expect(await screen.findByText('Could not compute the allocation preview.', {}, { timeout: 5000 })).toBeInTheDocument()
    // Hero needs profile && preview; the preview never arrived, so the eyebrow is absent.
    expect(screen.queryByText('Income to allocate')).not.toBeInTheDocument()
    expect(screen.queryByText('How July is allocated')).not.toBeInTheDocument()
  })

  // ---- Waterfall steps ------------------------------------------------------

  it('ALLOC-033: the waterfall card shows all four step labels, the per-member pocket suffix and totals', async () => {
    profileData = profile()
    // pocket 100 total (€50.00 each), so the "· €X each" suffix renders.
    previewData = mkPreview({
      pool: 5000,
      env: 2000,
      jars: 500,
      pocketTotal: 100,
      pocketEach: 50,
      savingsTotal: 2400,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1200, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1200, savingsBalance: 500, savingsAccountId: 'accR' },
      ],
    })

    renderPage()

    expect(await screen.findByText('How July is allocated', {}, { timeout: 5000 })).toBeInTheDocument()
    for (const label of ['Cover shared costs', 'Fund the jars', 'Pocket money', 'Split remainder to savings']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText(/€50\.00 each/)).toBeInTheDocument()
    expect(screen.getByText('€100.00')).toBeInTheDocument() // pocket step total (unique)
  })

  it('ALLOC-034: the pocket "· €X each" suffix is omitted when the per-member amount is 0', async () => {
    profileData = profile()
    previewData = workedPreview() // pocket 0

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    expect(screen.getByText('Pocket money')).toBeInTheDocument()
    expect(screen.queryByText(/each/)).not.toBeInTheDocument()
  })

  // ---- Per-member savings tiles ---------------------------------------------

  it('ALLOC-044: each member tile shows the pre-allocation balance, residual and projected balance', async () => {
    profileData = profile()
    previewData = mkPreview({
      pool: 5000,
      env: 2000,
      jars: 500,
      pocketTotal: 200,
      pocketEach: 100,
      savingsTotal: 2300,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1150, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1150, savingsBalance: 500, savingsAccountId: 'accR' },
      ],
    })

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    expect(screen.getByText('Alex')).toBeInTheDocument()
    expect(screen.getByText('Robin')).toBeInTheDocument()
    // "Savings €X → saves" + residual + "Projected balance €Y" (Alex 1,000+1,150=2,150; Robin 500+1,150=1,650).
    expect(screen.getAllByText(/→ saves/).length).toBe(2)
    expect(screen.getAllByText('€1,150.00').length).toBe(2) // both residuals
    expect(screen.getAllByText(/Projected balance/).length).toBe(2)
    expect(screen.getByText(/Projected balance €2,150\.00/)).toBeInTheDocument() // Alex 1,000 + 1,150
    expect(screen.getByText(/Projected balance €1,650\.00/)).toBeInTheDocument() // Robin 500 + 1,150
  })

  it('ALLOC-046/055: a member with no savings account gets the note and its positive share shows as stranded', async () => {
    profileData = profile()
    previewData = mkPreview({
      pool: 5000,
      env: 2000,
      jars: 500,
      pocketTotal: 200,
      pocketEach: 100,
      savingsTotal: 2300,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1150, savingsBalance: 1000, savingsAccountId: 'accC' },
        // Robin: positive residual but no savings account → stranded.
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1150, savingsBalance: 0, savingsAccountId: null },
      ],
    })

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    // The card names the person and the consequence (Joint is the source account).
    expect(screen.getByText(/No savings account linked — Robin’s share stays in Joint/)).toBeInTheDocument()
    // The stranded amount (Σ residual of accountless members with a positive share) is called out by name.
    expect(screen.getByText(/€1,150.00 won’t be transferred — Robin has no savings account linked/)).toBeInTheDocument()
    // No savings-type account exists yet, so the fix path is creating one — not a picker.
    expect(screen.getByRole('button', { name: 'Create a savings account' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Savings account for Robin')).not.toBeInTheDocument()
  })

  it('ALLOC-064: the inline picker links a savings account with a full-echo PUT and reloads the preview', async () => {
    profileData = profile()
    accountsData = [
      ...defaultAccounts(),
      { id: 'accRobinSav', name: 'Robin Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 2 },
    ]
    const stranded = () => mkPreview({
      pool: 5000, env: 2000, jars: 500, pocketTotal: 200, pocketEach: 100, savingsTotal: 2300,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1150, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1150, savingsBalance: 0, savingsAccountId: null },
      ],
    })
    previewData = stranded()
    // Robin's SAVED default income is 1,750; the preview's 2,000 is July's budget figure (rule 28)
    // and must not be written back into the default by the link.
    membersData = [
      { id: 'm1', name: 'Alex', netMonthlyIncome: 3000, personalSavingsAccountId: 'accC', displayOrder: 0, isArchived: false, incomeSharePct: 0.6 },
      { id: 'm2', name: 'Robin', netMonthlyIncome: 1750, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.4 },
    ]
    mockPut.mockImplementation(() => {
      // Once the link lands the next preview shows Robin linked — the warning must clear.
      previewData = mkPreview({
        pool: 5000, env: 2000, jars: 500, pocketTotal: 200, pocketEach: 100, savingsTotal: 2300,
        members: [
          { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1150, savingsBalance: 1000, savingsAccountId: 'accC' },
          { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1150, savingsBalance: 0, savingsAccountId: 'accRobinSav' },
        ],
      })
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    // A unique name match offers the one-click chip — offer-only, nothing links without a click.
    expect(screen.getByRole('button', { name: 'Use “Robin Savings”' })).toBeInTheDocument()

    // The picker sorts savings-type first and labels types.
    const picker = screen.getByLabelText('Savings account for Robin') as HTMLSelectElement
    const optionLabels = Array.from(picker.options).map((o) => o.textContent)
    expect(optionLabels[1]).toBe('Robin Savings — Savings')

    await user.selectOptions(picker, 'accRobinSav')
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/members/m2', {
        name: 'Robin',
        netMonthlyIncome: 1750, // the saved default, unchanged — not the preview's 2,000
        personalSavingsAccountId: 'accRobinSav',
      }),
    )
    expect(mockPut).not.toHaveBeenCalledWith('/members/m2', expect.objectContaining({ netMonthlyIncome: 2000 }))
    // The preview reloaded and the warning cleared.
    await waitFor(() =>
      expect(screen.queryByText(/No savings account linked/)).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
  })

  it('ALLOC-065: no suggestion chip when the name match is ambiguous', async () => {
    profileData = profile()
    accountsData = [
      ...defaultAccounts(),
      { id: 'accR1', name: 'Robin Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 2 },
      { id: 'accR2', name: 'Robin Savings 2', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 3 },
    ]
    previewData = mkPreview({
      pool: 5000, env: 2000, jars: 500, pocketTotal: 0, savingsTotal: 2500,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1250, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1250, savingsBalance: 0, savingsAccountId: null },
      ],
    })

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.queryByRole('button', { name: /^Use “/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Savings account for Robin')).toBeInTheDocument()
  })

  it('ALLOC-066: a Limited user sees the ask-an-admin copy, no picker, and can still allocate', async () => {
    localStorage.setItem('zbb.role', '2') // Limited → canEnterData true, canWrite false
    profileData = profile()
    accountsData = [
      ...defaultAccounts(),
      { id: 'accRobinSav', name: 'Robin Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 2 },
    ]
    previewData = mkPreview({
      pool: 5000, env: 2000, jars: 500, pocketTotal: 0, savingsTotal: 2500,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1250, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1250, savingsBalance: 0, savingsAccountId: null },
      ],
    })

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByText(/Ask an admin to link one on the People page/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Savings account for Robin')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toBeInTheDocument()
  })

  it('ALLOC-067: allocating with a stranded share needs an explicit confirm; the banner names it', async () => {
    profileData = profile()
    previewData = mkPreview({
      pool: 5000, env: 2000, jars: 500, pocketTotal: 0, savingsTotal: 2500,
      transfersCreated: 1,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1250, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1250, savingsBalance: 0, savingsAccountId: null },
      ],
    })
    mockPost.mockResolvedValue({ data: previewData })
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    // The record modal names the stranded share; nothing is sent until confirmed.
    await user.click(screen.getByRole('button', { name: 'Commit allocation' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText(/€1,250\.00 will stay in Joint because Robin has no savings account linked/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // Cancel aborts entirely.
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(mockPost).not.toHaveBeenCalled()

    // Confirming records the transfers, and the success banner repeats where the money stayed.
    await user.click(screen.getByRole('button', { name: 'Commit allocation' }))
    const dialog2 = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog2.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog2.getByRole('button', { name: 'Confirm allocation' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/€1,250\.00 stayed in Joint for Robin/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // ---- Budget ↔ engine reconciliation (pocket-money coherence) ---------------

  /** A real BudgetMonthDto for GET /budget/2026/7: income 3,000 by default; envelopes + optional flagged pocket. */
  function budgetDto(opts: { envelopes: number; jars?: number; income?: number; pocket?: { planned: number; flagged: boolean } }) {
    const { envelopes, jars = 500, income = 3000, pocket } = opts
    const categories = [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: income, totalActual: 0,
        items: [{ id: 'pay', name: 'Pay', displayOrder: 0, plannedAmount: income, actualAmount: 0, remaining: income }],
      },
      {
        id: 'liv', name: 'Living', kind: 'Expense', displayOrder: 0, totalPlanned: envelopes, totalActual: 0,
        items: [{ id: 'rent', name: 'Rent', displayOrder: 0, plannedAmount: envelopes, actualAmount: 0, remaining: envelopes }],
      },
      {
        id: 'sav', name: 'Jars', kind: 'Savings', displayOrder: 1, totalPlanned: jars, totalActual: 0,
        items: [{ id: 'jar', name: 'Emergency', displayOrder: 0, plannedAmount: jars, actualAmount: 0, remaining: jars }],
      },
    ]
    if (pocket) {
      categories.push({
        id: 'pm', name: 'Pocket Money', kind: 'Expense', displayOrder: 2, totalPlanned: pocket.planned, totalActual: 0,
        // @ts-expect-error — the flag is optional on the wire type; present here.
        excludeFromAllocation: pocket.flagged,
        items: [
          { id: 'pm1', name: 'Alex', displayOrder: 0, plannedAmount: pocket.planned / 2, actualAmount: 0, remaining: pocket.planned / 2 },
          { id: 'pm2', name: 'Robin', displayOrder: 1, plannedAmount: pocket.planned / 2, actualAmount: 0, remaining: pocket.planned / 2 },
        ],
      })
    }
    return { id: 'bm1', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR', totalIncome: income, totalPlanned: 0, remainingToBudget: 0, isBalanced: false, categories }
  }

  /** The tester's scenario: pool 3,000 fully budgeted, pocket 250×2 only in the engine. */
  function overshootPreview() {
    return mkPreview({
      pool: 3000, env: 2500, jars: 500, pocketTotal: 500, pocketEach: 250, savingsTotal: -500,
      members: [
        { memberId: 'm1', name: 'Alex', netIncome: 1500, residual: -250, savingsBalance: 1000, savingsAccountId: 'accC' },
        { memberId: 'm2', name: 'Robin', netIncome: 1500, residual: -250, savingsBalance: 500, savingsAccountId: 'accR' },
      ],
    })
  }

  it('ALLOC-068: engine-only pocket money on a balanced budget shows the disagree banner; the CTA syncs', async () => {
    profileData = profile()
    currentBudget = budgetDto({ envelopes: 2500 }) // income 3,000 = 2,500 + 500 → remaining 0
    previewData = overshootPreview()
    mockPost.mockImplementation((url: string) => {
      if (url.startsWith('/allocation/pocket-lines/')) {
        // The server reshaped the month: envelopes trimmed, pocket materialized + flagged.
        previewData = mkPreview({
          pool: 3000, env: 2000, jars: 500, pocketTotal: 500, pocketEach: 250, savingsTotal: 0,
          members: [
            { memberId: 'm1', name: 'Alex', netIncome: 1500, residual: 0, savingsBalance: 1000, savingsAccountId: 'accC' },
            { memberId: 'm2', name: 'Robin', netIncome: 1500, residual: 0, savingsBalance: 500, savingsAccountId: 'accR' },
          ],
        })
        return Promise.resolve({ data: budgetDto({ envelopes: 2000, pocket: { planned: 500, flagged: true } }) })
      }
      return Promise.resolve({ data: previewData })
    })
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    // R (0) < U (500): the honest disagree copy, with the overage named.
    expect(screen.getByText(/Your budget and your allocation disagree/)).toBeInTheDocument()
    expect(screen.getByText(/€500\.00 in pocket money/)).toBeInTheDocument()
    expect(screen.getByText(/€500\.00 more than your income covers/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: "Add pocket money to July's budget" }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/allocation/pocket-lines/2026/7', {}), { timeout: 5000 })
    // Banner clears (flagged lines now cover the promise) and a status confirms.
    await waitFor(
      () => expect(screen.queryByText(/Your budget and your allocation disagree/)).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.getByText(/Pocket money added to July’s budget\./)).toBeInTheDocument()
  })

  it('ALLOC-069: an unflagged Pocket Money category plus the rule shows the counted-twice banner', async () => {
    profileData = profile()
    currentBudget = budgetDto({ envelopes: 2000, pocket: { planned: 500, flagged: false } })
    previewData = overshootPreview()

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByText(/Pocket money is currently counted twice/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Add pocket money to July's budget" })).toBeInTheDocument()
  })

  it('ALLOC-070: a negative To savings reads as a shortfall — tile, footer and commit copy', async () => {
    profileData = profile()
    currentBudget = budgetDto({ envelopes: 2500 })
    previewData = overshootPreview()
    mockPost.mockImplementation((url: string) =>
      url.startsWith('/allocation/commit/')
        ? Promise.resolve({ data: overshootPreview() })
        : Promise.resolve({ data: previewData }),
    )
    const user = userEvent.setup()

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(heroTileValue('To savings')).toBe(-500)
    expect(screen.getByText(/overshoot the pooled income by €500\.00 — pocket money can’t be funded/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Commit allocation' }))
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))
    expect(
      await screen.findByText(/Allocated July — nothing was transferred because shared spending overshoots the pooled income\./, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
  })

  // ALLOC-071 (rewritten for rule 28) — the pool and the budget's income lines come from the same
  // budget, so a mismatch (a stale read) is named as such; nothing claims a People-page source.
  it('ALLOC-071: a pool that differs from the budgeted income gets a stale-read note, not a People-page source', async () => {
    profileData = profile()
    currentBudget = budgetDto({ envelopes: 2000 }) // budget income 3,000
    previewData = workedPreview() // pool 5,000 — read before the budget was edited

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByText(/pooled income here \(€5,000\.00\) doesn’t match July’s budgeted income lines \(€3,000\.00\)/)).toBeInTheDocument()
    expect(screen.queryByText(/People page/)).not.toBeInTheDocument()
  })

  // ---- Commit flow ----------------------------------------------------------

  it('ALLOC-048: a read-only user never sees the Allocate button', async () => {
    localStorage.setItem('zbb.role', '3') // ReadOnly → canEnterData false
    profileData = profile()

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Commit allocation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allocation settings' })).not.toBeInTheDocument()
  })

  it('ALLOC-051: a zero-transfer commit shows the "no transfers needed" banner', async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: workedPreview(0) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/7', expect.objectContaining({ confirmedCompleted: true, receivedOn: null })),
      { timeout: 5000 },
    )
    expect(await screen.findByText(/no savings transfers were needed this month/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('ALLOC-053: a commit failure surfaces the actionable error banner', async () => {
    profileData = profile()
    mockPost.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))

    expect(await screen.findByText(/Could not record the allocation/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // ---- Additional high-value gaps (P0/P1/cheap) not covered above or by the sibling file -----

  it('ALLOC-018: saving a new profile writes the standard four-rule waterfall (types/orders/splits)', async () => {
    profileData = null
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    // Pick Joint; leave pocket blank (→0), split Equally, savings Balance, lean 25 — all defaults.
    await user.selectOptions(dialog.getByLabelText('Source account'), 'accJoint')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const body = mockPut.mock.calls[0][1] as {
      id: string | null
      name: string
      sourceAccountId: string
      balanceLeanPercent: number
      rules: { order: number; type: number; split: number; fixedAmountPerMember: number }[]
    }
    // A brand-new profile carries a null id and the client's canonical name.
    expect(body.id).toBeNull()
    expect(body.name).toBe('Household allocation')
    expect(body.sourceAccountId).toBe('accJoint')
    expect(body.balanceLeanPercent).toBe(25)
    // Exactly the four rules, in order: FundEnvelopes(0)/FundJars(1)/FixedPerMember(2)/SplitRemainder(3).
    expect(body.rules).toHaveLength(4)
    expect(body.rules.map((r) => r.type)).toEqual([0, 1, 2, 3])
    expect(body.rules.map((r) => r.order)).toEqual([0, 1, 2, 3])
    // Cost rules default to Equal (0); pocket rule is Equal with amount 0; terminal rule is BalanceTilt (2).
    expect(body.rules[0].split).toBe(0)
    expect(body.rules[1].split).toBe(0)
    expect(body.rules[2].split).toBe(0)
    expect(body.rules[2].fixedAmountPerMember).toBe(0)
    expect(body.rules[3].split).toBe(2)
  })

  it('ALLOC-050: a single-transfer commit shows the singular banner and swaps in the committed result', async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: workedPreview(1) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/7', { departedOn: expect.any(String), receivedOn: null, confirmedCompleted: true }),
      { timeout: 5000 },
    )
    // committed === 1 takes the singular branch: "1 savings transfer recorded" (no plural s).
    const banner = await screen.findByRole('status', {}, { timeout: 5000 })
    expect(banner).toHaveTextContent(
      'Allocated July — 1 savings transfer recorded as in transit; confirm each receipt on the Transactions page. Re-running Allocate keeps unchanged transfers, never doubles up.',
    )
  })

  it('ALLOC-048: the Allocate button is disabled while a commit request is in flight', async () => {
    profileData = profile()
    // A commit promise we resolve by hand so we can observe the mid-request disabled state.
    let resolveCommit!: (v: { data: AllocationResultDto }) => void
    mockPost.mockReturnValue(new Promise<{ data: AllocationResultDto }>((res) => { resolveCommit = res }))
    const user = userEvent.setup()

    renderPage()

    const btn = await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 })
    expect(btn).toBeEnabled()

    await user.click(btn)
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByLabelText('Allocation completed confirmation'))
    await user.click(screen.getByRole('button', { name: 'Confirm allocation' }))
    // commit() flips busy=true synchronously before awaiting the POST → the button disables.
    await waitFor(() => expect(btn).toBeDisabled(), { timeout: 5000 })

    resolveCommit({ data: workedPreview(2) })
    // busy resets in finally → the button re-enables once the request settles.
    await waitFor(() => expect(btn).toBeEnabled(), { timeout: 5000 })
  })

  it('ALLOC-035: only the terminal "Split remainder to savings" row gets the highlighted treatment', async () => {
    profileData = profile()
    previewData = workedPreview()

    renderPage()

    await screen.findByText('How July is allocated', {}, { timeout: 5000 })
    const terminalRow = screen.getByText('Split remainder to savings').closest('li')
    const costRow = screen.getByText('Cover shared costs').closest('li')
    // The terminal row carries the brand-tinted highlight; the plain rows do not.
    expect(terminalRow?.className).toContain('bg-brand-50')
    expect(costRow?.className).not.toContain('bg-brand-50')
  })

  it('ALLOC-017: the opaque controls are aria-labelled divs (InfoHint is a sibling, never the field control)', async () => {
    profileData = null
    const user = userEvent.setup()

    renderPage()
    const dialog = await openSetupModal(user)

    // "Pocket money (each)" is the ONE real <label> wrapping its Input, so its visible text is a
    // label association reaching the same node as the field's own aria-label.
    expect(dialog.getByLabelText('Pocket money (each)')).toBe(dialog.getByLabelText('Pocket money per member'))

    // The opaque controls use <div> + aria-label (NOT <label>), so their visible text is not a label
    // association — only the control's own aria-label reaches it, never the nested InfoHint button.
    expect(dialog.queryByLabelText('Split shared costs')).toBeNull()
    expect(dialog.queryByLabelText('Send savings to')).toBeNull()
    expect(dialog.getByRole('group', { name: 'Split method' })).toBeInTheDocument()

    // The InfoHint is its own separately-named button; activating it must not touch the split choice.
    const splitGroup = within(dialog.getByRole('group', { name: 'Split method' }))
    await user.click(dialog.getByRole('button', { name: 'About splitting shared costs' }))
    expect(splitGroup.getByRole('button', { name: 'Equally' })).toHaveAttribute('aria-pressed', 'true')
  })

  // ---- Income-per-person switchover (the pool's source honesty) --------------

  it('ALLOC-072: unattributed budget income shows the assign-it banner with the amount', async () => {
    profileData = profile()
    previewData = { ...workedPreview(), incomeFromBudget: true, unattributedIncome: 350 }

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByText(/€350\.00 of July’s income isn’t assigned to a person/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign income lines on the Budget page' })).toBeInTheDocument()
    // A month with income is quiet about missing income, and nothing mentions People-page defaults.
    expect(screen.queryByText(/No income in July 2026’s budget yet/)).not.toBeInTheDocument()
    expect(screen.queryByText(/default incomes from the People page/)).not.toBeInTheDocument()
  })

  // ALLOC-073 (rewritten for rule 28) — there is no People-page fallback any more: a month whose
  // budget has no income lines has a pool of 0 and the page says to add income lines to the Budget.
  it('ALLOC-073: a month with no income in its budget shows the add-income notice, never a People-page fallback', async () => {
    profileData = profile()
    currentBudget = budgetDto({ envelopes: 0, jars: 0, income: 0 }) // the budget exists; its income lines total 0
    previewData = {
      ...mkPreview({
        pool: 0, env: 0, jars: 0, pocketTotal: 0, savingsTotal: 0,
        members: [
          { memberId: 'm1', name: 'Alex', netIncome: 0, residual: 0, savingsBalance: 1000, savingsAccountId: 'accC' },
          { memberId: 'm2', name: 'Robin', netIncome: 0, residual: 0, savingsBalance: 500, savingsAccountId: 'accR' },
        ],
      }),
      incomeFromBudget: true,
      unattributedIncome: 0,
    }

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByRole('status')).toHaveTextContent(
      'No income in July 2026’s budget yet. Add income lines to the Budget (attribute them to people for a by-income split) and come back.',
    )
    expect(screen.getByRole('button', { name: 'Open the Budget' })).toBeInTheDocument()
    expect(screen.queryByText(/default incomes from the People page/)).not.toBeInTheDocument()
    expect(screen.queryByText(/isn’t assigned to a person/)).not.toBeInTheDocument()
  })

  it('ALLOC-074: a month with no budget at all shows the same add-income notice', async () => {
    profileData = profile()
    currentBudget = null // GET /budget/2026/7 → 404
    previewData = {
      ...mkPreview({
        pool: 0, env: 0, jars: 0, pocketTotal: 0, savingsTotal: 0,
        members: [
          { memberId: 'm1', name: 'Alex', netIncome: 0, residual: 0, savingsBalance: 1000, savingsAccountId: 'accC' },
          { memberId: 'm2', name: 'Robin', netIncome: 0, residual: 0, savingsBalance: 500, savingsAccountId: 'accR' },
        ],
      }),
      incomeFromBudget: true,
      unattributedIncome: 0,
    }

    renderPage()
    await screen.findByText('How July is allocated', {}, { timeout: 5000 })

    expect(screen.getByText(/No income in July 2026’s budget yet/)).toBeInTheDocument()
    // The hero still renders honestly: nothing to allocate.
    expect(screen.getByLabelText(/^Income to allocate:/)).toHaveTextContent('€0.00')
  })
})
