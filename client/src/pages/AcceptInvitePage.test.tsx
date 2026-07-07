import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', () => ({
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

  it('redeems the invite token from the URL', async () => {
    mockPost.mockResolvedValue({
      data: { token: 'jwt', expiresAtUtc: '2030-01-01T00:00:00Z', userId: 'u2', email: 'liza@x.com', role: 2, displayName: 'Liza' },
    })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/accept-invite',
        expect.objectContaining({ token: 'ABC123', password: 'password123', acceptedTerms: true }),
      ),
    )
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

  it('offers an existing account a sign-in path that returns to the invite', async () => {
    mockPost.mockImplementation((url: string) => {
      if (url === '/auth/refresh') return Promise.reject({ response: { status: 401 } })
      return Promise.resolve({ data: {} })
    })

    renderAt('/accept-invite?code=ABC123')

    expect(
      await screen.findByRole('button', { name: 'Sign in to accept' }),
    ).toBeInTheDocument()
  })

  it('shows a clear message when the link has no code', () => {
    renderAt('/accept-invite')
    expect(screen.getByText(/missing its code/)).toBeInTheDocument()
  })
})
