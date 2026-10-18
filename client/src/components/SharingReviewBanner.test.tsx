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
    expect(screen.queryByText('Review who sees your accounts.')).not.toBeInTheDocument()
  })

  it('asks for the review, keeps each account as it is, and saves the chosen private ones', { timeout: 15000 }, async () => {
    mockPost.mockResolvedValue({ data: { pending: false, accounts: [] } })
    const user = userEvent.setup()
    renderBanner(true)

    // One line on the info tone, with the quiet action.
    const line = await screen.findByText('Review who sees your accounts.', {}, { timeout: 5000 })
    expect(line.closest('[data-tone]')).toHaveAttribute('data-tone', 'info')
    await user.click(screen.getByRole('button', { name: 'Review sharing' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Who sees your accounts' }))
    // The explanation sits behind the sheet's (i).
    expect(dialog.queryByText(/A private account is seen only by you/)).not.toBeInTheDocument()
    await user.hover(dialog.getByRole('button', { name: 'About private accounts' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('An account a jar uses stays visible to everyone.')
    const pocket = dialog.getByLabelText('Keep Pocket private')
    expect(pocket).not.toBeChecked()
    // An account a jar uses stays visible (P55): its box is disabled and says why.
    expect(dialog.getByLabelText('Keep Savings private')).toBeDisabled()
    expect(dialog.getByText("'Savings' holds the jar 'Holiday'.")).toBeInTheDocument()

    await user.click(pocket)
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/accounts/sharing-review', { privateAccountIds: ['a1'] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review sharing' })).not.toBeInTheDocument())
  })

  it('saves once when Save is pressed twice while it is saving', { timeout: 15000 }, async () => {
    let finish: (v: unknown) => void = () => {}
    mockPost.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const user = userEvent.setup()
    renderBanner(true)

    await user.click(await screen.findByRole('button', { name: 'Review sharing' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Who sees your accounts' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    await user.keyboard('{Enter}')
    expect(mockPost.mock.calls.filter(([url]) => url === '/accounts/sharing-review')).toHaveLength(1)
    finish({ data: { pending: false, accounts: [] } })
  })
})
