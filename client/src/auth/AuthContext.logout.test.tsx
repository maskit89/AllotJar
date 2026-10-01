import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { api, setToken } from '../lib/api'
import { AuthProvider, useAuth } from './AuthContext'

// CL-P3-2 (end-to-end check 30 Sep, fixed in PR E): clearAuthState (AuthContext.tsx:465-486) resets the token,
// identity, role, households, consent, password/Google flags, currencies and the localStorage keys,
// but NOT memberId, sharingReviewPending or ownBudgetCurrencyState. After a logout the next login in
// the same tab (a second household member on a shared device) reads the previous login's memberId
// until its own /auth/me answers: AccountsPage's `ownPersonal` (memberId === the one holder) and the
// "You" labels key off it.
function ok(data: unknown, config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config })
}

const SESSION = { token: 'jwt-a', expiresAtUtc: '2030-01-01T00:00:00Z', userId: 'u1', email: 'a@x.eu', role: 0, displayName: 'A' }
const ME_A = { userId: 'u1', email: 'a@x.eu', displayName: 'A', role: 0, ownerId: 'u1', households: [], memberId: 'member-a', sharingReviewPending: true, ownBudgetCurrency: 'GBP' }

function Probe() {
  const { isAuthenticated, memberId, sharingReviewPending, ownBudgetCurrency, login, logout } = useAuth()
  return (
    <div>
      <div data-testid="state">{isAuthenticated ? 'in' : 'out'}|{memberId ?? 'null'}|{String(sharingReviewPending)}|{ownBudgetCurrency}</div>
      <button onClick={() => void login('a@x.eu', 'pw')}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  )
}

const originalAdapter = api.defaults.adapter

describe('AuthContext: logout clears every cached identity field', () => {
  beforeEach(() => {
    setToken(null)
    localStorage.clear()
    api.defaults.adapter = (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/login')) return ok(SESSION, config)
      if (url.includes('/auth/me')) return ok(ME_A, config)
      if (url.includes('/auth/refresh')) return Promise.reject({ response: { status: 401 }, config })
      return ok({}, config)
    }
  })
  afterEach(() => {
    api.defaults.adapter = originalAdapter
    setToken(null)
  })

  it('memberId, sharingReviewPending and ownBudgetCurrency go back to their defaults on logout', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent(/^out\|/))
    await act(async () => screen.getByText('login').click())
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('in|member-a|true|GBP'))

    await act(async () => screen.getByText('logout').click())

    // Signed out: nothing of A's identity should remain for the next login to inherit.
    expect(screen.getByTestId('state')).toHaveTextContent('out|null|false|EUR')
  })
})
