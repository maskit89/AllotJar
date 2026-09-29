import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { api, getToken, setToken, navigation } from '../lib/api'
import { onSignOutBroadcast } from '../lib/authChannel'
import { AuthProvider, useAuth } from './AuthContext'

// Catalog coverage for docs/testing/cases/03-session-auth-lifecycle.md (SESS-*),
// the AuthContext session lifecycle. These COMPLEMENT the six cases already in
// AuthContext.test.tsx (one refresh under StrictMode; stays signed out without a
// cookie; focus re-arms a live session; focus prompts on a dead session; no-op
// focus in lifetime; broadcast RECEIVE signs this tab out) and DO NOT duplicate
// them — here: logout() mechanics + localStorage wipe, memory-only token,
// interceptor-driven role re-sync, change-password apply, and broadcast EMIT on
// a dying session.
//
// Harness matches AuthContext.test.tsx: the REAL axios adapter is scripted so the
// module-level single-flight in lib/api.ts runs for real, and a <Probe> surfaces
// the auth state (plus buttons for the side-effectful paths).

function ok(data: unknown, config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config })
}
function fail(status: number, config: InternalAxiosRequestConfig): Promise<never> {
  return Promise.reject({ response: { status, data: {} }, config })
}

// A signed-in session as delivered by /auth/refresh on cold-load bootstrap.
const REFRESHED = {
  token: 'boot-jwt',
  expiresAtUtc: '2030-01-01T00:00:00Z',
  userId: 'u1',
  email: 'dev@x.com',
  role: 0,
  displayName: 'Dev',
}

// /auth/me — GBP + dot-comma so the logout reset back to the app defaults (EUR /
// comma-dot) is observable.
const ME = {
  userId: 'u1',
  email: 'dev@x.com',
  displayName: 'Dev',
  firstName: 'Dev',
  lastName: 'Eloper',
  role: 0,
  ownerId: 'u1',
  households: [],
  preferredCurrency: 'GBP',
  numberFormat: 'dot-comma',
}

function Probe() {
  const { bootstrapping, isAuthenticated, isReadOnly, role, logout, changePassword } = useAuth()
  return (
    <div>
      <div data-testid="probe">{bootstrapping ? 'loading' : isAuthenticated ? 'in' : 'out'}</div>
      <div data-testid="role">{isReadOnly ? 'read-only' : `role-${role}`}</div>
      <button onClick={() => logout()}>signout</button>
      <button onClick={() => void api.get('/budget/current').catch(() => {})}>act</button>
      <button onClick={() => void changePassword('old-pass', 'new-pass').catch(() => {})}>changepw</button>
    </div>
  )
}

const originalAdapter = api.defaults.adapter

async function renderSignedIn(adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>) {
  api.defaults.adapter = adapter
  render(
    <StrictMode>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </StrictMode>,
  )
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in'), { timeout: 5000 })
}

const standardAdapter = (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/auth/refresh')) return ok(REFRESHED, config)
  return ok(url.includes('/auth/me') ? ME : {}, config)
}

describe('SESS: AuthContext session lifecycle', () => {
  beforeEach(() => {
    setToken(null) // no in-memory token ⇒ the cold-load bootstrap fires
    localStorage.clear()
  })
  afterEach(() => {
    api.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
  })

  // SESS-006 — the access token lives in memory only: it is stored via setToken (not
  // localStorage), so a successful XSS can't read a durable credential. localStorage
  // holds only identity hints.
  it('SESS-006: the access token is memory-only — never in localStorage, only identity + pref hints are', async () => {
    await renderSignedIn(standardAdapter)
    await waitFor(() => expect(localStorage.getItem('zbb.currency')).toBe('GBP'), { timeout: 5000 })

    expect(getToken()).toBe('boot-jwt')
    const stored: string[] = []
    for (let i = 0; i < localStorage.length; i++) stored.push(localStorage.getItem(localStorage.key(i)!) as string)
    expect(stored).not.toContain('boot-jwt') // the JWT appears NOWHERE in storage

    expect(localStorage.getItem('zbb.email')).toBe('dev@x.com')
    expect(localStorage.getItem('zbb.role')).toBe('0')
    expect(localStorage.getItem('zbb.displayName')).toBe('Dev')
  })

  // SESS-037 — signing out via the menu: the fire-and-forget POST /auth/logout goes
  // out, the in-memory token drops, the identity hints are removed, and the money
  // prefs reset to the app defaults (EUR / comma-dot). The whole client wipe is
  // jsdom-observable; only the server semantics live in the journey layer.
  it('SESS-037: sign out posts /auth/logout, clears the token, wipes identity hints and resets money prefs', async () => {
    let logoutPosts = 0
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok(REFRESHED, config)
      if (url.includes('/auth/logout')) {
        logoutPosts += 1
        return ok({}, config)
      }
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })
    await waitFor(() => expect(localStorage.getItem('zbb.currency')).toBe('GBP'), { timeout: 5000 })

    const user = userEvent.setup()
    await user.click(screen.getByText('signout'))

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'), { timeout: 5000 })
    expect(logoutPosts).toBe(1)
    expect(getToken()).toBeNull()
    expect(localStorage.getItem('zbb.email')).toBeNull()
    expect(localStorage.getItem('zbb.role')).toBeNull()
    expect(localStorage.getItem('zbb.displayName')).toBeNull()
    // Money prefs snap back to the neutral fallbacks.
    expect(localStorage.getItem('zbb.currency')).toBe('EUR')
    expect(localStorage.getItem('zbb.numberFormat')).toBe('comma-dot')
  })

  // SESS-038 — logout is fire-and-forget: even when POST /auth/logout fails (offline),
  // the local sign-out still completes and no error surfaces (`.catch(() => {})`).
  it('SESS-038: a failed /auth/logout still signs the tab out locally, with no error surfaced', async () => {
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok(REFRESHED, config)
      if (url.includes('/auth/logout')) return Promise.reject(new Error('offline'))
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })
    await waitFor(() => expect(localStorage.getItem('zbb.email')).toBe('dev@x.com'), { timeout: 5000 })

    const user = userEvent.setup()
    await user.click(screen.getByText('signout'))

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'), { timeout: 5000 })
    expect(getToken()).toBeNull()
    expect(localStorage.getItem('zbb.email')).toBeNull()
  })

  // SESS-013 — an interceptor-driven refresh re-syncs AuthContext: because the refresh
  // rotates to a NEW token, the /auth/me-on-token-change effect refires and a role
  // downgrade to read-only is picked up with no hard reload.
  it('SESS-013: an interceptor-driven refresh re-syncs a role downgrade to read-only without a reload', async () => {
    let refreshCalls = 0
    let meRole = 0
    let dataCalls = 0
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        // Bootstrap keeps boot-jwt; the interceptor-driven refresh rotates the token so
        // the token-change effect refires /auth/me.
        return ok({ ...REFRESHED, token: refreshCalls === 1 ? 'boot-jwt' : 'rotated-jwt' }, config)
      }
      if (url.includes('/auth/me')) return ok({ ...ME, role: meRole }, config)
      // A plain data call that 401s once, forcing the interceptor to refresh.
      dataCalls += 1
      return dataCalls === 1 ? fail(401, config) : ok({}, config)
    })
    // Confirm the bootstrap /auth/me settled as Owner BEFORE the downgrade, so the
    // read-only state can only have come from the interceptor-driven refresh.
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('role-0'), { timeout: 5000 })

    meRole = 3 // server downgraded this login to ReadOnly
    const user = userEvent.setup()
    await user.click(screen.getByText('act'))

    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('read-only'), { timeout: 5000 })
    expect(getToken()).toBe('rotated-jwt')
  })

  // SESS-040 — the client leg of change-password: the 200 AuthResponse carries a fresh
  // token + rotated cookie, which the changing device applies so it carries on
  // seamlessly (no sign-out, no bounce). The multi-device revocation is the journey's.
  it('SESS-040: changing the password applies the returned session so the changing device continues', async () => {
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok(REFRESHED, config)
      if (url.includes('/auth/change-password')) return ok({ ...REFRESHED, token: 'post-change-jwt' }, config)
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })
    expect(getToken()).toBe('boot-jwt')

    const user = userEvent.setup()
    await user.click(screen.getByText('changepw'))

    await waitFor(() => expect(getToken()).toBe('post-change-jwt'), { timeout: 5000 })
    expect(screen.getByTestId('probe')).toHaveTextContent('in') // still signed in — seamless
  })

  // SESS-025 — a session dying in THIS tab (detected on an API action) doesn't just
  // bounce this tab: its `expired` handler broadcasts 'signed-out' so other tabs
  // converge on the sign-in prompt instead of lingering as zombies.
  it('SESS-025: a session dying in this tab broadcasts a sign-out to the other tabs', async () => {
    const otherTab = vi.fn()
    const unsubscribe = onSignOutBroadcast(otherTab) // a second "tab" listening on zbb.auth
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    let sessionDead = false
    try {
      await renderSignedIn((config) => {
        const url = config.url ?? ''
        if (url.includes('/auth/refresh')) return sessionDead ? fail(401, config) : ok(REFRESHED, config)
        if (url.includes('/budget')) return fail(401, config)
        return ok(url.includes('/auth/me') ? ME : {}, config)
      })

      sessionDead = true // the refresh cookie was revoked
      const user = userEvent.setup()
      await user.click(screen.getByText('act')) // any API action now detects the dead session

      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'), { timeout: 5000 })
      expect(assign).toHaveBeenCalledWith('/login?reason=expired')
      await waitFor(() => expect(otherTab).toHaveBeenCalledTimes(1), { timeout: 5000 })
    } finally {
      unsubscribe()
    }
  })
})
