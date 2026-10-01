import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    // A live in-memory token, so AuthProvider treats the session as signed in and loads /auth/me.
    getToken: () => 'tok',
  }),
)

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { PasswordChangeModal } from './PasswordChangeModal'
import { joinedMe } from '../test/fixtures/me'

// Sam, created by Alex's direct invite with a temporary password (S-P2-3).
const me = (mustChangePassword: boolean) => ({ data: joinedMe(1, { mustChangePassword }) })

const renderModal = (path = '/') => renderWithProviders(<PasswordChangeModal />, { route: path })

describe('PasswordChangeModal', () => {
  beforeEach(() => {
    localStorage.clear()
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
  })

  it('stays hidden for a login that chose its own password', async () => {
    mockGet.mockResolvedValue(me(false))
    renderModal()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks a direct-invite login and points it at the link emailed to its own address', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/Choose your own password/)
    expect(dialog).toHaveTextContent(/emailed to sam@x\.com/)
    // No way to type a new password here: whoever set the temporary one could do that (P2-1).
    expect(dialog.querySelector('input')).toBeNull()
  })

  it('steps aside on the page the emailed link opens', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal('/reset-password?email=sam%40x.com&token=t')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('emails the link again on request', async () => {
    mockGet.mockResolvedValue(me(true))
    const user = userEvent.setup()
    renderModal()

    await user.click(await screen.findByRole('button', { name: 'Email me the link again' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/password-link'))
    expect(await screen.findByRole('status')).toHaveTextContent(/sent a new link/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('says so when the email could not be sent, instead of claiming a new link', async () => {
    mockGet.mockResolvedValue(me(true))
    mockPost.mockRejectedValue(
      Object.assign(new Error('503'), {
        isAxiosError: true,
        response: { status: 503, data: { error: "We couldn't send the email just now. Try again later." } },
      }),
    )
    const user = userEvent.setup()
    renderModal()

    await user.click(await screen.findByRole('button', { name: 'Email me the link again' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't send the email just now.")
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers sign-out as the only alternative', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal()

    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
  })
})
