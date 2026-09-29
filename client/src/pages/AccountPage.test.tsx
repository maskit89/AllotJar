import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { HouseholdMemberDto } from '../types'

const { mockGet, mockPost, mockPut } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockPut },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AccountPage } from './AccountPage'
import { AuthProvider } from '../auth/AuthContext'
import { HouseholdProvider } from '../features/HouseholdContext'

// An owner viewing their own household (the common case).
const ownerMe = {
  userId: 'u1',
  email: 'alex@x.com',
  displayName: 'Alex',
  role: 0,
  ownerId: 'u1',
  memberId: null,
  households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
}

// A member who only joined someone else's household (no own household of their own).
const joinedMe = {
  userId: 'u2',
  email: 'sam@x.com',
  displayName: 'Sam',
  role: 2,
  ownerId: 'owner-1',
  memberId: null,
  households: [{ ownerId: 'owner-1', label: 'Alex', role: 2, isActive: true, isOwn: false }],
}

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 6000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

// The Sharing card reads /members; everything else (/auth/me) returns the login.
let membersData: HouseholdMemberDto[] = []
let meData: typeof ownerMe & { preferredCurrency?: string; budgetCurrency?: string; currencyLocked?: boolean } = ownerMe

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HouseholdProvider>
          <AccountPage />
        </HouseholdProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AccountPage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    mockPut.mockReset()
    membersData = []
    meData = ownerMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      return Promise.resolve({ data: meData })
    })
  })

  it('rejects mismatched new passwords without calling the API', async () => {
    const user = userEvent.setup()

    renderPage()

    await user.type(await screen.findByLabelText('Current password'), 'oldpassword')
    await user.type(screen.getByLabelText('New password'), 'newpassword1')
    await user.type(screen.getByLabelText('Confirm new password'), 'different1')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText(/do not match/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('offers to share the budget when solo (no members)', async () => {
    membersData = []

    renderPage()

    expect(
      await screen.findByRole('button', { name: 'Share this budget' }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Manage people →')).not.toBeInTheDocument()
  })

  it('still offers to share when there is a single member (still solo)', async () => {
    membersData = [member()]

    renderPage()

    expect(
      await screen.findByRole('button', { name: 'Share this budget' }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Manage people →')).not.toBeInTheDocument()
  })

  it('links to manage members when the budget is shared (2+ members)', async () => {
    membersData = [member(), member({ id: 'm2', name: 'Sam' })]

    renderPage()

    expect(await screen.findByText('Manage people →', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/shared between 2 people/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share this budget' })).not.toBeInTheDocument()
  })

  it('does not offer to start an own budget or leave when you own the household', async () => {
    meData = ownerMe

    renderPage()

    await screen.findByText('Account') // page rendered
    expect(screen.queryByRole('button', { name: 'Start my own budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave household' })).not.toBeInTheDocument()
  })

  it('lets a member without an own budget start one', async () => {
    meData = joinedMe
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Start my own budget' }, { timeout: 5000 }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/households/start-own'))
  })

  it('lets a member leave a household they joined, after confirming', async () => {
    meData = joinedMe
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Leave household' }, { timeout: 5000 }))
    // A confirm step guards the destructive action.
    await user.click(screen.getByRole('button', { name: 'Yes, leave' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/households/leave', { ownerId: 'owner-1' }),
    )
  })

  // W08: the budget and all its accounts use one currency, fixed once the budget has accounts,
  // months or transactions (the app never converts). The preference is then shown read-only.
  it('shows the currency read-only with a note once the budget currency is locked', async () => {
    meData = { ...ownerMe, preferredCurrency: 'GBP', budgetCurrency: 'GBP', currencyLocked: true }
    mockPut.mockResolvedValue({
      data: { firstName: 'Alex', lastName: null, displayName: 'Alex', preferredCurrency: 'GBP', numberFormat: 'comma-dot' },
    })
    const user = userEvent.setup()

    renderPage()

    const note = await screen.findByText(/budget currency is fixed once your budget has accounts, months or transactions/)
    const currency = screen.getByLabelText('Currency') as HTMLInputElement
    expect(currency.tagName).toBe('INPUT')
    expect(currency).toHaveAttribute('readonly')
    expect(currency.value).toBe('British pound (£)')
    expect(currency).toHaveAttribute('aria-describedby', note.id)

    await user.type(screen.getByLabelText('First name'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/auth/preferences', expect.objectContaining({ preferredCurrency: 'GBP' })),
    )
  })

  it('shows the server’s reason when a currency change is refused', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: 'The budget currency can’t change once the budget has accounts.' } },
    })
    const user = userEvent.setup()

    renderPage()

    await user.selectOptions(await screen.findByLabelText('Currency'), 'USD')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The budget currency can’t change once the budget has accounts.')
  })
})
