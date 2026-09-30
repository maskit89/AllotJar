import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    // The cookie-bootstrap refresh fails for a signed-out invitee, so the invite form (not the
    // "already signed in" variant) renders.
    refreshSession: () => Promise.resolve(null),
  }),
)

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AcceptInvitePage } from './AcceptInvitePage'

const renderAt = (path: string) => renderWithProviders(<AcceptInvitePage />, { route: path })

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    resetApiMocks()
    mockGet.mockResolvedValue({ data: null })
  })

  it('requires accepting the terms before the form submits', async () => {
    mockPost.mockImplementation((url: string) => {
      if (url === '/auth/refresh') return Promise.reject({ response: { status: 401 } })
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password'), 'password123')
    // Checkbox left unticked: the required constraint blocks submission client-side.
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    expect(mockPost).not.toHaveBeenCalledWith('/auth/accept-invite', expect.anything())
    expect(screen.getByRole('checkbox')).toBeRequired()
  })
})
