import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  // A live in-memory token, so AuthProvider treats the session as signed in and loads /auth/me.
  getToken: () => 'tok',
  setToken: vi.fn(),
}))

import { ConsentModal } from './ConsentModal'
import { AuthProvider } from '../auth/AuthContext'

function me(needsConsent: boolean) {
  return {
    data: {
      userId: 'u2',
      email: 'liza@x.com',
      displayName: 'Liza',
      role: 1,
      ownerId: 'owner-1',
      memberId: null,
      needsConsent,
    },
  }
}

function renderModal(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <ConsentModal />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ConsentModal', () => {
  beforeEach(() => {
    localStorage.clear()
    mockGet.mockReset()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: {} })
  })

  it('stays hidden for logins that already consented', async () => {
    mockGet.mockResolvedValue(me(false))
    renderModal()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks an invite-created login until they agree, then records consent', async () => {
    mockGet.mockResolvedValue(me(true))
    const user = userEvent.setup()
    renderModal()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/Terms of Service/)

    await user.click(screen.getByRole('button', { name: 'I agree' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/consent'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers sign-out as the only alternative to agreeing', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal()

    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    // No close/dismiss affordance: agreeing or leaving are the only exits.
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
  })

  it('never covers the legal pages it links to', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal('/terms')

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
