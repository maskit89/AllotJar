import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/02-registration-login.md — the reset-password
// page (REG-065, plus the client leg of REG-063): redeem the emailed link, confirm-mismatch
// guard, dead-link recovery, weak-password server feedback, incomplete-link state.
// Harness matches the repo convention (PR #169 gotcha): hoisted api mock fns,
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

import { ResetPasswordPage } from './ResetPasswordPage'
import { AuthProvider } from '../auth/AuthContext'
import { track, EVENTS } from '../analytics'

const LINK = '/reset-password?email=owner%40example.com&token=tok%2Babc'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/forgot-password" element={<div>FORGOT</div>} />
          <Route path="/login" element={<div>LOGIN</div>} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** The auth response AuthContext.apply() accepts after a successful reset. */
function authResponse() {
  return {
    token: 'tok-fresh',
    expiresAtUtc: '2999-01-01T00:00:00Z',
    userId: 'u1',
    email: 'owner@example.com',
    role: 0,
    displayName: 'Owner',
  }
}

function axiosError(data: unknown, status = 400) {
  return { isAxiosError: true, response: { status, data } }
}

async function fillPasswords(newPassword: string, confirm = newPassword) {
  await userEvent.type(screen.getByLabelText('New password'), newPassword)
  await userEvent.type(screen.getByLabelText('Confirm new password'), confirm)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('ResetPasswordPage (catalog REG-063/REG-065)', () => {
  // REG-063 (client leg) — a good link + matching passwords POSTs the decoded email/token,
  // adopts the session the server answers with, and lands signed in on the dashboard.
  it('REG-063: redeems the link, signs in and lands on the dashboard', async () => {
    mockPost.mockResolvedValueOnce({ data: authResponse() })
    // AuthContext's on-token effect fires /auth/me after apply(); a minimal envelope suffices.
    mockGet.mockResolvedValue({ data: { role: 0, email: 'owner@example.com', households: [] } })
    renderAt(LINK)

    // The page names the account being reset (decoded from the query) and warns that a reset
    // signs the user out of their other devices (REG-063 expected copy).
    expect(screen.getByText('owner@example.com')).toBeInTheDocument()
    expect(screen.getByText(/signs you out everywhere else/i)).toBeInTheDocument()

    await fillPasswords('Aa1-fresh-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    await screen.findByText('HOME')
    expect(mockPost).toHaveBeenCalledWith('/auth/reset-password', {
      email: 'owner@example.com',
      token: 'tok+abc', // URL-decoded — the raw token, exactly as the server minted it
      newPassword: 'Aa1-fresh-secret',
    })
    expect(track).toHaveBeenCalledWith(EVENTS.passwordResetCompleted)
  })

  // REG-065 — mismatched confirmation is caught client-side: inline alert, no POST.
  it('REG-065: mismatched passwords never reach the server', async () => {
    renderAt(LINK)

    await fillPasswords('Aa1-fresh-secret', 'Aa1-different')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/don't match/i)
    expect(mockPost).not.toHaveBeenCalled()
  })

  // REG-065 — the server's generic invalid-link 400 surfaces verbatim and unlocks the
  // "Request a new link" recovery path to /forgot-password.
  it('REG-065: a dead link shows the generic message plus a request-new-link way out', async () => {
    mockPost.mockRejectedValueOnce(
      axiosError({ error: 'That reset link is invalid or has expired. Please request a new one.' }),
    )
    renderAt(LINK)

    await fillPasswords('Aa1-fresh-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/invalid or has expired/i)
    await userEvent.click(screen.getByRole('button', { name: 'Request a new link' }))
    expect(screen.getByText('FORGOT')).toBeInTheDocument()
  })

  // REG-065 — Identity's password-policy errors array (weak/breached new password) is
  // joined and shown; no recovery button, because the LINK is still good for a retry.
  it('REG-065: weak-password server errors surface without the new-link button', async () => {
    mockPost.mockRejectedValueOnce(
      axiosError({ errors: ['Passwords must be at least 8 characters.', 'This password has appeared in a data breach.'] }),
    )
    renderAt(LINK)

    await fillPasswords('Aa1-weak')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('at least 8 characters')
    expect(alert.textContent).toContain('data breach')
    expect(screen.queryByRole('button', { name: 'Request a new link' })).not.toBeInTheDocument()
  })

  // REG-065 — a link missing its query parts renders the incomplete-link state (no form at
  // all) with the same request-new-link recovery.
  it('REG-065: an incomplete link gets the recovery state, not a doomed form', async () => {
    renderAt('/reset-password?email=owner%40example.com') // token missing

    expect(screen.getByText(/isn't complete/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Request a new link' }))
    expect(screen.getByText('FORGOT')).toBeInTheDocument()
  })
})
