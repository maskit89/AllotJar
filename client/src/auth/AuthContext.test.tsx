import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { api, getToken, setToken } from '../lib/api'
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
