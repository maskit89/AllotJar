import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/17-invites.md (INV-*) — the public
// /accept-invite landing page (AcceptInvitePage.test.tsx keeps only INV-034,
// terms required before submit). The invite
// *modal* cases (INV-001..INV-013/015/019/051, the temp-password vs link send
// UI, role select, invited badge, revoke) live in PeoplePage — already covered
// by PeoplePage.catalog.test.tsx (PPL-044/045/049/038/040) + invite.spec.ts, so
// they are intentionally not re-tested here.
//
// Harness matches the repo convention: the shared api mock, page rendered inside
// <MemoryRouter><AuthProvider>. getToken/refreshSession are hoisted so a test can
// choose the signed-out invitee (default) or the already-signed-in variant.

const { mockGetToken, mockRefresh } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockRefresh: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => mockGetToken(),
    // Controls the cookie-bootstrap: null => signed-out invitee (the accept form);
    // a token via getToken() => the "already signed in" join variant.
    refreshSession: () => mockRefresh(),
  }),
)

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AcceptInvitePage } from './AcceptInvitePage'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

function renderAt(path: string) {
  return renderWithProviders(
    <>
      <AcceptInvitePage />
      <LocationProbe />
    </>,
    { route: path },
  )
}

/** A minimal AuthResponse the AuthContext.apply() path accepts on a successful accept. */
function authResponse(overrides: Record<string, unknown> = {}) {
  return {
    token: 'jwt',
    expiresAtUtc: '2999-01-01T00:00:00Z',
    userId: 'u-robin',
    email: 'robin@x.eu',
    role: 2,
    displayName: 'Robin',
    ...overrides,
  }
}

/** A plain object axios treats as an AxiosError (isAxiosError flag) so the page's
 *  extractError() flattens/surfaces the server body exactly as in production. */
function axiosError(data: unknown) {
  return { isAxiosError: true, response: { data } }
}

describe('AcceptInvitePage (INV catalog)', () => {
  beforeEach(() => {
    resetApiMocks()
    mockGetToken.mockReset()
    mockRefresh.mockReset()
    // Default: signed-out invitee. No stored token, cookie-bootstrap yields no
    // session, so the anonymous accept form renders.
    mockGetToken.mockReturnValue(null)
    mockRefresh.mockResolvedValue(null)
    mockGet.mockResolvedValue({ data: null })
  })

  // INV-033 — the anonymous invite landing renders its household-invite framing.
  it('INV-033: renders the household-invite intro and the accept form controls', async () => {
    renderAt('/accept-invite?code=ABC123')

    expect(await screen.findByText('Household invite', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Join the household' })).toBeInTheDocument()
    expect(screen.getByText(/pool income, split shared costs/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument()
  })

  // INV-034 — consent gating: the terms checkbox is required and the Terms/Privacy
  // links open the legal pages in a new tab.
  it('INV-034: the terms checkbox is required and the legal links open /terms and /privacy in a new tab', async () => {
    renderAt('/accept-invite?code=ABC123')

    expect(await screen.findByRole('checkbox', {}, { timeout: 5000 })).toBeRequired()

    const terms = screen.getByRole('link', { name: 'Terms of Service' })
    expect(terms).toHaveAttribute('href', '/terms')
    expect(terms).toHaveAttribute('target', '_blank')
    expect(terms).toHaveAttribute('rel', expect.stringContaining('noopener'))

    const privacy = screen.getByRole('link', { name: 'Privacy Policy' })
    expect(privacy).toHaveAttribute('href', '/privacy')
    expect(privacy).toHaveAttribute('target', '_blank')
  })

  // INV-035 — the password gate is enforced client-side (required + min length 8).
  it('INV-035: the password input enforces required + minLength=8 client-side', async () => {
    renderAt('/accept-invite?code=ABC123')

    const pwd = await screen.findByLabelText('Password', {}, { timeout: 5000 })
    expect(pwd).toBeRequired()
    expect(pwd).toHaveAttribute('minlength', '8')
    expect(pwd).toHaveAttribute('type', 'password')
  })

  // INV-036 — display name is optional: left blank the client sends displayName:undefined,
  // and on success the accepter lands on the joined dashboard (/?joined=1).
  it('INV-036: a blank name submits displayName undefined and lands on /?joined=1', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password', {}, { timeout: 5000 }), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/auth/accept-invite',
          expect.objectContaining({
            token: 'ABC123',
            password: 'password123',
            displayName: undefined,
            acceptedTerms: true,
          }),
        ),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/?joined=1'), { timeout: 5000 })
  })

  // INV-036 — a typed display name is forwarded to the accept request.
  it('INV-036: a typed display name is forwarded on the accept request', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText(/your name/i, {}, { timeout: 5000 }), 'Robin')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith(
          '/auth/accept-invite',
          expect.objectContaining({ displayName: 'Robin' }),
        ),
      { timeout: 5000 },
    )
  })

  // INV-033 — while the accept request is in flight the button shows the busy label
  // and is disabled, then the accepter is routed to /?joined=1.
  it('INV-033: shows the "Please wait…" busy state while submitting, then lands on /?joined=1', async () => {
    let resolveAccept!: (value: unknown) => void
    mockPost.mockImplementation(() => new Promise((res) => (resolveAccept = res)))
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password', {}, { timeout: 5000 }), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    const busy = await screen.findByRole('button', { name: 'Please wait…' }, { timeout: 5000 })
    expect(busy).toBeDisabled()

    resolveAccept({ data: authResponse() })
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/?joined=1'), { timeout: 5000 })
  })

  // INV-037 — anonymous accept for an email that already has an account: the server's
  // field error is surfaced and the form stays put (no navigation).
  it('INV-037: surfaces the "already have an account" server error and stays on the invite', async () => {
    mockPost.mockRejectedValue(
      axiosError({
        errors: { Email: ['You already have an account — sign in first, then open this link to join.'] },
      }),
    )
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password', {}, { timeout: 5000 }), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    const alert = await screen.findByText(
      'You already have an account — sign in first, then open this link to join.',
      {},
      { timeout: 5000 },
    )
    expect(alert).toHaveAttribute('role', 'alert')
    // No navigation on a rejected accept — still on the invite route.
    expect(screen.getByTestId('loc').textContent).toContain('/accept-invite')
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument()
  })

  // INV-045 — an expired-link server message is surfaced verbatim.
  it('INV-045: surfaces the server "expired link" message', async () => {
    mockPost.mockRejectedValue(axiosError({ title: 'This invite link has expired.' }))
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password', {}, { timeout: 5000 }), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    expect(await screen.findByText('This invite link has expired.', {}, { timeout: 5000 })).toHaveAttribute(
      'role',
      'alert',
    )
  })

  // INV-047 — a body with no message falls back to extractError's default copy.
  it('INV-047: an error body with no message shows the invalid/expired fallback', async () => {
    mockPost.mockRejectedValue(axiosError({}))
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.type(await screen.findByLabelText('Password', {}, { timeout: 5000 }), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    expect(
      await screen.findByText('This invite link is invalid or has expired.', {}, { timeout: 5000 }),
    ).toHaveAttribute('role', 'alert')
  })

  // INV-043 — "Sign in to accept" bounces through /login carrying the invite path,
  // URL-safe, in returnUrl so the token round-trips back to the invite.
  it('INV-043: "Sign in to accept" routes to /login with the invite path preserved in returnUrl', async () => {
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.click(await screen.findByRole('button', { name: 'Sign in to accept' }, { timeout: 5000 }))

    const expected = '/login?returnUrl=' + encodeURIComponent('/accept-invite?code=ABC123')
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(expected), { timeout: 5000 })
  })

  // INV-049 — "Not now" dismisses to /login for a signed-out visitor.
  it('INV-049: "Not now" sends a signed-out visitor to /login', async () => {
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.click(await screen.findByRole('button', { name: 'Not now' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/login'), { timeout: 5000 })
  })

  // INV-048 — a missing ?code short-circuits to an inline alert with no form/POST.
  it('INV-048: a missing ?code shows the alert and renders no accept form', async () => {
    renderAt('/accept-invite')

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(/missing its code/)
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // INV-038 — an already-signed-in existing user gets the join variant (no password /
  // no terms) and accepts token-only (POST /auth/accept-invite { token }).
  it('INV-038: a signed-in existing user sees the join box and accepts token-only', async () => {
    mockGetToken.mockReturnValue('jwt')
    mockGet.mockResolvedValue({
      data: { role: 0, email: 'dana@x.eu', displayName: 'Dana', households: [], ownerId: null },
    })
    mockPost.mockResolvedValue({ data: authResponse({ email: 'dana@x.eu' }) })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    expect(
      await screen.findByText(/Joining adds this household to your account/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(await screen.findByText('dana@x.eu', {}, { timeout: 5000 })).toBeInTheDocument()
    // The authenticated variant has neither the new-login password nor the terms box.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Accept invite' }))

    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/auth/accept-invite', { token: 'ABC123' }),
      { timeout: 5000 },
    )
  })

  // INV-040 — a signed-in accept whose email doesn't match the invite surfaces the
  // server's mismatch error.
  it('INV-040: a signed-in accept surfaces a mismatched-email server error', async () => {
    mockGetToken.mockReturnValue('jwt')
    mockGet.mockResolvedValue({
      data: { role: 0, email: 'other@x.eu', displayName: 'Other', households: [], ownerId: null },
    })
    mockPost.mockRejectedValue(
      axiosError({ errors: { Email: ['This invite was sent to a different email address.'] } }),
    )
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.click(await screen.findByRole('button', { name: 'Accept invite' }, { timeout: 5000 }))

    expect(
      await screen.findByText('This invite was sent to a different email address.', {}, { timeout: 5000 }),
    ).toHaveAttribute('role', 'alert')
  })

  // INV-049 — "Not now" dismisses to the dashboard (/) for a signed-in user.
  it('INV-049: "Not now" sends a signed-in user to the dashboard', async () => {
    mockGetToken.mockReturnValue('jwt')
    mockGet.mockResolvedValue({ data: { role: 0, email: 'dana@x.eu', households: [], ownerId: null } })
    const user = userEvent.setup()

    renderAt('/accept-invite?code=ABC123')

    await user.click(await screen.findByRole('button', { name: 'Not now' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'), { timeout: 5000 })
  })
})
