import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import {
  api,
  getToken,
  setToken,
  isAccessTokenExpired,
  loginRedirectPath,
  navigation,
  setSessionHandlers,
} from './api'

// Drive the real axios instance (and its interceptors) through a scripted adapter so we can prove
// the 401 -> refresh -> retry behaviour without a network. A custom adapter bypasses axios's own
// status check, so a 401 is modelled as a rejection (as axios's `settle` would produce).
function ok(data: unknown, config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config })
}
function fail401(config: InternalAxiosRequestConfig): Promise<never> {
  return Promise.reject({ response: { status: 401, data: {} }, config })
}

const originalAdapter = api.defaults.adapter

describe('api 401 → refresh → retry interceptor', () => {
  beforeEach(() => setToken(null))
  afterEach(() => {
    api.defaults.adapter = originalAdapter
  })

  it('refreshes the access token and retries the original request once', async () => {
    let dataCalls = 0
    api.defaults.adapter = (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok({ token: 'fresh' }, config)
      dataCalls += 1
      // First hit 401s (expired access token); the retry after refresh succeeds.
      return dataCalls === 1 ? fail401(config) : ok({ value: 42 }, config)
    }

    const res = await api.get('/budget/current')

    expect(res.data).toEqual({ value: 42 })
    expect(getToken()).toBe('fresh') // the refreshed token was stored
    expect(dataCalls).toBe(2) // original + one retry
  })

  it('gives up (no retry) when the refresh itself fails', async () => {
    api.defaults.adapter = (config) => fail401(config)
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})

    try {
      await expect(api.get('/budget/current')).rejects.toMatchObject({ response: { status: 401 } })
      expect(getToken()).toBeNull()
    } finally {
      assign.mockRestore()
    }
  })

  it('does not try to refresh auth endpoints (no recursion)', async () => {
    let refreshCalls = 0
    api.defaults.adapter = (config) => {
      if ((config.url ?? '').includes('/auth/refresh')) refreshCalls += 1
      return fail401(config)
    }

    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ response: { status: 401 } })
    expect(refreshCalls).toBe(0)
  })

  it('DOES refresh-and-retry /auth/me — its 401 means expired session, not bad credentials', async () => {
    let meCalls = 0
    api.defaults.adapter = (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/refresh')) return ok({ token: 'fresh' }, config)
      meCalls += 1
      return meCalls === 1 ? fail401(config) : ok({ role: 0 }, config)
    }

    const res = await api.get('/auth/me')

    expect(res.data).toEqual({ role: 0 })
    expect(meCalls).toBe(2) // original + retry after refresh — /auth/me is not a credential endpoint
  })

  it('tears down the session and redirects to /login (with returnUrl) when the refresh fails', async () => {
    api.defaults.adapter = (config) => fail401(config)
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    const expired = vi.fn()
    setSessionHandlers({ refreshed: vi.fn(), expired })
    setToken('stale-jwt', '2030-01-01T00:00:00Z')

    try {
      await expect(api.get('/budget/current')).rejects.toMatchObject({ response: { status: 401 } })

      expect(expired).toHaveBeenCalledTimes(1) // AuthContext gets to clear its state
      expect(getToken()).toBeNull()
      // jsdom's test URL is "/" — the redirect carries the reason but no redundant returnUrl.
      expect(assign).toHaveBeenCalledWith('/login?reason=expired')
    } finally {
      setSessionHandlers(null)
      assign.mockRestore()
    }
  })

  it('notifies the refreshed handler so AuthContext state tracks interceptor-driven refreshes', async () => {
    const session = { token: 'fresh', expiresAtUtc: '2030-01-01T00:00:00Z', role: 0 }
    let dataCalls = 0
    api.defaults.adapter = (config) => {
      if ((config.url ?? '').includes('/auth/refresh')) return ok(session, config)
      dataCalls += 1
      return dataCalls === 1 ? fail401(config) : ok({}, config)
    }
    const refreshed = vi.fn()
    setSessionHandlers({ refreshed, expired: vi.fn() })

    try {
      await api.get('/budget/current')
      expect(refreshed).toHaveBeenCalledWith(expect.objectContaining({ token: 'fresh' }))
    } finally {
      setSessionHandlers(null)
    }
  })
})

describe('access-token expiry tracking', () => {
  afterEach(() => setToken(null))

  it('reports expiry only when a token exists and its lifetime has passed', () => {
    setToken(null)
    expect(isAccessTokenExpired()).toBe(false)

    setToken('jwt', new Date(Date.now() + 60_000).toISOString())
    expect(isAccessTokenExpired()).toBe(false)

    setToken('jwt', new Date(Date.now() - 1_000).toISOString())
    expect(isAccessTokenExpired()).toBe(true)

    setToken('jwt') // unknown expiry (e.g. legacy caller) — never treated as expired
    expect(isAccessTokenExpired()).toBe(false)
  })
})

describe('loginRedirectPath', () => {
  it('carries the current location as returnUrl and says why', () => {
    expect(loginRedirectPath('/transactions', '')).toBe(
      '/login?reason=expired&returnUrl=%2Ftransactions',
    )
    expect(loginRedirectPath('/accounts/abc', '?tab=history')).toBe(
      '/login?reason=expired&returnUrl=%2Faccounts%2Fabc%3Ftab%3Dhistory',
    )
  })

  it('omits a redundant returnUrl for the root and no-ops on /login itself', () => {
    expect(loginRedirectPath('/', '')).toBe('/login?reason=expired')
    expect(loginRedirectPath('/login', '')).toBeNull()
  })
})
