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

/**
 * The server's cross-month refusal, if that is what this 400 is: every attribution write can
 * report it under the `crossMonth` key, and the caller then offers to re-send the same request
 * acknowledged instead of showing a generic failure.
 */
export function crossMonthError(err: unknown): string | undefined {
  const e = err as { response?: { status?: number; data?: { errors?: Record<string, string[]> } } }
  if (e?.response?.status !== 400) return undefined
  const messages = e.response.data?.errors?.crossMonth
  if (!messages) return undefined
  return messages[0] ?? 'This transaction is dated in a different month than that budget line.'
}

/** What the server says when a save was made from a record someone else has changed since (D11). */
export const EDIT_CONFLICT_MESSAGE = 'Someone else changed this. Reload and try again.'

/**
 * The server's refusal of a save made from a stale load (a 409): its message, so the form can
 * show it and reload the record. Null for anything else.
 */
export function editConflict(err: unknown): string | null {
  const e = err as { response?: { status?: number; data?: { title?: string } } }
  if (e?.response?.status !== 409) return null
  return e.response.data?.title || EDIT_CONFLICT_MESSAGE
}
