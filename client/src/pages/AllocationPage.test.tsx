import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, AllocationProfileDto } from '../types'

const { monthState } = vi.hoisted(() => ({
  // The app-wide selected month the page allocates (rule 29): June 2026 for this file.
  monthState: { year: 2026, month: 6, label: 'June 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))

// The selected month comes from MonthContext (rule 29); pin it so assertions are clock-independent.
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AllocationPage } from './AllocationPage'
import { jointCurrent, preview, profile } from '../test/fixtures/allocation'

const accountsData: AccountDto[] = [jointCurrent]

// `'' ` is a real wire shape, not a hypothetical: a 204 No Content answer arrives from axios as an
// empty-string body, so the bootstrap has to normalise it the same way it normalises null.
let profileData: AllocationProfileDto | null | '' = null

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/allocation/profile') return Promise.resolve({ data: profileData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/budget/2026/6') return Promise.resolve({ data: { year: 2026, month: 6, categories: [] } })
    if (url.startsWith('/allocation/preview/')) return Promise.resolve({ data: preview() })
    return Promise.resolve({ data: [] })
  })
}

const renderPage = () => renderWithProviders(<AllocationPage />)

// Wrapped in a real HouseholdProvider so the page can tell solo from shared.
const renderWithHousehold = () => renderWithProviders(<AllocationPage />, { household: true })

describe('AllocationPage', () => {
  beforeEach(() => {
    resetApiMocks()
    profileData = null
    setupGet()
  })

  // ALLOC-010/ALLOC-018 regression. GET /allocation/profile used to answer 204 No Content for a
  // profile-less household; axios hands that back as `data: ''`, and the bootstrap's `?? null` let
  // the empty string through. `''?.rules` does NOT short-circuit — optional chaining only guards
  // null/undefined — so openSettings threw before setShowSettings(true) and the first-run modal
  // could never open. The server now emits a JSON null, and the client normalises falsy → null;
  // this test pins the client half so an empty body can't poison profile state again.
  it('opens the first-run setup modal when the profile response has an empty body', { timeout: 15000 }, async () => {
    profileData = ''
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Set up allocation' }, { timeout: 5000 }))
    expect(await screen.findByRole('dialog', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('nudges a solo user to add members instead of the allocation engine', { timeout: 15000 }, async () => {
    profileData = profile() // a profile exists, but with no members the page should still guard

    renderWithHousehold()

    expect(await screen.findByText(/Add people first/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add people' })).toBeInTheDocument()
    // The allocation setup form must not render in solo mode.
    expect(screen.queryByText('Allocation settings')).not.toBeInTheDocument()
  })

  // W13 (P53): a savings account private to someone else isn't "no savings account": the page says
  // only its holder can record that transfer, and offers no link to fix what isn't missing.
  it('names a private savings account instead of calling it missing', { timeout: 15000 }, async () => {
    profileData = profile()
    const withPrivate = preview()
    withPrivate.members[1] = { ...withPrivate.members[1], savingsAccountId: null, savingsBalance: null, savingsPrivate: true }
    const answer = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string) =>
      url.startsWith('/allocation/preview/') ? Promise.resolve({ data: withPrivate }) : answer(url),
    )

    renderPage()

    expect(await screen.findByText(/^Private savings account/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/Sam’s savings account is private, so only Sam can record this transfer/)).toBeInTheDocument()
    expect(screen.queryByText(/^No savings account/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has no savings account/)).not.toBeInTheDocument()
  })

  it('disables Allocate and explains when no source account is set', { timeout: 15000 }, async () => {
    profileData = { ...profile(), sourceAccountId: null }

    renderPage()

    await screen.findByText('How June is allocated', {}, { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toBeDisabled()
    expect(screen.getByText(/Set the account to pay shared costs from/)).toBeInTheDocument()
  })

  // S-P2-2 (P53): the source's holder made it private, so the profile names no id. The page still
  // counts it as set (the server explains a commit by someone else), shows "Private account" in the
  // settings, and saving them sends no id, which the server reads as "leave it".
  it('treats a source made private by its holder as set, without its id', { timeout: 15000 }, async () => {
    profileData = { ...profile(), sourceAccountId: null, sourcePrivate: true }
    mockPut.mockResolvedValue({ data: profileData })
    const user = userEvent.setup()

    renderPage()

    await screen.findByText('How June is allocated', {}, { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Commit allocation' })).toBeEnabled()
    expect(screen.queryByText(/Set the account to pay shared costs from/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Allocation settings' }))
    const source = (await screen.findByLabelText('Source account')) as HTMLSelectElement
    expect(source.selectedOptions[0]).toHaveTextContent('Private account')
    await user.click(screen.getByRole('button', { name: 'Save allocation settings' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/allocation/profile', expect.objectContaining({ sourceAccountId: null })),
    )
  })

  it('commits the allocation', { timeout: 15000 }, async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: preview(2) })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    // Rules 7/29: the plan becomes recorded transfers only after "I've completed these transfers".
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))
    expect(await screen.findByText(/Confirm that you’ve completed these transfers/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()

    await user.clear(dialog.getByLabelText('Allocation departure date'))
    await user.type(dialog.getByLabelText('Allocation departure date'), '2026-06-03')
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/6', {
        departedOn: '2026-06-03', receivedOn: null, confirmedCompleted: true,
      }),
    )
    expect(await screen.findByText(/2 savings transfers recorded as in transit/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('reports an unchanged re-run instead of pretending nothing was needed', { timeout: 15000 }, async () => {
    profileData = profile()
    mockPost.mockResolvedValue({ data: { ...preview(0), transfersRetained: 2 } })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Commit allocation' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Allocation completed confirmation'))
    await user.click(dialog.getByRole('button', { name: 'Confirm allocation' }))

    expect(await screen.findByText(/the 2 recorded transfers are unchanged/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
