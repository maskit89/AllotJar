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
import { ConsentModal } from './ConsentModal'

function me(needsConsent: boolean) {
  return {
    data: {
      userId: 'u2',
      email: 'sam@x.com',
      displayName: 'Sam',
      role: 1,
      ownerId: 'owner-1',
      memberId: null,
      needsConsent,
    },
  }
}

const renderModal = (path = '/') => renderWithProviders(<ConsentModal />, { route: path })

describe('ConsentModal', () => {
  beforeEach(() => {
    localStorage.clear()
    resetApiMocks()
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
