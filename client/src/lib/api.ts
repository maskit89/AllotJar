import axios from 'axios'
import type { CommitImportItem, CsvMapping, ImportPreviewResult, ImportStatementResult } from '../types'
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

export function getToken(): string | null {
  return accessToken
}

export function setToken(token: string | null) {
  accessToken = token
}

// When the session can't be refreshed (refresh token expired/revoked), send the user to sign in.
// A full navigation also re-bootstraps a clean auth state. No-op if we're already on /login.
function redirectToLogin() {
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.assign('/login')
  }
}

// All requests go to the same-origin "/api" prefix, which Vite proxies to the .NET API in dev. In
// production the SPA is served behind the same host. withCredentials so the refresh cookie rides along.
export const api = axios.create({ baseURL: '/api', withCredentials: true })

// Attach the in-memory bearer token to every outgoing request.
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Single-flight refresh: many requests may 401 at once when the access token expires; they all wait
// on one /auth/refresh call rather than stampeding it.
let refreshing: Promise<string | null> | null = null
function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = api
      .post<{ token?: string }>('/auth/refresh')
      .then((res) => {
        const token = res?.data?.token ?? null
        setToken(token)
        return token
      })
      .catch(() => {
        setToken(null)
        return null
      })
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

// On a 401 from a normal API call, transparently refresh the access token (via the HttpOnly cookie)
// and retry once. Auth endpoints are excluded so /auth/refresh can't recurse and a failed login
// isn't mistaken for an expired session.
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status: number | undefined = error.response?.status
    const original = error.config
    const url: string = original?.url ?? ''
    const isAuthEndpoint = url.includes('/auth/')

    if (status === 401 && original && !original.__retried && !isAuthEndpoint) {
      original.__retried = true
      const token = await refreshAccessToken()
      if (token) {
        original.headers = original.headers ?? {}
        original.headers.Authorization = `Bearer ${token}`
        return api(original)
      }
      // Refresh failed — the session is genuinely over.
      redirectToLogin()
    }

    // One central hook for every failed request: report the endpoint shape + status only
    // (no bodies, params or ids). No-ops unless analytics is live.
    track(EVENTS.apiError, {
      api_endpoint: apiEndpointTemplate(error.config?.url),
      api_status: typeof status === 'number' ? status : 0,
    })
    return Promise.reject(error)
  },
)

/** Parse a statement and get the not-yet-imported rows to review — nothing is saved yet. */
export async function previewImport(
  file: File,
  format: StatementFormat,
  opts?: { mapping?: CsvMapping | null; defaultCurrency?: string },
): Promise<ImportPreviewResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('format', format)
  // Generic CSV: send the confirmed column mapping (omit on the first upload → server auto-detects).
  if (opts?.mapping) form.append('mapping', JSON.stringify(opts.mapping))
  if (opts?.defaultCurrency) form.append('defaultCurrency', opts.defaultCurrency)
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
