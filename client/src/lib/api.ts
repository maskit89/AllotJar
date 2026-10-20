import axios from 'axios'
import type { AuthResponse, CommitImportItem, CsvMapping, ImportPreviewResult, ImportStatementResult } from '../types'
// Import the leaf modules directly (not the analytics barrel) to avoid an import cycle:
// the barrel pulls in the provider, which depends back on this api module.
import { track } from '../analytics/analytics'
import { EVENTS } from '../analytics/events'
import { apiEndpointTemplate } from '../analytics/redact'

/** Wire value of StatementFormat on the server. */
export type StatementFormat = 'HsbcCsv' | 'Camt053' | 'GenericCsv'

// The access token lives in memory only — never localStorage — so a successful XSS can't read a
// durable credential. The long-lived session sits in an HttpOnly refresh cookie the JS can't touch.
let accessToken: string | null = null
// Epoch ms of the access token's server-side expiry (AuthResponse.expiresAtUtc), so a tab that
// sat idle can tell its token has lapsed without waiting for an API call to 401.
let accessTokenExpiresAt: number | null = null

export function getToken(): string | null {
  return accessToken
}

export function setToken(token: string | null, expiresAtUtc?: string | null) {
  accessToken = token
  const parsed = token && expiresAtUtc ? Date.parse(expiresAtUtc) : NaN
  accessTokenExpiresAt = Number.isFinite(parsed) ? parsed : null
}

/** True when there IS an in-memory access token but its server-side lifetime has passed. */
export function isAccessTokenExpired(): boolean {
  return accessToken !== null && accessTokenExpiresAt !== null && Date.now() >= accessTokenExpiresAt
}

// AuthContext plugs in here so session events reach React state without an import cycle:
// `refreshed` keeps the provider's token/role in sync with interceptor-driven refreshes, and
// `expired` tears down auth state (and the localStorage identity) the moment a session dies.
interface SessionHandlers {
  refreshed: (session: AuthResponse) => void
  expired: () => void
}
let sessionHandlers: SessionHandlers | null = null

export function setSessionHandlers(handlers: SessionHandlers | null) {
  sessionHandlers = handlers
}

/**
 * The session is genuinely over (refresh token expired/revoked): drop the in-memory token, let
 * AuthContext tear its state down, and send the user to sign in. Where they were rides along in
 * ?returnUrl so signing back in lands them on the same page, and ?reason=expired lets the login
 * page say WHY they're seeing it instead of leaving a misleading page-level error behind.
 */
export function sessionExpired() {
  setToken(null)
  sessionHandlers?.expired()
  redirectToLogin()
}

// Indirection over window.location so tests can observe the redirect (jsdom's location is
// unforgeable — it can't be spied on or replaced).
export const navigation = {
  assign: (url: string) => window.location.assign(url),
}

/** The /login URL an expired session bounces to, or null when already on /login. */
export function loginRedirectPath(pathname: string, search: string): string | null {
  if (pathname.startsWith('/login')) return null
  const here = `${pathname}${search}`
  const returnUrl = here !== '/' ? `&returnUrl=${encodeURIComponent(here)}` : ''
  return `/login?reason=expired${returnUrl}`
}

// A full navigation also re-bootstraps a clean auth state. No-op if we're already on /login.
function redirectToLogin() {
  if (typeof window === 'undefined') return
  const target = loginRedirectPath(window.location.pathname, window.location.search)
  if (target) navigation.assign(target)
}

// All requests go to the same-origin "/api" prefix, which Vite proxies to the .NET API in dev. In
// production the SPA is served behind the same host. withCredentials so the refresh cookie rides along.
export const api = axios.create({ baseURL: '/api', withCredentials: true })

/** True when the app runs installed (opened from the home screen), not in a browser tab. */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

// Attach the in-memory bearer token to every outgoing request, and say when the app runs installed
// so the list of signed-in devices can tell "AllotJar app on iPhone" from "Safari on iPhone".
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  if (isInstalledApp()) {
    config.headers['X-AllotJar-App'] = '1'
  }
  return config
})

// Single-flight session refresh, shared by the 401 interceptor below and the AuthContext cold-load
// bootstrap. Several callers can want to refresh at once: a burst of requests 401 together when the
// access token expires, and — critically — React StrictMode double-invokes the bootstrap effect in
// dev, firing it twice on a cold load. Each /auth/refresh rotates the HttpOnly refresh cookie, so a
// second concurrent call would present the just-rotated token and trip the server's reuse detection,
// which burns EVERY refresh token (random dev/e2e sign-outs). One shared in-flight promise means the
// cookie is presented and rotated exactly once no matter how many callers race.
let sessionRefresh: Promise<AuthResponse | null> | null = null

/** /auth/refresh got no answer the session can be judged on (see {@link refreshSession}). */
export class SessionUnreachableError extends Error {
  constructor() {
    super('The server could not be reached to refresh the session.')
    this.name = 'SessionUnreachableError'
  }
}

function refreshWasUnreachable(err: unknown): boolean {
  return typeof (err as { response?: { status?: number } } | null)?.response?.status !== 'number'
}

/**
 * Restore the session from the HttpOnly refresh cookie, storing the new in-memory access token.
 * Concurrent callers share a single in-flight /auth/refresh POST. Resolves to the auth payload, or
 * null if the server answered without one (cookie missing/expired/revoked, or a server error).
 * Rejects with {@link SessionUnreachableError}, leaving the token as it was, when no answer came.
 */
export function refreshSession(): Promise<AuthResponse | null> {
  if (!sessionRefresh) {
    sessionRefresh = api
      .post<AuthResponse>('/auth/refresh')
      .then((res) => {
        const data = res?.data?.token ? res.data : null
        setToken(data?.token ?? null, data?.expiresAtUtc)
        // Keep AuthContext in step with interceptor-driven refreshes too — otherwise its token
        // state holds the old JWT and the /auth/me-on-token-change effect never refires, so
        // overnight role/preference changes wouldn't be picked up until a hard reload.
        if (data) sessionHandlers?.refreshed(data)
        return data
      })
      .catch((err) => {
        // Only no answer at all (a laptop waking before its Wi-Fi is back) keeps the session: the
        // request may never have reached the server. Any answer, a 5xx included, ends it as before,
        // since the server may already have rotated the cookie, and a later replay of the old one
        // outside the grace window would sign out every device (#302 review P2-1).
        if (refreshWasUnreachable(err)) throw new SessionUnreachableError()
        setToken(null)
        return null
      })
      .finally(() => {
        sessionRefresh = null
      })
  }
  return sessionRefresh
}

// Endpoints where a 401 means "bad credentials / not signed in yet", never "expired session":
// refreshing there would recurse (/auth/refresh) or turn real sign-in feedback into a bounce.
// Deliberately NOT the whole /auth/ prefix — a 401 from /auth/me, /auth/preferences or
// /auth/change-password IS an expired session and must refresh-and-retry like any other call
// (the blanket prefix made /account a dead end that could never prompt re-login).
const CREDENTIAL_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/accept-invite', '/auth/logout', '/auth/forgot-password', '/auth/reset-password', '/auth/confirm-email', '/auth/google']

// On a 401 from a normal API call, transparently refresh the access token (via the HttpOnly cookie)
// and retry once.
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status: number | undefined = error.response?.status
    const original = error.config
    const url: string = original?.url ?? ''
    const isCredentialEndpoint = CREDENTIAL_ENDPOINTS.some((endpoint) => url.includes(endpoint))

    if (status === 401 && original && !original.__retried && !isCredentialEndpoint) {
      original.__retried = true
      let session: AuthResponse | null
      try {
        session = await refreshSession()
      } catch {
        // The server could not be reached: the call fails as it would offline, and the session
        // stays for the next request to refresh.
        trackApiError(error, status)
        return Promise.reject(error)
      }
      if (session?.token) {
        original.headers = original.headers ?? {}
        original.headers.Authorization = `Bearer ${session.token}`
        return api(original)
      }
      // Refresh failed — the session is genuinely over.
      sessionExpired()
    }

    trackApiError(error, status)
    return Promise.reject(error)
  },
)

// One central hook for every failed request: report the endpoint shape + status only
// (no bodies, params or ids). No-ops unless analytics is live.
function trackApiError(error: { config?: { url?: string } }, status: number | undefined) {
  track(EVENTS.apiError, {
    api_endpoint: apiEndpointTemplate(error.config?.url),
    api_status: typeof status === 'number' ? status : 0,
  })
}

/** Parse a statement and get the not-yet-imported rows to review — nothing is saved yet. */
export async function previewImport(
  file: File,
  format: StatementFormat,
  opts?: { mapping?: CsvMapping | null; defaultCurrency?: string; accountId?: string | null },
): Promise<ImportPreviewResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('format', format)
  // Generic CSV: send the confirmed column mapping (omit on the first upload → server auto-detects).
  if (opts?.mapping) form.append('mapping', JSON.stringify(opts.mapping))
  if (opts?.defaultCurrency) form.append('defaultCurrency', opts.defaultCurrency)
  // Scope the already-imported filter to the statement's account, matching the commit's dedup.
  if (opts?.accountId) form.append('accountId', opts.accountId)
  const { data } = await api.post<ImportPreviewResult>('/import/preview', form)
  return data
}

/** Persist the reviewed rows. Idempotent — already-imported rows are skipped server-side. */
export async function commitImport(
  accountId: string | null,
  items: CommitImportItem[],
): Promise<ImportStatementResult> {
  const { data } = await api.post<ImportStatementResult>('/import/commit', { accountId, items })
  return data
}

/**
 * "Download my data": the server's zip of everything this login can see (JSON plus a CSV per
 * table), saved under the name the server gives it.
 */
export async function downloadMyData(): Promise<void> {
  const response = await api.get<Blob>('/export', { responseType: 'blob' })
  const disposition = String(response.headers['content-disposition'] ?? '')
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'allotjar-data.zip'
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Some browsers start the save after click() returns: free the blob once they have it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
