import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/02-registration-login.md — the forgot-password
// page (REG-052): request a reset link, non-enumerating confirmation, transport-failure
// handling. Harness matches the repo convention: the shared api mock (signed out), page inside
// <MemoryRouter><AuthProvider>.

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    refreshSession: () => Promise.resolve(null),
  }),
)

vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

import { mockPost } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ForgotPasswordPage } from './ForgotPasswordPage'
import { track, EVENTS } from '../analytics'

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/login" element={<div>LOGIN</div>} />
    </Routes>,
    { route: '/forgot-password' },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('ForgotPasswordPage (catalog REG-052)', () => {
  // REG-052 — submitting posts the email and swaps to the confirmation panel whose copy
  // hedges ("If an account exists…") so the page can't confirm which emails have accounts.
  it('REG-052: requests a reset link and shows the non-enumerating confirmation', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 })
    renderPage()

    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    await screen.findByRole('status')
    expect(mockPost).toHaveBeenCalledWith('/auth/forgot-password', { email: 'owner@example.com' })
    expect(screen.getByText(/if an account exists for/i)).toBeInTheDocument()
    expect(screen.getByText(/valid for 2 hours/i)).toBeInTheDocument()
    // The form is gone — no resubmit loop; the way back is the "Back to sign in" link.
    expect(screen.queryByRole('button', { name: 'Email me a reset link' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login')
    expect(track).toHaveBeenCalledWith(EVENTS.passwordResetRequested)
  })

  // REG-052 — the endpoint 204s for every address, so the ONLY error path is transport
  // failure, and its copy must not leak account existence either.
  it('REG-052: a transport failure shows a retryable generic error, not a confirmation', async () => {
    mockPost.mockRejectedValueOnce(new Error('network down'))
    renderPage()

    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't send the email/i)
    // Still on the form, ready to retry; no track() for a failed request.
    expect(screen.getByRole('button', { name: 'Email me a reset link' })).toBeEnabled()
    expect(track).not.toHaveBeenCalled()
  })

  // REG-052 — jsdom enforces `required` + type=email: an empty/invalid address never POSTs.
  it('REG-052: an invalid email is blocked client-side (no POST)', async () => {
    renderPage()

    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    await waitFor(() => expect(mockPost).not.toHaveBeenCalled())
  })
})
