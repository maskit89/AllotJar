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
import type { AccountDto, HouseholdMemberDto, MembershipDto } from '../types'
import { formatMoney, fromAmount } from '../lib/money'

const { mockGet, mockPost, mockPut, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
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
    name: 'Chris',
    netMonthlyIncome: 3000,
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
    email: 'chris@x.eu',
    displayName: 'Chris',
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

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/members') return Promise.resolve({ data: membersData })
    if (url === '/access/members') return Promise.resolve({ data: membershipsData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/members/spending') return Promise.resolve({ data: [] })
    if (url === '/auth/me') return Promise.resolve({ data: meData })
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
    setupGet()
  })

  // PPL-001 — hero combined income, per-row share, and the "You" sub-label on the linked login.
  it('PPL-001: hero sums combined income and rows show share + the "You" sub-label', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 }),
    ]
    membershipsData = [membership()] // Chris is the current login (isSelf), linked to m1

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    const combined = formatMoney(fromAmount(3000) + fromAmount(1000), 'EUR')
    expect(combined).toBe('€4,000.00')
    expect(screen.getByText('€4,000.00')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  // PPL-073 — every active member income 0: combined €0.00, all shares 0% (no divide-by-zero / NaN).
  it('PPL-073: all-zero incomes render €0.00 combined and 0% shares (no NaN)', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Chris', netMonthlyIncome: 0, incomeSharePct: 0 }),
      member({ id: 'm2', name: 'Sam', netMonthlyIncome: 0, incomeSharePct: 0 }),
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
    await user.type(dialog.getByLabelText('Net monthly income'), '100')
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
    const incomeInput = dialog.getByLabelText('Net monthly income')

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
    await user.type(dialog.getByLabelText('Net monthly income'), '500')
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
    expect(screen.getByText('Chris')).toBeInTheDocument()
  })

  // PPL-018 — inline edit rewrites name/income/savings via PUT /members/{id} with the new values.
  it('PPL-018: inline edit saves name, income and savings account via PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 })]
    accountsData = [account({ id: 'a1', name: 'Joint' })]
    mockPut.mockResolvedValue({ data: member({ id: 'm2', name: 'Liza M' }) })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Liza' }))

    const nameInput = screen.getByLabelText('Name for Liza')
    const incomeInput = screen.getByLabelText('Net monthly income for Liza')
    await user.clear(nameInput)
    await user.type(nameInput, 'Liza M')
    await user.clear(incomeInput)
    await user.type(incomeInput, '1200')
    await user.selectOptions(screen.getByLabelText('Savings account for Liza'), 'a1')

    // Determinism: wait until the controlled inputs actually hold the new values before saving.
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toBe('Liza M'), { timeout: 5000 })
    await waitFor(() => expect((incomeInput as HTMLInputElement).value).toBe('1200'), { timeout: 5000 })

    await user.click(screen.getByRole('button', { name: 'Save Liza' }))

    await waitFor(
      () =>
        expect(mockPut).toHaveBeenCalledWith(
          '/members/m2',
          expect.objectContaining({ name: 'Liza M', netMonthlyIncome: 1200, personalSavingsAccountId: 'a1' }),
        ),
      { timeout: 5000 },
    )
  })

  // PPL-019 — Cancel leaves display mode with the original values and sends no PUT.
  it('PPL-019: cancelling an inline edit discards changes and does not PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 })]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Liza' }))
    const nameInput = screen.getByLabelText('Name for Liza')
    await user.clear(nameInput)
    await user.type(nameInput, 'Changed')
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))

    await waitFor(() => expect(screen.queryByLabelText('Name for Liza')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText('Liza')).toBeInTheDocument()
    expect(mockPut).not.toHaveBeenCalled()
  })

  // PPL-020 — inline edit validation mirrors add: empty name, then bad income; no PUT until valid.
  it('PPL-020: inline edit validation rejects empty name then bad income without PUT', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 })]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Edit Liza' }))

    const nameInput = screen.getByLabelText('Name for Liza')
    await user.clear(nameInput)
    await user.click(screen.getByRole('button', { name: 'Save Liza' }))
    expect(await screen.findByText('Give the person a name.', {}, { timeout: 5000 })).toBeInTheDocument()

    await user.type(nameInput, 'Liza')
    const incomeInput = screen.getByLabelText('Net monthly income for Liza')
    await user.clear(incomeInput)
    await user.type(incomeInput, 'abc')
    await user.click(screen.getByRole('button', { name: 'Save Liza' }))
    expect(await screen.findByText('Enter a valid monthly income.', {}, { timeout: 5000 })).toBeInTheDocument()

    expect(mockPut).not.toHaveBeenCalled()
  })

  // PPL-022 / PPL-023 — a single "✕" click archives immediately (no confirm dialog); the row leaves
  // the table and the combined-income hero recomputes on reload. (Transaction-persistence half of
  // PPL-023 is backend-only — see the deferred note.)
  it('PPL-022/PPL-023: archiving fires PUT {archived:true} on one click and removes the row', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 }),
    ]
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        membersData = [member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 1 })]
        return Promise.resolve({ data: {} })
      }
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByText('€4,000.00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Archive Liza' }))

    // No confirmation modal — the archive fired directly.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true }),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.queryByText('Liza')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('€4,000.00')).not.toBeInTheDocument()
  })

  // PPL-026 — a Limited member gets no edit/archive hover actions.
  it('PPL-026: edit and archive row actions are hidden for a non-writer (Limited)', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm2', name: 'Liza' })]
    meData = { role: 2 } // Limited

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'Archive Liza' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.queryByRole('button', { name: 'Edit Liza' })).not.toBeInTheDocument()
    expect(screen.getByText('Liza')).toBeInTheDocument()
  })

  // PPL-034 / PPL-037 — a linked non-owner login shows a role <select> + Remove; the owner shows a
  // static role Badge with no select and no Remove (owner sign-in is immovable in the UI).
  it('PPL-034/PPL-037: linked member shows role select + Remove; owner shows a Badge only', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Chris' }),
      member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 }),
    ]
    membershipsData = [
      membership(), // Chris: owner + self
      membership({ id: 'mem2', email: 'liza@x.eu', displayName: 'Liza', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })

    // Liza (Active, Admin) — editable role select with exactly Admin/Limited/Read-only + Remove.
    const roleSelect = screen.getByLabelText('Access level for Liza')
    const options = within(roleSelect).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Admin', 'Limited', 'Read-only'])
    expect(within(roleSelect).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove sign-in for Liza' })).toBeInTheDocument()
    expect(screen.getByText('liza@x.eu')).toBeInTheDocument()

    // Chris (owner + self) — a role Badge, no select, no Remove.
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.queryByLabelText('Access level for Chris')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove sign-in for Chris' })).not.toBeInTheDocument()
  })

  // PPL-035 — choosing a new role fires PUT /access/members/{id}/role {role:<n>}.
  it('PPL-035: changing a member role PUTs the numeric role', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Chris' }), member({ id: 'm2', name: 'Liza', incomeSharePct: 0.25 })]
    membershipsData = [
      membership(),
      membership({ id: 'mem2', email: 'liza@x.eu', displayName: 'Liza', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.selectOptions(screen.getByLabelText('Access level for Liza'), 'Limited')

    await waitFor(
      () => expect(mockPut).toHaveBeenCalledWith('/access/members/mem2/role', { role: 2 }),
      { timeout: 5000 },
    )
  })

  // PPL-036 — Remove hard-deletes the membership via DELETE /access/members/{id}.
  it('PPL-036: removing a sign-in DELETEs the membership', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Chris' }), member({ id: 'm2', name: 'Liza', incomeSharePct: 0.25 })]
    membershipsData = [
      membership(),
      membership({ id: 'mem2', email: 'liza@x.eu', displayName: 'Liza', role: 1, status: 0, memberId: 'm2', isOwner: false, isSelf: false }),
    ]
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Remove sign-in for Liza' }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/access/members/mem2'), { timeout: 5000 })
  })

  // PPL-038 — a pending (Status=Invited) login shows the amber "Invited" badge and still exposes the
  // owner's role select + Remove on that row.
  it('PPL-038: an invited (pending) login shows the amber "Invited" badge plus role/Remove controls', { timeout: 15000 }, async () => {
    membersData = [member({ id: 'm1', name: 'Chris' }), member({ id: 'm2', name: 'Robin', incomeSharePct: 0.25 })]
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
    membersData = [member({ id: 'm1', name: 'Chris' }), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.5 })]
    membershipsData = [
      membership(), // Chris, linked to m1 (self/owner)
      membership({ id: 'mem9', email: 'robin@x.eu', displayName: 'Robin', role: 1, status: 0, memberId: null, isOwner: false, isSelf: false }),
    ]

    renderPage()

    // Two tables render (members + the orphan-login card), so wait on the card's heading instead.
    await screen.findByText('Other sign-ins', {}, { timeout: 5000 })
    expect(screen.getByText('Robin')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()

    const linkSelect = screen.getByLabelText('Link robin@x.eu to a person')
    // Only the unlinked person (Sam) is offered — Chris is already claimed.
    expect(within(linkSelect).getByRole('option', { name: 'Sam' })).toBeInTheDocument()
    expect(within(linkSelect).queryByRole('option', { name: 'Chris' })).not.toBeInTheDocument()
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
    membersData = [member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 1 })]
    mockPost.mockImplementation((url: string) => {
      if (url === '/members') {
        membersData = [
          member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 0.75 }),
          member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 }),
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
    await user.type(dialog.getByLabelText('Person name'), 'Liza')
    await user.type(dialog.getByLabelText('Net monthly income'), '1000')
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
      member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 0.75 }),
      member({ id: 'm2', name: 'Liza', netMonthlyIncome: 1000, incomeSharePct: 0.25 }),
    ]
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') {
        membersData = [member({ id: 'm1', name: 'Chris', netMonthlyIncome: 3000, incomeSharePct: 1 })]
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

    await user.click(screen.getByRole('button', { name: 'Archive Liza' }))

    // Solo again: Allocation gone.
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'Allocation' })).toHaveLength(0), { timeout: 5000 })
  })
})
