import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { SharingReviewBanner } from './SharingReviewBanner'
import { AuthProvider } from '../auth/AuthContext'

function account(over: Partial<AccountDto>): AccountDto {
  return {
    id: 'a1', name: 'Pocket', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0,
    holders: [{ memberId: 'm2', name: 'Sam' }], isPrivate: false, canChangeSharing: true, sharingBlockedReason: null,
    ...over,
  }
}

function renderBanner(pending: boolean) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/auth/me') return Promise.resolve({ data: { role: 1, memberId: 'm2', sharingReviewPending: pending } })
    if (url === '/accounts/sharing-review') {
      return Promise.resolve({
        data: {
          pending: true,
          accounts: [
            account({}),
            account({ id: 'a2', name: 'Savings', sharingBlockedReason: "'Savings' holds the jar 'Holiday'." }),
          ],
        },
      })
    }
    return Promise.resolve({ data: [] })
  })
  return render(
    <AuthProvider>
      <SharingReviewBanner />
    </AuthProvider>,
  )
}

// Rule 32 (P58): a login linked to a person who already holds accounts is asked, once, which of
// them the household sees; nothing changes until they answer.
describe('SharingReviewBanner', () => {
  beforeEach(() => {
    resetApiMocks()
  })

  it('stays hidden when no review is due', async () => {
    renderBanner(false)
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByText(/Choose which ones the others can see/)).not.toBeInTheDocument()
  })

  it('asks for the review, keeps each account as it is, and saves the chosen private ones', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: { pending: false, accounts: [] } })
    const user = userEvent.setup()
    renderBanner(true)

    await user.click(await screen.findByRole('button', { name: 'Review sharing' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog'))
    const pocket = dialog.getByLabelText('Keep Pocket private')
    expect(pocket).not.toBeChecked()
    // An account a jar uses stays visible (P55): its box is disabled and says why.
    expect(dialog.getByLabelText('Keep Savings private')).toBeDisabled()
    expect(dialog.getByText("'Savings' holds the jar 'Holiday'.")).toBeInTheDocument()

    await user.click(pocket)
    await user.click(dialog.getByRole('button', { name: 'Save choices' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/accounts/sharing-review', { privateAccountIds: ['a1'] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review sharing' })).not.toBeInTheDocument())
  })
})
