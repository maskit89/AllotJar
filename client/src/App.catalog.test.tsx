import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/03-session-auth-lifecycle.md (SESS-*),
// the route guards in App.tsx: RequireAuth, AuthedLoginRedirect, the bootstrap
// splash, and the cross-tab sign-out bounce. These exercise the REAL App routing
// tree (RequireAuth / AuthedLoginRedirect are not exported, so the whole App is
// rendered) with the page components stubbed to lightweight text so the guard
// decisions are asserted without mounting real, data-loading pages.
//
// lib/api is mocked (RoleGating/ConsentModal convention: hoisted fns +
// importOriginal spread) so the AuthProvider can be driven signed-in, signed-out
// or bootstrapping via `authState`. FeatureContext is left at its all-on default
// (no provider needed) so every guarded route is registered.

const { mockGet, mockPost, authState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  authState: { token: null as string | null, bootstrapping: false },
}))

vi.mock('./lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockGet, delete: mockGet },
  getToken: () => authState.token,
  setToken: vi.fn(),
  // Signed-out cold-load resolves null; the "bootstrapping" cases hold the promise
  // pending so the splash stays up.
  refreshSession: () =>
    authState.bootstrapping ? new Promise(() => {}) : Promise.resolve(null),
}))

// Every page becomes a text stub — a function component returning a string renders
// that text node, so `getByText` can assert which route resolved without any JSX in
// the hoisted mock factories.
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => 'LoginPage' }))
vi.mock('./pages/LandingPage', () => ({ LandingPage: () => 'LandingPage' }))
vi.mock('./pages/PrivacyPage', () => ({ PrivacyPage: () => 'PrivacyPage' }))
vi.mock('./pages/TermsPage', () => ({ TermsPage: () => 'TermsPage' }))
vi.mock('./pages/AcceptInvitePage', () => ({ AcceptInvitePage: () => 'AcceptInvitePage' }))
vi.mock('./pages/AccountPage', () => ({ AccountPage: () => 'AccountPage' }))
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => 'PeoplePage' }))
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: () => 'DashboardPage' }))
vi.mock('./pages/TransactionsPage', () => ({ TransactionsPage: () => 'TransactionsPage' }))
vi.mock('./pages/AccountsPage', () => ({ AccountsPage: () => 'AccountsPage' }))
vi.mock('./pages/AccountDetailPage', () => ({ AccountDetailPage: () => 'AccountDetailPage' }))
vi.mock('./pages/JarsPage', () => ({ JarsPage: () => 'JarsPage' }))
vi.mock('./pages/AllocationPage', () => ({ AllocationPage: () => 'AllocationPage' }))
vi.mock('./pages/ReportsPage', () => ({ ReportsPage: () => 'ReportsPage' }))
vi.mock('./pages/ImportPage', () => ({ ImportPage: () => 'ImportPage' }))
vi.mock('./pages/HelpPage', () => ({ HelpPage: () => 'HelpPage' }))
vi.mock('./onboarding/Onboarding', () => ({ Onboarding: () => null }))
vi.mock('./components/ConsentModal', () => ({ ConsentModal: () => null }))

import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { broadcastSignOut } from './lib/authChannel'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ME = {
  userId: 'u1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 0,
  ownerId: 'u1',
  memberId: null,
  needsConsent: false,
}

describe('SESS: App route guards & cross-tab sign-out', () => {
  beforeEach(() => {
    localStorage.clear()
    authState.token = null
    authState.bootstrapping = false
    mockGet.mockReset()
    mockPost.mockReset()
    mockGet.mockResolvedValue({ data: ME }) // /auth/me once a token exists
    mockPost.mockResolvedValue({ data: {} })
  })
  afterEach(() => vi.restoreAllMocks())

  // SESS-003 / SESS-021 — a signed-out deep link to a guarded route bounces to /login
  // carrying an encoded returnUrl and NO reason param (the user was never signed in).
  it('SESS-003/SESS-021: a signed-out deep link to /accounts bounces to /login?returnUrl=%2Faccounts (no reason)', async () => {
    authState.token = null

    renderApp('/accounts')

    await waitFor(
      () => expect(screen.getByTestId('loc')).toHaveTextContent('/login?returnUrl=%2Faccounts'),
      { timeout: 5000 },
    )
    expect(screen.getByTestId('loc').textContent).not.toContain('reason=expired')
    expect(screen.queryByText('AccountsPage')).not.toBeInTheDocument() // guarded page never mounts
  })

  // SESS-022 — the bare root is public: signed out it renders the LandingPage with no
  // stray returnUrl anywhere.
  it('SESS-022: signed out, the bare / renders the landing page and adds no returnUrl', async () => {
    authState.token = null

    renderApp('/')

    await waitFor(() => expect(screen.getByText('LandingPage')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByTestId('loc').textContent).toBe('/')
  })

  // SESS-022 — an already-signed-in visit to /login never shows the form: it replaces
  // straight to the dashboard.
  it('SESS-022: signed in, /login replaces to the dashboard (never renders the form)', async () => {
    authState.token = 'tok'

    renderApp('/login')

    await waitFor(() => expect(screen.getByText('DashboardPage')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByTestId('loc').textContent).toBe('/')
    expect(screen.queryByText('LoginPage')).not.toBeInTheDocument()
  })

  // SESS-022 — an authed visit to /login honours a safe internal returnUrl (used by the
  // invite flow to return to /accept-invite).
  it('SESS-022: signed in, /login?returnUrl=%2Ftransactions honours the returnUrl', async () => {
    authState.token = 'tok'

    renderApp('/login?returnUrl=%2Ftransactions')

    await waitFor(() => expect(screen.getByText('TransactionsPage')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByTestId('loc').textContent).toBe('/transactions')
  })

  // SESS-023 — a malicious returnUrl on an authed /login visit is neutralized to / by
  // safeInternalPath; the browser never navigates off-origin. (returnUrl.test.ts covers
  // the accept/reject table; this proves AuthedLoginRedirect actually uses it.)
  it('SESS-023: an off-origin returnUrl on authed /login is neutralized to /', async () => {
    authState.token = 'tok'

    for (const bad of ['https%3A%2F%2Fevil.example', '%2F%2Fevil.example', '%2F%5Cevil.example']) {
      const view = renderApp(`/login?returnUrl=${bad}`)
      await waitFor(() => expect(screen.getByText('DashboardPage')).toBeInTheDocument(), { timeout: 5000 })
      expect(screen.getByTestId('loc').textContent).toBe('/')
      view.unmount()
    }
  })

  // SESS-005 — during cold-load bootstrap the splash covers the landing, /login and
  // guarded routes alike, so an authed user never flashes the anonymous landing or the
  // login form, and a guarded route never bounces mid-bootstrap.
  it('SESS-005: the bootstrap splash covers /, /login and guarded routes without a premature bounce', async () => {
    authState.token = null
    authState.bootstrapping = true // refreshSession stays pending ⇒ bootstrapping never resolves

    for (const path of ['/', '/login', '/account']) {
      const view = renderApp(path)
      expect(screen.getByRole('status')).toBeInTheDocument() // the "Loading…" splash
      expect(screen.queryByText('LandingPage')).not.toBeInTheDocument()
      expect(screen.queryByText('LoginPage')).not.toBeInTheDocument()
      expect(screen.queryByText('AccountPage')).not.toBeInTheDocument()
      expect(screen.getByTestId('loc').textContent).toBe(path) // no bounce while bootstrapping
      view.unmount()
    }
  })

  // SESS-024 — a sign-out broadcast from another tab clears this signed-in tab's state,
  // so RequireAuth bounces it to /login with its returnUrl instead of it lingering on
  // budget data with a working in-memory token.
  it('SESS-024: another tab signing out bounces this tab from /transactions to /login?returnUrl=%2Ftransactions', async () => {
    authState.token = 'tok'

    renderApp('/transactions')
    await waitFor(() => expect(screen.getByText('TransactionsPage')).toBeInTheDocument(), { timeout: 5000 })

    await act(async () => {
      broadcastSignOut() // what logout()/sessionExpired() emits in another tab
      await Promise.resolve()
    })

    await waitFor(
      () => expect(screen.getByTestId('loc')).toHaveTextContent('/login?returnUrl=%2Ftransactions'),
      { timeout: 5000 },
    )
    expect(screen.queryByText('TransactionsPage')).not.toBeInTheDocument()
    expect(screen.getByTestId('loc').textContent).not.toContain('reason=expired') // a broadcast, not an expiry
  })
})
