import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import type { MeResponse } from '../types'

const mockDownload = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, { downloadMyData: mockDownload }),
)

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountPage } from './AccountPage'
import { ownerMe } from '../test/fixtures/me'

// "Delete my account" (compliance fix 5): a row in the Your data card, under Download, opens a dialog that says what
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
    mockDownload.mockReset()
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

  it('sits under Download in Your data, and its dialog offers the download first', async () => {
    mockDownload.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    const card = (await screen.findByRole('heading', { name: 'Your data' }, W)).closest('section')!
    expect(within(card).getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
    const dialog = await openDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Download my data first' }))
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Delete your account?' })).toBeInTheDocument()
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

  // Audit A07-001: the typed email is only a typo guard. Long after signing in, the server asks a
  // login without a password for proof (a passkey or recovery code), or to sign in again.
  const proofAsked = (kinds: object) => ({ isAxiosError: true, response: { status: 403, data: { error: "Confirm it's you first.", proof: kinds } } })

  it('asks a Google-only login without a passkey to sign in again when the server wants proof', async () => {
    meData = { ...ownerMe, hasPassword: false, hasGoogle: true }
    mockPost.mockRejectedValue(proofAsked({ password: false, passkey: false, recoveryCode: false }))
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    await user.type(within(dialog).getByLabelText('Type your email to confirm'), ownerMe.email)
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }))

    const again = await screen.findByRole('dialog', { name: 'Sign in again' }, W)
    expect(within(again).getByText(/Sign in again first, then delete your account/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Delete your account?' })).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('finishes the delete with a recovery code when the server asks for proof', async () => {
    meData = { ...ownerMe, hasPassword: false, hasGoogle: true }
    mockPost
      .mockRejectedValueOnce(proofAsked({ password: false, passkey: true, recoveryCode: true }))
      .mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    const dialog = await openDelete(user)
    await user.type(within(dialog).getByLabelText('Type your email to confirm'), ownerMe.email)
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }))

    const confirm = await screen.findByRole('dialog', { name: "Confirm it's you" }, W)
    await user.click(within(confirm).getByRole('button', { name: 'Use a recovery code' }))
    await user.type(within(confirm).getByLabelText('Recovery code'), 'abcde-fghjk')
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith('/auth/delete-account', {
        confirmEmail: ownerMe.email,
        proof: { recoveryCode: 'abcde-fghjk' },
      }),
    )
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?reason=deleted'))
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
