import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, HouseholdMemberDto, MembershipDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { personAction, personCard, personItems, personNote } from '../test/rowMenu'
import { PeoplePage } from './PeoplePage'

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 6000, budgetIncome: 6000, hasBudget: true, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

// No MonthProvider here, so the page reads the context default — the current calendar month.
const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1

function membership(over: Partial<MembershipDto> = {}): MembershipDto {
  return { id: 'mem1', email: 'alex@x.com', displayName: 'Alex', role: 0, status: 0, memberId: 'm1', isOwner: true, isSelf: true, createdUtc: '2026-01-01', ...over }
}

let membersData: HouseholdMemberDto[] = []
let membershipsData: MembershipDto[] = []
const accountsData: AccountDto[] = []

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === `/members?year=${YEAR}&month=${MONTH}`) return Promise.resolve({ data: membersData })
    if (url === '/members') return Promise.resolve({ data: membersData })
    if (url === '/access/members') return Promise.resolve({ data: membershipsData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === `/members/spending/${YEAR}/${MONTH}`) return Promise.resolve({ data: [] })
    return Promise.resolve({ data: {} }) // /auth/me — ignored (no numeric role ⇒ default Owner)
  })
}

const renderPage = () => renderWithProviders(<PeoplePage />)

describe('PeoplePage', () => {
  beforeEach(() => {
    resetApiMocks()
    membersData = []
    membershipsData = []
    setupGet()
  })

  it('lets the signed-in owner claim their own budget person when their login is unlinked', { timeout: 15000 }, async () => {
    membersData = [member()] // "Alex" person, not linked to any login
    membershipsData = [membership({ memberId: null })] // the owner's own login, unlinked
    mockPut.mockResolvedValue({ data: membership({ memberId: 'm1' }) })
    const user = userEvent.setup()

    renderPage()

    // "This is me" sits in the person's ⋯ menu.
    await personAction(user, 'Alex', 'This is me')

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/access/members/mem1/link', { memberId: 'm1' }),
    )
  })

  it('shows a solo-friendly empty state when there are no people', { timeout: 15000 }, async () => {
    membersData = []

    renderPage()

    expect(await screen.findByText(/Budgeting on your own\?/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
  // W13 (P53/P56): the savings account a person chose may be their own private account, which the
  // login looking at them can't see. The server says so without the id (S-P2-1): it reads
  // "Private account", an edit offers no "None" over it, and saving sends no id, which the server
  // reads as "leave it".
  it('shows a savings account private to someone else as "Private account" and keeps it on edit', { timeout: 15000 }, async () => {
    membersData = [member({ personalSavingsAccountId: null, savingsPrivate: true })]
    mockPut.mockResolvedValue({ data: member({ personalSavingsAccountId: null, savingsPrivate: true }) })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })
    const card = within(personCard('Alex'))
    expect(card.getByText('Private account')).toBeInTheDocument()

    await personAction(user, 'Alex', 'Edit Alex')
    const select = card.getByLabelText('Savings account for Alex') as HTMLSelectElement
    expect(select.selectedOptions[0]).toHaveTextContent('Private account')
    expect(within(select).queryByRole('option', { name: 'None' })).not.toBeInTheDocument()
    await user.click(card.getByRole('button', { name: 'Save Alex' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/members/m1', expect.objectContaining({ personalSavingsAccountId: null })),
    )
  })

  // D5 (PR #307 review P2-1): a sign-in once linked to a person sees "This isn't me" there and can
  // release only its own link; nobody else gets the button.
  it('lets a sign-in once linked to a person say it is not that person', { timeout: 15000 }, async () => {
    membersData = [member(), member({ id: 'm2', name: 'Sam', displayOrder: 1, canReleaseMyLink: true })]
    membershipsData = [membership()]
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })
    // The ⋯'s note says why, in one line; "This isn't me" is in Sam's ⋯ only.
    expect(await personNote(user, 'Sam')).toContain('Your sign-in was linked to Sam before, which stops Sam making their accounts private.')
    expect((await personNote(user, 'Alex')).join(' ')).not.toMatch(/Your sign-in was linked to Alex before/)
    expect(await personItems(user, 'Sam')).toContain("This isn't me")
    expect(await personItems(user, 'Alex')).not.toContain("This isn't me")
    membersData = [member(), member({ id: 'm2', name: 'Sam', displayOrder: 1 })]
    await personAction(user, 'Sam', "This isn't me")

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/access/people/m2/not-me'))
    await waitFor(async () => expect((await personNote(user, 'Sam')).join(' ')).not.toMatch(/Your sign-in was linked to Sam before/))
    expect(screen.queryByText(/Your sign-in was linked to Sam before/)).not.toBeInTheDocument()
  })
})
