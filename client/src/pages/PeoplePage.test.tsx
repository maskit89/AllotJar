import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, HouseholdMemberDto, MembershipDto } from '../types'

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

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 6000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

function membership(over: Partial<MembershipDto> = {}): MembershipDto {
  return { id: 'mem1', email: 'alex@x.com', displayName: 'Alex', role: 0, status: 0, memberId: 'm1', isOwner: true, isSelf: true, createdUtc: '2026-01-01', ...over }
}

let membersData: HouseholdMemberDto[] = []
let membershipsData: MembershipDto[] = []
const accountsData: AccountDto[] = []

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/members') return Promise.resolve({ data: membersData })
    if (url === '/access/members') return Promise.resolve({ data: membershipsData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/members/spending') return Promise.resolve({ data: [] })
    return Promise.resolve({ data: {} }) // /auth/me — ignored (no numeric role ⇒ default Owner)
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

describe('PeoplePage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    mockPut.mockReset()
    mockDelete.mockReset()
    membersData = []
    membershipsData = []
    setupGet()
  })

  it('shows each person with their sign-in and access level', { timeout: 15000 }, async () => {
    membersData = [member()]
    membershipsData = [membership()]

    renderPage()

    const table = within(await screen.findByRole('table', {}, { timeout: 5000 }))
    expect(table.getByText('Alex')).toBeInTheDocument()
    expect(table.getByText('alex@x.com')).toBeInTheDocument()
    expect(table.getByText('Owner')).toBeInTheDocument()
  })

  it('offers to invite a person who has no sign-in', { timeout: 15000 }, async () => {
    membersData = [member(), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.5 })]
    membershipsData = [membership()] // only Alex has a login; Sam has none

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Invite to sign in' })).toBeInTheDocument()
  })

  it('lets the signed-in owner claim their own budget person when their login is unlinked', { timeout: 15000 }, async () => {
    membersData = [member()] // "Alex" person, not linked to any login
    membershipsData = [membership({ memberId: null })] // the owner's own login, unlinked
    mockPut.mockResolvedValue({ data: membership({ memberId: 'm1' }) })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'This is me' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/access/members/mem1/link', { memberId: 'm1' }),
    )
  })

  it('adds a person (no account needed)', { timeout: 15000 }, async () => {
    membersData = []
    mockPost.mockResolvedValue({ data: member({ id: 'm9' }) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Alex')
    await user.type(dialog.getByLabelText('Net monthly income'), '6000')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/members',
        expect.objectContaining({ name: 'Alex', netMonthlyIncome: 6000 }),
      ),
    )
  })

  it('shows a solo-friendly empty state when there are no people', { timeout: 15000 }, async () => {
    membersData = []

    renderPage()

    expect(await screen.findByText(/Budgeting on your own\?/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
