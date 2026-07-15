import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { api, getToken, setToken, navigation } from '../lib/api'
import { broadcastSignOut } from '../lib/authChannel'
import { AuthProvider, useAuth } from './AuthContext'

// Drive the real axios instance + interceptors through a scripted adapter (same technique as
// lib/api.test.ts) so this exercises the REAL module-level single-flight in lib/api.ts, not a mock.
function ok(data: unknown, config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config })
}

const REFRESHED = {
  token: 'boot-jwt',
  expiresAtUtc: '2030-01-01T00:00:00Z',
  userId: 'u1',
  email: 'dev@x.com',
  role: 0,
  displayName: 'Dev',
}

const ME = {
  userId: 'u1',
  email: 'dev@x.com',
  displayName: 'Dev',
  firstName: 'Dev',
  lastName: 'Eloper',
  role: 0,
  ownerId: 'u1',
  households: [],
  preferredCurrency: 'EUR',
  numberFormat: 'dot-comma',
}

// Surfaces the auth state so the test can wait for the cold-load bootstrap to settle.
function Probe() {
  const { bootstrapping, isAuthenticated } = useAuth()
  return (
    <div data-testid="probe">{bootstrapping ? 'loading' : isAuthenticated ? 'in' : 'out'}</div>
  )
}

const originalAdapter = api.defaults.adapter

describe('AuthProvider cold-load bootstrap', () => {
  beforeEach(() => {
    setToken(null) // no in-memory access token ⇒ the cold-load bootstrap fires
    localStorage.clear()
  })
  afterEach(() => {
    api.defaults.adapter = originalAdapter
  })

  // Regression guard for the StrictMode double-mount bug: two /auth/refresh calls race the same
  // rotating refresh cookie, the second presents the just-rotated token, and server-side reuse
  // detection burns every refresh token — randomly signing developers out on cold loads.
  it('issues exactly one /auth/refresh even when StrictMode double-mounts the provider', async () => {
    let refreshCalls = 0
    api.defaults.adapter = (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        return ok(REFRESHED, config)
      }
      if (url.includes('/auth/me')) return ok(ME, config)
      return ok({}, config)
    }

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    )

    // Wait for the (double-mounted) bootstrap effect to restore the session and settle.
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in'))

    expect(refreshCalls).toBe(1)
    expect(getToken()).toBe('boot-jwt') // the restored access token was stored
  })

  it('ends bootstrapping and stays signed out when there is no cookie session to restore', async () => {
    let refreshCalls = 0
    api.defaults.adapter = (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        // No valid refresh cookie ⇒ axios models the 401 as a rejection (as `settle` would).
        return Promise.reject({ response: { status: 401, data: {} }, config })
      }
      return ok({}, config)
    }

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    )

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'))

    expect(refreshCalls).toBe(1)
    expect(getToken()).toBeNull()
  })
})

// Renders a provider whose bootstrap succeeded, so each test starts from a signed-in tab —
// the state the session-expiry paths below act on.
async function renderSignedIn(adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>) {
  api.defaults.adapter = adapter
  render(
    <StrictMode>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </StrictMode>,
  )
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in'))
}

describe('mid-session expiry', () => {
  beforeEach(() => {
    setToken(null)
    localStorage.clear()
  })
  afterEach(() => {
    api.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
  })

  it('revalidates an expired token on tab focus and silently re-arms a live session', async () => {
    let refreshCalls = 0
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        return ok(REFRESHED, config)
      }
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })
    const bootstrapRefreshes = refreshCalls

    // Overnight: the access token's server-side lifetime has passed while the tab idled.
    setToken('boot-jwt', new Date(Date.now() - 1_000).toISOString())

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(refreshCalls).toBe(bootstrapRefreshes + 1))
    expect(screen.getByTestId('probe')).toHaveTextContent('in') // seamless — no bounce
    expect(getToken()).toBe('boot-jwt')
  })

  it('prompts sign-in (with the session-expired reason) when focus revalidation finds a dead session', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    let sessionDead = false
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        if (sessionDead) return Promise.reject({ response: { status: 401, data: {} }, config })
        return ok(REFRESHED, config)
      }
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })

    // The refresh cookie was revoked (or lapsed) while the tab idled past its token's lifetime.
    sessionDead = true
    setToken('boot-jwt', new Date(Date.now() - 1_000).toISOString())

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'))
    expect(getToken()).toBeNull()
    expect(localStorage.getItem('zbb.email')).toBeNull() // identity remnants cleared
    expect(assign).toHaveBeenCalledWith('/login?reason=expired')
  })

  it('does nothing on focus while the access token is still within its lifetime', async () => {
    let refreshCalls = 0
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        return ok(REFRESHED, config)
      }
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })
    const bootstrapRefreshes = refreshCalls

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(refreshCalls).toBe(bootstrapRefreshes) // REFRESHED expires in 2030 — nothing to do
    expect(screen.getByTestId('probe')).toHaveTextContent('in')
  })

  it('signs this tab out when another tab broadcasts a sign-out', async () => {
    await renderSignedIn((config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok(REFRESHED, config)
      return ok(url.includes('/auth/me') ? ME : {}, config)
    })

    await act(async () => {
      broadcastSignOut() // what logout()/sessionExpired() in another tab emits
    })

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'))
    expect(getToken()).toBeNull()
    expect(localStorage.getItem('zbb.email')).toBeNull()
  })
})
