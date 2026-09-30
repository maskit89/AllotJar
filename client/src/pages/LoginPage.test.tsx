import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { envState } = vi.hoisted(() => ({
  envState: { isStaging: false },
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    // Signed-out cold-load bootstrap: no cookie session to restore, so the sign-in form renders.
    refreshSession: () => Promise.resolve(null),
  }),
)

// Build-time env flag — default off so the existing single-checkbox tests are unaffected.
vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return envState.isStaging
  },
  get APP_ENV() {
    return envState.isStaging ? 'staging' : undefined
  },
}))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { LoginPage } from './LoginPage'
import { AuthProvider } from '../auth/AuthContext'

const renderPage = () => renderWithProviders(<LoginPage />)

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear()
    envState.isStaging = false
    resetApiMocks()
    mockGet.mockResolvedValue({
      data: { userId: 'u1', email: 'new@x.com', displayName: 'New User', role: 0, ownerId: 'u1', memberId: null },
    })
  })

  it('returns to a safe internal returnUrl after signing in (e.g. back to an invite link)', async () => {
    mockPost.mockResolvedValue({
      data: {
        token: 'tok',
        expiresAtUtc: '2030-01-01T00:00:00Z',
        userId: 'u1',
        email: 'sam@x.com',
        role: 0,
        displayName: null,
      },
    })
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/login?returnUrl=%2Faccept-invite%3Fcode%3DABC123']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/accept-invite" element={<div>INVITE PROBE</div>} />
            <Route path="*" element={<div>ELSEWHERE</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await user.type(screen.getByLabelText('Email'), 'sam@x.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    // Both the mode toggle and the submit button are named "Sign in" — take the submit.
    const submit = screen
      .getAllByRole('button', { name: 'Sign in' })
      .find((b) => b.getAttribute('type') === 'submit')!
    await user.click(submit)

    expect(await screen.findByText('INVITE PROBE', undefined, { timeout: 5000 })).toBeInTheDocument()
  })

  it('submits the full profile + preferences when creating an account', async () => {
    mockPost.mockResolvedValue({
      data: {
        token: 'tok',
        expiresAtUtc: '2030-01-01T00:00:00Z',
        userId: 'u1',
        email: 'new@x.com',
        role: 0,
        displayName: 'New User',
      },
    })
    const user = userEvent.setup()
    renderPage()

    // The segmented toggle is the only "Create account" control until we switch mode.
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await user.type(screen.getByLabelText('First name'), 'New')
    await user.type(screen.getByLabelText('Last name'), 'User')
    await user.type(screen.getByLabelText('Email'), 'new@x.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.selectOptions(screen.getByLabelText('Currency'), 'GBP')
    await user.selectOptions(screen.getByLabelText('Number format'), 'comma-dot')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))

    const submit = screen
      .getAllByRole('button', { name: 'Create account' })
      .find((b) => (b as HTMLButtonElement).type === 'submit')!
    await user.click(submit)

    // Rule 81: there is no sample data — the household starts empty, and no flag is sent.
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/register', {
        email: 'new@x.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
        preferredCurrency: 'GBP',
        numberFormat: 'comma-dot',
        acceptedTerms: true,
      }),
    )
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('includeSampleData')
  })

  it('adds a required data-loss acknowledgment when registering in the staging build', async () => {
    envState.isStaging = true
    mockPost.mockResolvedValue({
      data: {
        token: 'tok',
        expiresAtUtc: '2030-01-01T00:00:00Z',
        userId: 'u1',
        email: 'new@x.com',
        role: 0,
        displayName: 'New User',
      },
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Create account' }))

    // The staging build shows an extra required checkbox: the data-loss acknowledgment
    // (alongside the required terms box).
    expect(
      screen.getByText(/my data may be reset or permanently lost/i),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    const stagingBox = screen.getByRole('checkbox', { name: /staging/i })
    expect((stagingBox as HTMLInputElement).required).toBe(true)

    await user.type(screen.getByLabelText('First name'), 'New')
    await user.type(screen.getByLabelText('Last name'), 'User')
    await user.type(screen.getByLabelText('Email'), 'new@x.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(stagingBox)

    const submit = screen
      .getAllByRole('button', { name: 'Create account' })
      .find((b) => (b as HTMLButtonElement).type === 'submit')!
    await user.click(submit)

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/register',
        expect.objectContaining({ email: 'new@x.com', acceptedTerms: true }),
      ),
    )
  })
})
