/**
 * Pull the server's field messages out of an axios 400 (ASP.NET ValidationProblemDetails:
 * `{ errors: { Field: ["message", …] } }`), joined into one sentence for an error banner.
 * Null for anything that isn't a 400 with messages, so callers fall back to their own copy.
 */
export function serverErrors(err: unknown): string | null {
  const e = err as { response?: { status?: number; data?: { errors?: Record<string, string[]> } } }
  if (e?.response?.status !== 400) return null
  const messages = Object.values(e.response.data?.errors ?? {}).flat()
  return messages.length > 0 ? messages.join(' ') : null
}
