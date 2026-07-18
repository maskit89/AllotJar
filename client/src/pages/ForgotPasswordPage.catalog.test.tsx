import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/02-registration-login.md — the forgot-password
// page (REG-052): request a reset link, non-enumerating confirmation, transport-failure
// handling. Harness matches the repo convention (PR #169 gotcha): hoisted api mock fns,
// vi.mock('../lib/api') spreading importOriginal, page inside <MemoryRouter><AuthProvider>.

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: vi.fn(), delete: vi.fn() },
  getToken: () => null,
  setToken: vi.fn(),
  refreshSession: () => Promise.resolve(null),
}))

vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

import { ForgotPasswordPage } from './ForgotPasswordPage'
import { AuthProvider } from '../auth/AuthContext'
import { track, EVENTS } from '../analytics'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <AuthProvider>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
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
