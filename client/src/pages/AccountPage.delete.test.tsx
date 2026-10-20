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
// goes; "Delete for good" works once the password is entered (a Google-only login types its email).
// While others share the budget, it says to remove them first and offers nothing to delete.
let meData: MeResponse = ownerMe
let preview = { ownsHousehold: true, othersInHousehold: 0 }

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
    preview = { ownsHousehold: true, othersInHousehold: 0 }
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

  it('deletes only once the password is entered, then leaves for the sign-in page', async () => {
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    expect(await within(dialog).findByText('Your sign-in and your budget go for good.')).toBeInTheDocument()
    const go = within(dialog).getByRole('button', { name: 'Delete for good' })
    expect(go).toHaveAttribute('aria-disabled', 'true')
    await user.click(go)
    expect(mockPost).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText('Your password'), 'hunter22')
    expect(go).not.toHaveAttribute('aria-disabled')
    await user.click(go)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/delete-account', { password: 'hunter22' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?reason=deleted'))
  })

  it('asks a Google-only login to type its email', async () => {
    meData = { ...ownerMe, hasPassword: false, hasGoogle: true }
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    const go = within(dialog).getByRole('button', { name: 'Delete for good' })
    await user.type(within(dialog).getByLabelText('Type your email to confirm'), 'alex@x.co')
    expect(go).toHaveAttribute('aria-disabled', 'true')
    await user.type(within(dialog).getByLabelText('Type your email to confirm'), 'M')
    await user.click(go)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/delete-account', { confirmEmail: 'alex@x.coM' }))
  })

  it('while others share the budget, says to remove them first and offers no delete', async () => {
    preview = { ownsHousehold: true, othersInHousehold: 2 }
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    expect(await within(dialog).findByText(/Others share your budget/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people')
    expect(within(dialog).queryByRole('button', { name: 'Delete for good' })).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Your password')).not.toBeInTheDocument()
  })

  it.each([
    [{ error: "That password isn't right." }, "That password isn't right."],
    [{ errors: { Id: ['A refund elsewhere names a purchase.'] } }, 'A refund elsewhere names a purchase.'],
  ])("shows the server's refusal and stays open (%o)", async (body, shown) => {
    mockPost.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: body } })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    await user.type(within(dialog).getByLabelText('Your password'), 'wrong')
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(shown)
    expect(assign).not.toHaveBeenCalled()
  })
})
