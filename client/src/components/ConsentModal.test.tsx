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
import { joinedMe } from '../test/fixtures/me'

// Sam, an admin of Alex's household, as /auth/me answers.
const me = (needsConsent: boolean) => ({ data: joinedMe(1, { needsConsent }) })

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

  it('offers sign-out as the only alternative to agreeing: no close control, and Escape or the scrim do nothing', async () => {
    mockGet.mockResolvedValue(me(true))
    const user = userEvent.setup()
    renderModal()

    const dialog = await screen.findByRole('dialog', { name: 'Accept the terms' })
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    // No close/dismiss affordance: agreeing or leaving are the only exits.
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'I agree' })).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(dialog.parentElement!.querySelector('[aria-hidden]')!)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // The links open the legal pages in a new tab; the why sits behind the (i).
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy')
    await user.hover(screen.getByRole('button', { name: 'Why you are asked' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/asked once here/)
  })

  it('never covers the legal pages it links to', async () => {
    mockGet.mockResolvedValue(me(true))
    renderModal('/terms')

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sends one request when "I agree" is pressed twice while it is saving', async () => {
    mockGet.mockResolvedValue(me(true))
    let finish: (v: unknown) => void = () => {}
    mockPost.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const user = userEvent.setup()
    renderModal()

    await screen.findByRole('dialog', { name: 'Accept the terms' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'I agree' })).toHaveFocus())
    await user.keyboard('{Enter}')
    // Busy: the button keeps focus (aria-disabled) but a second Enter or click sends nothing.
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: 'Please wait…' }))
    expect(mockPost.mock.calls.filter(([url]) => url === '/auth/consent')).toHaveLength(1)
    finish({ data: {} })
  })
})
