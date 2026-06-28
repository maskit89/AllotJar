// The PII safety net. Everything sent to GA passes through here first, so a record id,
// amount, email or free-text value can never leak into analytics — even if a call site
// is careless. Redaction is enforced in code, not by convention.

/**
 * A path segment that looks like a record id, token or anything non-structural.
 * We replace these with `:id` so URLs collapse to route templates (`/account/abc` →
 * `/account/:id`) and never carry a real identifier.
 */
function looksLikeId(segment: string): boolean {
  if (!segment) return false
  return (
    /^\d+$/.test(segment) || // pure number
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || // uuid
    /^[0-9a-f]{16,}$/i.test(segment) || // long hex / opaque token
    (segment.length > 16 && /\d/.test(segment)) // long mixed token
  )
}

/**
 * Collapse a real pathname to a safe route template: drop the query/hash, then replace
 * any id-like segment with `:id`. The result is the only "page" value GA ever sees.
 */
export function redactPath(pathname: string): string {
  const path = (pathname.split('?')[0].split('#')[0] || '/').replace(/\/+$/, '') || '/'
  if (path === '/') return '/'
  const template = path
    .split('/')
    .map((seg) => (looksLikeId(seg) ? ':id' : seg))
    .join('/')
  return template || '/'
}

/**
 * The same collapsing for an API request path, so the `api_error` event reports an
 * endpoint shape (`/budget/:id/:id`) rather than a specific resource.
 */
export function apiEndpointTemplate(url: string | undefined): string {
  if (!url) return 'unknown'
  // axios urls are relative to the `/api` baseURL (e.g. "/budget/2026/6").
  const noQuery = url.split('?')[0]
  return redactPath(noQuery)
}

/**
 * Event-parameter whitelist. Only these keys are ever forwarded to GA, and only when their
 * value is a primitive (string/number/boolean). Anything else — unknown keys, objects,
 * raw amounts, names — is dropped. Keep this list curated and PII-free.
 */
const ALLOWED_PARAM_KEYS: ReadonlySet<string> = new Set([
  'method', // login method, etc.
  'line_type', // 'income' | 'expense' | 'savings'
  'direction', // 'prev' | 'next'
  'report_type', // 'trends' | 'annual' | 'breakdown'
  'destination', // a redacted route template for nav clicks
  'theme', // 'light' | 'dark'
  'row_bucket', // bucketed import row count
  'count_bucket', // bucketed count of anything
  'status', // a known enum status string
  'kind', // a known enum (fund kind, account type label, etc.)
  'split', // allocation split method label
  'step', // onboarding step index (number)
  'source', // generic safe source/origin label
  'context', // generic safe context label
  'api_endpoint', // redacted endpoint template
  'api_status', // numeric HTTP status
  'error_kind', // a coarse error category, never a message
  'consent', // 'granted' | 'denied'
])

export type SafeParams = Record<string, string | number | boolean>

/** Filter arbitrary params down to the whitelisted, primitive-valued subset. */
export function safeParams(params?: Record<string, unknown>): SafeParams {
  const out: SafeParams = {}
  if (!params) return out
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_PARAM_KEYS.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/**
 * Bucket a raw count into a coarse range so we learn "how many" without sending exact
 * figures that could, in aggregate, be sensitive.
 */
export function bucketCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n === 1) return '1'
  if (n <= 10) return '2-10'
  if (n <= 50) return '11-50'
  if (n <= 200) return '51-200'
  return '200+'
}
