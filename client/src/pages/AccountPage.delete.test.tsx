import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import type { MeResponse } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountPage } from './AccountPage'
import { ownerMe } from '../test/fixtures/me'

// "Delete my account" (compliance fix 5): a row in the Sign-in card opens a dialog that says what
// goes, and "Delete for good" works only once the login's email is typed.
let meData: MeResponse = ownerMe
let preview = { ownsHousehold: true, othersInHousehold: 0, privateAccountsElsewhere: 0 }

const renderPage = () => renderWithProviders(<AccountPage />, { household: true })
const W = { timeout: 5000 }

async function openDelete(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Delete account' }, W))
  return screen.findByRole('dialog', { name: 'Delete your account?' }, W)
}

describe('AccountPage: Delete account', () => {
  const assign = vi.fn()

  beforeEach(() => {
    resetApiMocks()
    meData = ownerMe
    preview = { ownsHousehold: true, othersInHousehold: 0, privateAccountsElsewhere: 0 }
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: [] })
      if (url === '/auth/delete-preview') return Promise.resolve({ data: preview })
      return Promise.resolve({ data: meData })
    })
    assign.mockClear()
    vi.stubGlobal('location', { ...window.location, assign })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes only once the email is typed, then leaves for the sign-in page', async () => {
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    expect(await within(dialog).findByText('Your sign-in and your budget go for good.')).toBeInTheDocument()
    const go = within(dialog).getByRole('button', { name: 'Delete for good' })
    expect(go).toHaveAttribute('aria-disabled', 'true')
    await user.click(go)
    expect(mockPost).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText('Type your email to confirm'), 'ALEX@x.com')
    expect(go).not.toHaveAttribute('aria-disabled')
    await user.click(go)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/delete-account', { confirmEmail: 'ALEX@x.com' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?reason=deleted'))
  })

  it('says how many people lose access to the budget', async () => {
    preview = { ownsHousehold: true, othersInHousehold: 2, privateAccountsElsewhere: 0 }
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    expect(
      await within(dialog).findByText('Your sign-in and your budget go for good, and 2 people lose access to it.'),
    ).toBeInTheDocument()
  })

  it("shows the server's refusal and stays open", async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: "That isn't your email. Type it exactly to delete your account." } },
    })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    await user.type(within(dialog).getByLabelText('Type your email to confirm'), 'alex@x.com')
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent("That isn't your email.")
    expect(assign).not.toHaveBeenCalled()
  })
})
