// Catalog-driven People & Households tests (docs/testing/cases/16-people-households.md, prefix PPL).
// Converts the high-value P0/P1 (plus a few cheap P2/P3) cases whose Automated field is No/Partial
// and whose behaviour is observable in a jsdom component render: client-side add/edit validation,
// inline edit + cancel, single-click archive, the member<->login "Sign-in & access" cell (role
// chips, role select, Remove, invited badge, orphan-login card), invite-modal client validation,
// and the live solo<->shared gating flip driven by refreshHousehold().
//
// New file — does NOT touch PeoplePage.test.tsx. Conventions (vi.hoisted api mock with
// importOriginal spread, MemoryRouter + AuthProvider, jest-dom matchers) mirror that file.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type {
  AccountDto,
  HouseholdMemberDto,
  MemberArchivePreviewDto,
  MemberIncomeResultDto,
  MemberSpendingDto,
  MembershipDto,
} from '../types'
import { formatMoney, fromAmount } from '../lib/money'

const { mockGet, mockPost, mockPut, mockDelete, monthState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  // The app-wide selected month the page reads (rule 29). Mutable so a case can move it and
  // rerender; reset to July 2026 in beforeEach.
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))

// The selected month comes from MonthContext; pin it so the assertions are clock-independent.
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockPut, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { PeoplePage } from './PeoplePage'
import { AuthProvider } from '../auth/AuthContext'
import { HouseholdProvider } from '../features/HouseholdContext'

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return {
    id: 'm1',
    name: 'Alex',
    netMonthlyIncome: 3000,
    // The month's budget figure (rule 28); equal to the default unless a case says otherwise.
    budgetIncome: 3000,
    hasBudget: true,
    personalSavingsAccountId: null,
    displayOrder: 0,
    isArchived: false,
    incomeSharePct: 1,
    ...over,
  }
}

function membership(over: Partial<MembershipDto> = {}): MembershipDto {
  return {
    id: 'mem1',
    email: 'alex@x.eu',
    displayName: 'Alex',
    role: 0,
    status: 0,
    memberId: 'm1',
    isOwner: true,
    isSelf: true,
    createdUtc: '2026-01-01',
    ...over,
  }
}

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 'a1',
    name: 'Joint',
    type: 0,
    currency: 'EUR',
    openingBalance: 0,
    currentBalance: 0,
    displayOrder: 0,
    ...over,
  }
}

// Module-level fixtures the GET mock reads; reset in beforeEach.
let membersData: HouseholdMemberDto[] = []
let membershipsData: MembershipDto[] = []
let accountsData: AccountDto[] = []
let meData: Record<string, unknown> = {} // /auth/me — {} keeps the default Owner role.
let spendingData: MemberSpendingDto[] = []
let incomeData: MemberIncomeResultDto | null = null
// Rule 54: what GET /members/{id}/archive-preview answers, keyed by member id (unset → `{}`,
// i.e. nothing to ask, the single-click archive of PPL-022).
let archivePreviews: Record<string, MemberArchivePreviewDto> = {}

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    // Month-scoped reads carry the selected month (rule 29); the bare /members is the
    // HouseholdProvider's own read.
    if (url === `/members?year=${monthState.year}&month=${monthState.month}` || url === '/members') {
      return Promise.resolve({ data: membersData })
    }
    if (url === '/access/members') return Promise.resolve({ data: membershipsData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === `/members/spending/${monthState.year}/${monthState.month}`) return Promise.resolve({ data: spendingData })
    if (url === `/members/income/${monthState.year}/${monthState.month}`) {
      return incomeData ? Promise.resolve({ data: incomeData }) : Promise.reject(new Error('404'))
    }
    if (url === '/auth/me') return Promise.resolve({ data: meData })
    const preview = /^\/members\/([^/]+)\/archive-preview$/.exec(url)
    if (preview && archivePreviews[preview[1]]) return Promise.resolve({ data: archivePreviews[preview[1]] })
    return Promise.resolve({ data: {} }) // TopBar / everything else — tolerated as empty
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <PeoplePage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// Wraps the page in a real HouseholdProvider so useHousehold().isShared reflects the
// live member list — needed to observe the Allocation nav appearing/disappearing.
function renderPageWithHousehold() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HouseholdProvider>
          <PeoplePage />
        </HouseholdProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('PeoplePage — catalog (PPL)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    mockPut.mockReset()
    mockDelete.mockReset()
    mockPost.mockResolvedValue({ data: {} })
    mockPut.mockResolvedValue({ data: {} })
    mockDelete.mockResolvedValue({ data: {} })
    membersData = []
    membershipsData = []
    accountsData = []
    meData = {}
    spendingData = []
    incomeData = null
    archivePreviews = {}
    monthState.year = 2026
    monthState.month = 7
    monthState.label = 'July 2026'
    setupGet()
  })

  // PPL-001 (rewritten for rule 28) — the hero is the month's BUDGET income (each member's
  // budgetIncome), never the saved defaults; rows show the budget-based share and the "You" sub-label.
  it('PPL-001: hero sums the month\'s budget income (not the defaults) and rows show share + "You"', { timeout: 15000 }, async () => {
    membersData = [
      // Defaults 9,000 + 9,000 would read €18,000.00 — the hero must show the budget's 4,000.
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 9000, budgetIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 9000, budgetIncome: 1000, incomeSharePct: 0.25 }),
    ]
    membershipsData = [membership()] // Alex is the current login (isSelf), linked to m1

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    const budgeted = formatMoney(fromAmount(3000) + fromAmount(1000), 'EUR')
    expect(budgeted).toBe('€4,000.00')
    expect(screen.getByText('Income this month')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('€4,000.00')
    expect(screen.queryByText('€18,000.00')).not.toBeInTheDocument()
    expect(screen.queryByText('Combined income')).not.toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  // PPL-073 — every active member income 0: combined €0.00, all shares 0% (no divide-by-zero / NaN).
  it('PPL-073: all-zero incomes render €0.00 combined and 0% shares (no NaN)', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 0, budgetIncome: 0, incomeSharePct: 0 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 0, budgetIncome: 0, incomeSharePct: 0 }),
    ]

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    // €0.00 shows in the hero, the "Shared this month" tile and each income column — all zero.
    expect(screen.getAllByText('€0.00').length).toBeGreaterThan(0)
    const zeros = screen.getAllByText('0%')
    expect(zeros).toHaveLength(2)
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument()
  })

  // PPL-011 — empty name is rejected client-side with an in-modal banner; no POST.
  it('PPL-011: add-person with an empty name shows "Give the person a name." and does not POST', { timeout: 15000 }, async () => {
    membersData = [member()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Default income'), '100')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    expect(await dialog.findByText('Give the person a name.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // PPL-012 — a whitespace-only name trims to empty and is rejected the same way; no POST.
  it('PPL-012: add-person with a whitespace-only name is rejected client-side', { timeout: 15000 }, async () => {
    membersData = [member()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), '   ')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    expect(await dialog.findByText('Give the person a name.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // PPL-013 — non-numeric, negative and malformed incomes are each rejected; never POSTed.
  it('PPL-013: add-person rejects "abc", "-5" and "1.2.3" incomes with the same message', { timeout: 15000 }, async () => {
    membersData = [member()]
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Sam')
    const incomeInput = dialog.getByLabelText('Default income')

    for (const bad of ['abc', '-5', '1.2.3']) {
      await user.clear(incomeInput)
      await user.type(incomeInput, bad)
      await user.click(dialog.getByRole('button', { name: 'Add person' }))
      expect(await dialog.findByText('Enter a valid monthly income.', {}, { timeout: 5000 })).toBeInTheDocument()
    }
    expect(mockPost).not.toHaveBeenCalled()
  })

  // PPL-014 — a blank income defaults to 0 and the person is created with netMonthlyIncome:0.
  it('PPL-014: add-person with a blank income posts netMonthlyIncome:0', { timeout: 15000 }, async () => {
    membersData = [member()]
    mockPost.mockResolvedValue({ data: member({ id: 'm9', name: 'Sam' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Sam')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/members',
          expect.objectContaining({ name: 'Sam', netMonthlyIncome: 0 }),
        ),
      { timeout: 5000 },
    )
  })

  // PPL-009 — when accounts exist the "Savings account" select renders and its id rides the POST.
  it('PPL-009: add-person with a personal savings account posts personalSavingsAccountId', { timeout: 15000 }, async () => {
    membersData = [member()]
    accountsData = [account({ id: 'a1', name: 'Joint' })]
    mockPost.mockResolvedValue({ data: member({ id: 'm9', name: 'Sam' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Sam')
    await user.type(dialog.getByLabelText('Default income'), '500')
    await user.selectOptions(dialog.getByLabelText('Savings account'), 'a1')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/members',
          expect.objectContaining({ name: 'Sam', netMonthlyIncome: 500, personalSavingsAccountId: 'a1' }),
        ),
      { timeout: 5000 },
    )
  })

  // PPL-010 — with no accounts the "Savings account" field is not rendered at all.
  it('PPL-010: add-person hides the Savings account select when no accounts exist', { timeout: 15000 }, async () => {
    membersData = [member()]
    accountsData = []
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Person name')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Savings account')).not.toBeInTheDocument()
  })

  // PPL-017 — a Limited member sees no "+ Add person" button, but the table still renders.
  it('PPL-017: "+ Add person" is hidden for a non-writer (Limited) while the table stays visible', { timeout: 15000 }, async () => {
    membersData = [member()]
    meData = { role: 2 } // Limited

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.getByText('Alex')).toBeInTheDocument()
  })

  // PPL-018 — inline edit rewrites name/income/savings via PUT /members/{id} with the new values.
  it('PPL-018: inline edit saves name, income and savings account via PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 })]
    accountsData = [account({ id: 'a1', name: 'Joint' })]
    mockPut.mockResolvedValue({ data: member({ id: 'm2', name: 'Sam M' }) })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Sam' }))

    const nameInput = screen.getByLabelText('Name for Sam')
    const incomeInput = screen.getByLabelText('Default income for Sam')
    await user.clear(nameInput)
    await user.type(nameInput, 'Sam M')
    await user.clear(incomeInput)
    await user.type(incomeInput, '1200')
    await user.selectOptions(screen.getByLabelText('Savings account for Sam'), 'a1')

    // Determinism: wait until the controlled inputs actually hold the new values before saving.
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toBe('Sam M'), { timeout: 5000 })
    await waitFor(() => expect((incomeInput as HTMLInputElement).value).toBe('1200'), { timeout: 5000 })

    await user.click(screen.getByRole('button', { name: 'Save Sam' }))

    await waitFor(
      () =>
        expect(mockPut).toHaveBeenCalledWith(
          '/members/m2',
          expect.objectContaining({ name: 'Sam M', netMonthlyIncome: 1200, personalSavingsAccountId: 'a1' }),
        ),
      { timeout: 5000 },
    )
  })

  // PPL-019 — Cancel leaves display mode with the original values and sends no PUT.
  it('PPL-019: cancelling an inline edit discards changes and does not PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 })]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Sam' }))
    const nameInput = screen.getByLabelText('Name for Sam')
    await user.clear(nameInput)
    await user.type(nameInput, 'Changed')
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))

    await waitFor(() => expect(screen.queryByLabelText('Name for Sam')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText('Sam')).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // PPL-020 — inline edit validation mirrors add: empty name, then bad income; no PUT until valid.
  it('PPL-020: inline edit validation rejects empty name then bad income without PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 })]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Sam' }))

    const nameInput = screen.getByLabelText('Name for Sam')
    await user.clear(nameInput)
    await user.click(screen.getByRole('button', { name: 'Save Sam' }))
    expect(await screen.findByText('Give the person a name.', {}, { timeout: 5000 })).toBeInTheDocument()

    await user.type(nameInput, 'Sam')
    const incomeInput = screen.getByLabelText('Default income for Sam')
    await user.clear(incomeInput)
    await user.type(incomeInput, 'abc')
    await user.click(screen.getByRole('button', { name: 'Save Sam' }))
    expect(await screen.findByText('Enter a valid monthly income.', {}, { timeout: 5000 })).toBeInTheDocument()

    expect(mockPut).not.toHaveBeenCalled()
  })

  // PPL-022 / PPL-023 — a single "✕" click archives immediately (no confirm dialog) when the
  // archive preview has no pocket money to ask about; the row leaves the table and the
  // month-income hero recomputes on reload. (Transaction-persistence half of PPL-023 is
  // backend-only — see the deferred note.)
  it('PPL-022/PPL-023: archiving fires PUT {archived:true} on one click and removes the row', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 }),
    ]
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        membersData = [member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 1 })]
        return Promise.resolve({ data: {} })
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('€4,000.00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))

    // No confirmation modal — the archive fired directly.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true }),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.queryByText('Sam')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('€4,000.00')).not.toBeInTheDocument()
  })

  // ---- Archiving and pocket money (rule 54) -------------------------------------

  const twoMembers = () => [
    member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 0.75 }),
    member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 }),
  ]

  // PPL-084 — pocket money still planned this month: the ✕ opens the keep-or-cancel question
  // (nothing is archived yet); "Keep this month" archives with the Keep decision.
  it('PPL-084: pocket money left this month asks keep-or-cancel; Keep archives with decision 0', { timeout: 15000 }, async () => {
    membersData = twoMembers()
    archivePreviews = {
      m2: {
        id: 'm2',
        name: 'Sam',
        isArchived: false,
        thisMonth: { year: 2026, month: 9, planned: 100, paid: 60, remaining: 40 },
        futureMonths: [{ year: 2026, month: 10, planned: 100, paid: 0, remaining: 100 }],
      },
    }
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        membersData = [member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 1 })]
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('Archive Sam')).toBeInTheDocument()
    // The remaining amount, the month and what was paid so far, in words the user can act on.
    expect(dialog.getByText('€40.00')).toBeInTheDocument()
    expect(dialog.getByText(/planned for September 2026 \(€60\.00 already paid\)/)).toBeInTheDocument()
    expect(dialog.getByText(/already planned for October 2026 is cancelled/)).toBeInTheDocument()
    // Nothing archived until a choice is made.
    expect(mockPut).not.toHaveBeenCalled()

    await user.click(dialog.getByRole('button', { name: 'Keep this month’s pocket money and archive' }))

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true, pocketMoneyThisMonth: 0 }),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.queryByText('Sam')).not.toBeInTheDocument(), { timeout: 5000 })
  })

  // PPL-085 — "Cancel remaining" archives with the Cancel decision (1); the server drops the
  // planned amount to what was paid, so the dialog says the payments stay.
  it('PPL-085: "Cancel remaining" archives with decision 1 and says payments stay recorded', { timeout: 15000 }, async () => {
    membersData = twoMembers()
    archivePreviews = {
      m2: {
        id: 'm2',
        name: 'Sam',
        isArchived: false,
        thisMonth: { year: 2026, month: 9, planned: 100, paid: 0, remaining: 100 },
        futureMonths: [],
      },
    }
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))

    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByText('€100.00')).toBeInTheDocument()
    expect(dialog.queryByText(/already paid/)).not.toBeInTheDocument()
    expect(dialog.getByText(/payments stay recorded, and no pocket money is planned from next month on\./)).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Cancel remaining pocket money and archive' }))

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true, pocketMoneyThisMonth: 1 }),
      { timeout: 5000 },
    )
    expect(mockPut).toHaveBeenCalledTimes(1)
  })

  // PPL-086 — "Don't archive" closes the question and nothing is sent; a preview with nothing
  // remaining (this month fully paid) never asks and archives on the one click as PPL-022.
  it('PPL-086: "Don’t archive" sends nothing; a fully paid month archives without asking', { timeout: 15000 }, async () => {
    membersData = twoMembers()
    archivePreviews = {
      m2: {
        id: 'm2',
        name: 'Sam',
        isArchived: false,
        thisMonth: { year: 2026, month: 9, planned: 100, paid: 0, remaining: 100 },
        futureMonths: [],
      },
    }
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Don’t archive' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(mockPut).not.toHaveBeenCalled()
    expect(screen.getByText('Sam')).toBeInTheDocument()

    // Fully paid: remaining 0 → no question, the plain archive request.
    archivePreviews.m2.thisMonth = { year: 2026, month: 9, planned: 100, paid: 100, remaining: 0 }
    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))
    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true }),
      { timeout: 5000 },
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // PPL-087 — the server's own refusal (400, a decision was needed after all) is shown in the
  // page's words, not swallowed into the generic failure.
  it('PPL-087: a 400 from the archive shows the server’s field message', { timeout: 15000 }, async () => {
    membersData = twoMembers()
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        return Promise.reject({
          response: {
            status: 400,
            data: { errors: { PocketMoneyThisMonth: ['Sam still has 40.00 of pocket money planned for September 2026. Choose whether to keep or cancel it before archiving.'] } },
          },
        })
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))

    expect(await screen.findByText(/Sam still has 40\.00 of pocket money planned for September 2026/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText('Could not archive that person.')).not.toBeInTheDocument()
    expect(screen.getByText('Sam')).toBeInTheDocument()
  })

  // PPL-026 — a Limited member gets no edit/archive hover actions.
  it('PPL-026: edit and archive row actions are hidden for a non-writer (Limited)', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam' })]
    meData = { role: 2 } // Limited

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'Archive Sam' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.queryByRole('button', { name: 'Edit Sam' })).not.toBeInTheDocument()
    expect(screen.getByText('Sam')).toBeInTheDocument()
  })

  // PPL-034 / PPL-037 — a linked non-owner login shows a role <select> + Remove; the owner shows a
  // static role Badge with no select and no Remove (owner sign-in is immovable in the UI).
  it('PPL-034/PPL-037: linked member shows role select + Remove; owner shows a Badge only', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex' }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 }),
    ]
    membershipsData = [
      membership(), // Alex: owner + self
      membership({ id: 'mem2', email: 'sam@x.eu', displayName: 'Sam', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })

    // Sam (Active, Admin) — editable role select with exactly Admin/Limited/Read-only + Remove.
    const roleSelect = screen.getByLabelText('Access level for Sam')
    const options = within(roleSelect).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Admin', 'Limited', 'Read-only'])
    expect(within(roleSelect).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove sign-in for Sam' })).toBeInTheDocument()
    expect(screen.getByText('sam@x.eu')).toBeInTheDocument()

    // Alex (owner + self) — a role Badge, no select, no Remove.
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.queryByLabelText('Access level for Alex')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove sign-in for Alex' })).not.toBeInTheDocument()
  })

  // PPL-035 — choosing a new role fires PUT /access/members/{id}/role {role:<n>}.
  it('PPL-035: changing a member role PUTs the numeric role', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Alex' }), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.25 })]
    membershipsData = [
      membership(),
      membership({ id: 'mem2', email: 'sam@x.eu', displayName: 'Sam', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.selectOptions(screen.getByLabelText('Access level for Sam'), 'Limited')

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/access/members/mem2/role', { role: 2 }),
      { timeout: 5000 },
    )
  })

  // PPL-036 — Remove hard-deletes the membership via DELETE /access/members/{id}.
  it('PPL-036: removing a sign-in DELETEs the membership', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Alex' }), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.25 })]
    membershipsData = [
      membership(),
      membership({ id: 'mem2', email: 'sam@x.eu', displayName: 'Sam', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Remove sign-in for Sam' }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/access/members/mem2'), { timeout: 5000 })
  })

  // PPL-038 — a pending (Status=Invited) login shows the amber "Invited" badge and still exposes the
  // owner's role select + Remove on that row.
  it('PPL-038: an invited (pending) login shows the amber "Invited" badge plus role/Remove controls', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Alex' }), member({ id: 'm2', name: 'Robin', incomeSharePct: 0.25 })]
    membershipsData = [
      membership(),
      membership({ id: 'mem2', email: 'robin@x.eu', displayName: 'Robin', role: 1, status: 1, memberId: 'm2', isOwner: false, isSelf: false }),
    ]

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('Invited')).toBeInTheDocument()
    expect(screen.getByLabelText('Access level for Robin')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove sign-in for Robin' })).toBeInTheDocument()
  })

  // PPL-040 — an Admin (canWrite but not canManageHousehold ⇒ canAccess=false) sees static "No
  // sign-in", no invite pill, but keeps the table and the "+ Add person" button.
  it('PPL-040: an Admin sees "No sign-in" and no invite pill, but keeps Add person', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Robin', incomeSharePct: 1 })]
    membershipsData = []
    meData = { role: 1 } // Admin — canWrite, not canManageHousehold

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await waitFor(() => expect(screen.getByText('No sign-in')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Invite to sign in' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add person' })).toBeInTheDocument()
  })

  // PPL-041 — the "Other sign-ins" card lists an orphan login (memberId=null, isSelf=false) with a
  // status badge, a role badge, a "Link to a person…" select, and a Remove control.
  it('PPL-041: the "Other sign-ins" card lists orphan logins with link + remove', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Alex' }), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.5 })]
    membershipsData = [
      membership(), // Alex, linked to m1 (self/owner)
      membership({ id: 'mem9', email: 'robin@x.eu', displayName: 'Robin', role: 1, status: 0, memberId: null, isOwner: false, isSelf: false }),
    ]

    renderPage()

    // Two tables render (members + the orphan-login card), so wait on the card's heading instead.
    await screen.findByText('Other sign-ins', {}, { timeout: 5000 })
    expect(screen.getByText('Robin')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()

    const linkSelect = screen.getByLabelText('Link robin@x.eu to a person')
    // Only the unlinked person (Sam) is offered — Alex is already claimed.
    expect(within(linkSelect).getByRole('option', { name: 'Sam' })).toBeInTheDocument()
    expect(within(linkSelect).queryByRole('option', { name: 'Alex' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Robin' })).toBeInTheDocument()
  })

  // PPL-044 — the direct temp-password path posts method:Direct and surfaces the "Login created" box.
  it('PPL-044: a direct temp-password invite posts method Direct and shows "Login created"', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', incomeSharePct: 1 })]
    membershipsData = [] // Sam has no login → "Invite to sign in" pill
    mockPost.mockResolvedValue({ data: { membership: membership({ id: 'mem9', email: 'sam@x.eu' }), inviteToken: null } })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Invite to sign in' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    await user.type(dialog.getByLabelText('Invitee email'), 'sam@x.eu')
    await user.click(dialog.getByRole('button', { name: 'Set a temporary password' }))
    await user.type(dialog.getByLabelText('Temporary password'), 'Aa1-longpass')
    await user.click(dialog.getByRole('button', { name: 'Create login' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/access/invite',
          expect.objectContaining({ email: 'sam@x.eu', method: 0, tempPassword: 'Aa1-longpass' }),
        ),
      { timeout: 5000 },
    )
    expect(await dialog.findByText('Login created', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // PPL-045 — invite client-side guards: empty email, then a <8-char temp password; neither POSTs.
  it('PPL-045: invite rejects an empty email and a short temp password client-side', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', incomeSharePct: 1 })]
    membershipsData = []
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Invite to sign in' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    // (1) Empty email on the link method.
    await user.click(dialog.getByRole('button', { name: 'Create invite link' }))
    expect(await dialog.findByText('Enter an email address.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    // (2) Direct method with a valid email but a 5-char password.
    await user.type(dialog.getByLabelText('Invitee email'), 'sam@x.eu')
    await user.click(dialog.getByRole('button', { name: 'Set a temporary password' }))
    await user.type(dialog.getByLabelText('Temporary password'), '12345')
    await user.click(dialog.getByRole('button', { name: 'Create login' }))
    expect(
      await dialog.findByText('Set a temporary password of at least 8 characters.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // PPL-049 — the invite Access-level select never offers Owner, and the hint tracks the choice.
  it('PPL-049: invite Access level offers only Admin/Limited/Read-only and updates the hint', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Sam', incomeSharePct: 1 })]
    membershipsData = []
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Invite to sign in' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const accessSelect = dialog.getByLabelText('Access level')
    const options = within(accessSelect).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Admin', 'Limited', 'Read-only'])
    expect(within(accessSelect).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument()

    // Default Admin hint, then Limited hint after changing the select.
    expect(dialog.getByText('Everything except managing members and access.')).toBeInTheDocument()
    await user.selectOptions(accessSelect, 'Limited')
    expect(
      await dialog.findByText('Day-to-day entry: transactions, mark bills paid, run allocation.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
  })

  // PPL-030 — adding a 2nd member calls refreshHousehold(); isShared flips true live and the
  // "Allocation" nav item appears without a manual reload.
  it('PPL-030: adding a 2nd member flips solo→shared live (Allocation nav appears)', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 1 })]
    mockPost.mockImplementation((url: string) => {
      if (url === '/members') {
        membersData = [
          member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 0.75 }),
          member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 }),
        ]
        return Promise.resolve({ data: membersData[1] })
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPageWithHousehold()

    await screen.findByRole('table', {}, { timeout: 5000 })
    // Solo: no Allocation nav item yet.
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'Allocation' })).toHaveLength(0), { timeout: 5000 })

    await user.click(screen.getByRole('button', { name: 'Add person' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Sam')
    await user.type(dialog.getByLabelText('Default income'), '1000')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    // Shared: refreshHousehold() re-fetched /members (now 2) → Allocation appears.
    await waitFor(
      () => expect(screen.getAllByRole('link', { name: 'Allocation' }).length).toBeGreaterThan(0),
      { timeout: 5000 },
    )
  })

  // PPL-031 — archiving back down to 1 member flips isShared false live and hides "Allocation".
  it('PPL-031: archiving back to 1 member flips shared→solo live (Allocation nav disappears)', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25 }),
    ]
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        membersData = [member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, incomeSharePct: 1 })]
        return Promise.resolve({ data: {} })
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPageWithHousehold()

    await screen.findByRole('table', {}, { timeout: 5000 })
    // Shared: Allocation nav present.
    await waitFor(
      () => expect(screen.getAllByRole('link', { name: 'Allocation' }).length).toBeGreaterThan(0),
      { timeout: 5000 },
    )

    await user.click(screen.getByRole('button', { name: 'Archive Sam' }))

    // Solo again: Allocation gone.
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'Allocation' })).toHaveLength(0), { timeout: 5000 })
  })

  // ---- Month income from the budget (rule 28) --------------------------------

  // PPL-078 (rewritten) — the per-person `income` from /members/income drives the hero and the
  // Income column; the saved default is only a sub-line, shown when it differs.
  it('PPL-078: the month payload\'s per-person income drives the hero and the income column', async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3250, incomeSharePct: 0.61 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 2050, budgetIncome: 2050, incomeSharePct: 0.39 }),
    ]
    incomeData = {
      incomeFromBudget: true,
      hasBudget: true,
      fxPendingCount: 0,
      unattributedPlanned: 100,
      items: [
        { memberId: 'm1', name: 'Alex', planned: 3200, received: 1500, income: 3250, sharePct: 0.61 },
        { memberId: 'm2', name: 'Sam', planned: 2000, received: 0, income: 2050, sharePct: 0.39 },
      ],
    }

    renderPage()

    // Hero: this month's budgeted income (3,250 + 2,050 — the unattributed 100 already shared out).
    expect(await screen.findByText('Income this month', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('5,300.00')
    // Alex's cell shows the month figure with the saved default as a sub-line; Sam's default matches → no sub-line.
    expect(screen.getByText('€3,250.00')).toBeInTheDocument()
    expect(screen.getByText(/default\s+€3,000\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/default\s+€2,050\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText('Combined income')).not.toBeInTheDocument()
  })

  // PPL-079 (rewritten for rule 28) — a month with no budget has NO income: the hero reads €0.00
  // under the same label with a "no budget yet" note, and the saved defaults never stand in.
  it('PPL-079: a month without a budget shows €0.00 income and a "No budget for July 2026 yet" note', async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 0, hasBudget: false, incomeSharePct: 0 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 0, hasBudget: false, incomeSharePct: 0 }),
    ]
    incomeData = { incomeFromBudget: true, hasBudget: false, fxPendingCount: 0, unattributedPlanned: 0, items: [] }

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('Income this month')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Income this month:/)).toHaveTextContent('€0.00')
    expect(screen.queryByText('Combined income')).not.toBeInTheDocument()
    expect(screen.queryByText('€4,000.00')).not.toBeInTheDocument()
    expect(screen.getByText(/No budget for July 2026 yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the Budget' })).toBeInTheDocument()
    // The defaults still show as the sub-line, so the user knows what a new budget would start from.
    expect(screen.getByText(/default\s+€3,000\.00/)).toBeInTheDocument()
  })

  // PPL-080 — every month-scoped read names the selected month, and moving the month reloads.
  it('PPL-080: requests the selected month and reloads when the month changes', async () => {
    membersData = [member()]

    const view = renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    let urls = mockGet.mock.calls.map((c) => c[0] as string)
    expect(urls).toContain('/members?year=2026&month=7')
    expect(urls).toContain('/members/income/2026/7')
    expect(urls).toContain('/members/spending/2026/7')
    expect(urls).not.toContain('/members/spending')

    // The top bar moves to August: the page re-reads everything for August.
    monthState.year = 2026
    monthState.month = 8
    monthState.label = 'August 2026'
    view.rerender(
      <MemoryRouter>
        <AuthProvider>
          <PeoplePage />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => {
      urls = mockGet.mock.calls.map((c) => c[0] as string)
      expect(urls).toContain('/members?year=2026&month=8')
      expect(urls).toContain('/members/income/2026/8')
      expect(urls).toContain('/members/spending/2026/8')
    }, { timeout: 5000 })
  })

  // PPL-081 — the Share column is the month payload's incomeSharePct, not a ratio of the defaults.
  it('PPL-081: shares come from the month payload, not from the saved defaults', async () => {
    membersData = [
      // Equal defaults would be 50/50; the month's budget gives Alex 80%.
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 2000, budgetIncome: 4000, incomeSharePct: 0.8 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 2000, budgetIncome: 1000, incomeSharePct: 0.2 }),
    ]

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText('20%')).toBeInTheDocument()
    expect(screen.queryByText('50%')).not.toBeInTheDocument()
  })

  // PPL-082 — rows in another currency still waiting for their amount in the budget currency are
  // not counted, and the page says so: a "+N need EUR amount" hint on the member's Spent cell,
  // and one under the hero for the income result.
  it('PPL-082: FX-pending spending and income rows show a "+N need EUR amount" hint', async () => {
    membersData = [member({ id: 'm1', name: 'Alex' }), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.5 })]
    spendingData = [
      { memberId: 'm1', name: 'Alex', spent: 120, fxPendingCount: 2 },
      { memberId: 'm2', name: 'Sam', spent: 80, fxPendingCount: 0 },
    ]
    incomeData = {
      incomeFromBudget: true,
      hasBudget: true,
      fxPendingCount: 1,
      unattributedPlanned: 0,
      items: [
        { memberId: 'm1', name: 'Alex', planned: 3000, received: 0, income: 3000, sharePct: 0.5 },
        { memberId: 'm2', name: 'Sam', planned: 3000, received: 0, income: 3000, sharePct: 0.5 },
      ],
    }

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('€120.00')).toBeInTheDocument()
    expect(screen.getByText('+2 need EUR amount')).toBeInTheDocument()
    expect(screen.getByText(/\+1 income row in another currency, not counted until its amount in EUR is entered/)).toBeInTheDocument()
    // Sam has nothing pending → exactly one row hint on the page.
    expect(screen.getAllByText(/^\+\d+ needs? EUR amount$/)).toHaveLength(1)
  })

  // PPL-083 — the add-person and inline income fields are the DEFAULT income, labelled and hinted
  // as such (rule 28: a helper for a new budget, never a figure the month calculates with).
  it('PPL-083: income fields are labelled as the default income with the new-budget hint', async () => {
    membersData = [member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 1 })]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Sam' }))
    expect(screen.getByLabelText('Default income for Sam')).toHaveValue('1000')
    expect(screen.queryByLabelText('Net monthly income for Sam')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))

    await user.click(screen.getByRole('button', { name: 'Add person' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Default income')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Net monthly income')).not.toBeInTheDocument()
    expect(dialog.getByText(/Becomes this person’s income line when you start a blank month\. Calculations use the income lines in the month’s budget\./)).toBeInTheDocument()
  })
})
