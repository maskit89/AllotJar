import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Catalog: docs/testing/cases/03-session-auth-lifecycle.md — the verify-email banner (SESS-043).
// The banner reads auth state via useAuth, so mock the hook directly (lighter than a full
// AuthProvider + api mock, and lets each case pin exactly one state combination).

const { authState } = vi.hoisted(() => ({
  authState: {
    isAuthenticated: true,
    emailConfirmed: false,
    needsConsent: false,
    email: 'owner@example.com',
    resendVerification: vi.fn<() => Promise<void>>(),
  },
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => authState }))

import { VerifyEmailBanner } from './VerifyEmailBanner'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(authState, {
    isAuthenticated: true,
    emailConfirmed: false,
    needsConsent: false,
    email: 'owner@example.com',
    resendVerification: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  })
})

describe('VerifyEmailBanner (catalog SESS-043)', () => {
  it('SESS-043: shows for an authenticated, unverified, consented login and resends', async () => {
    render(<VerifyEmailBanner />)

    const line = screen.getByText('Confirm your email: check your inbox for the link.')
    expect(line).toBeInTheDocument()
    // One line on the warn tone; the address sits behind the (i), not in the line.
    const banner = line.closest('[data-tone]')!
    expect(banner).toHaveAttribute('data-tone', 'warn')
    expect(banner).toHaveAttribute('aria-live', 'polite')
    expect(banner).not.toHaveAttribute('role')
    expect(screen.queryByText(/owner@example\.com/)).not.toBeInTheDocument()
    await userEvent.hover(screen.getByRole('button', { name: 'About confirming your email' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('owner@example.com')

    await userEvent.click(screen.getByRole('button', { name: 'Resend' }))
    expect(authState.resendVerification).toHaveBeenCalledOnce()
    // The outcome replaces the line, on the ok tone.
    expect(await screen.findByText('A fresh link is on its way.')).toBeInTheDocument()
    expect(screen.queryByText('Confirm your email: check your inbox for the link.')).not.toBeInTheDocument()
    expect(banner).toHaveAttribute('data-tone', 'ok')
  })

  it('SESS-043: hidden once the email is confirmed', () => {
    authState.emailConfirmed = true
    const { container } = render(<VerifyEmailBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('SESS-043: hidden while consent is still owed (that blocks the app first)', () => {
    authState.needsConsent = true
    const { container } = render(<VerifyEmailBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('SESS-043: hidden when signed out', () => {
    authState.isAuthenticated = false
    const { container } = render(<VerifyEmailBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('SESS-043: a failed resend shows a retry hint', async () => {
    authState.resendVerification = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('x'))
    render(<VerifyEmailBanner />)

    await userEvent.click(screen.getByRole('button', { name: 'Resend' }))
    const line = await screen.findByText("Couldn't resend, try again.")
    expect(line.closest('[data-tone]')).toHaveAttribute('data-tone', 'bad')
  })
})
