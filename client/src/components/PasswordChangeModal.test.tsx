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

async function fill(user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm = next) {
  await user.type(screen.getByLabelText('Temporary password'), current)
  await user.type(screen.getByLabelText('New password'), next)
  await user.type(screen.getByLabelText('Confirm new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Save password' }))
}

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

  it('blocks a direct-invite login until it saves a new password', async () => {
    mockGet.mockResolvedValue(me(true))
    const user = userEvent.setup()
    renderModal()

    expect(await screen.findByRole('dialog')).toHaveTextContent(/Choose your own password/)
    await fill(user, 'Temp-pass-1', 'Mine-pass-22')

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/change-password', {
        currentPassword: 'Temp-pass-1',
        newPassword: 'Mine-pass-22',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('refuses the temporary password itself or a mismatched confirmation without calling the server', async () => {
    mockGet.mockResolvedValue(me(true))
    const user = userEvent.setup()
    renderModal()
    await screen.findByRole('dialog')

    await fill(user, 'Temp-pass-1', 'Temp-pass-1')
    expect(await screen.findByRole('alert')).toHaveTextContent(/different from the temporary one/)

    await user.clear(screen.getByLabelText('Temporary password'))
    await user.clear(screen.getByLabelText('New password'))
    await user.clear(screen.getByLabelText('Confirm new password'))
    await fill(user, 'Temp-pass-1', 'Mine-pass-22', 'Mine-pass-23')
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/)

    expect(mockPost).not.toHaveBeenCalledWith('/auth/change-password', expect.anything())
  })

  it('shows the server refusal and stays open', async () => {
    mockGet.mockResolvedValue(me(true))
    mockPost.mockRejectedValue(
      Object.assign(new Error('400'), {
        isAxiosError: true,
        response: { status: 400, data: { errors: ['Incorrect password.'] } },
      }),
    )
    const user = userEvent.setup()
    renderModal()
    await screen.findByRole('dialog')

    await fill(user, 'Wrong-pass-1', 'Mine-pass-22')

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('offers sign-out as the only alternative', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal()

    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
  })
})
