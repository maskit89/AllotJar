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
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/accept-invite',
        expect.objectContaining({ token: 'ABC123', password: 'password123' }),
      ),
    )
  })

  it('shows a clear message when the link has no code', () => {
    renderAt('/accept-invite')
    expect(screen.getByText(/missing its code/)).toBeInTheDocument()
  })
})
