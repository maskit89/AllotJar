import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost },
  getToken: () => null,
  setToken: vi.fn(),
  // The cookie-bootstrap refresh fails for a signed-out invitee, so the invite form (not the
  // "already signed in" variant) renders.
  refreshSession: () => Promise.resolve(null),
}))

import { AcceptInvitePage } from './AcceptInvitePage'
import { AuthProvider } from '../auth/AuthContext'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AcceptInvitePage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
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
