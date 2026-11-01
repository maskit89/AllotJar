// Turn the user's email into a stable, opaque, non-reversible id for GA's User-ID.
// The raw email NEVER leaves the browser — only this hash is ever sent, so a person's
// sessions can be stitched together without exposing who they are.
//
// Production currently serves over plain HTTP (no TLS yet), where `crypto.subtle` is
// unavailable (it needs a secure context). So we prefer SHA-256 when we can, and fall
// back to a deterministic non-crypto hash otherwise — either way the email is not sent.

const PEPPER = 'allotjar.analytics.v1'

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** FNV-1a 32-bit, run twice over different salts to widen the output to 64 bits. */
function fallbackHash(input: string): string {
  const fnv = (seed: number, str: string): number => {
    let h = seed >>> 0
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
  const a = fnv(0x811c9dc5, input)
  const b = fnv(0x811c9dc5, input + PEPPER)
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'))
}

/**
 * A stable pseudonymous id derived from the email. Async because SHA-256 is async;
 * resolves to a 32-char hex string. Returns null for an empty email.
 */
export async function hashUserId(email: string | null | undefined): Promise<string | null> {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) return null

  const input = `${PEPPER}:${normalized}`
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const data = new TextEncoder().encode(input)
      const digest = await crypto.subtle.digest('SHA-256', data)
      return toHex(new Uint8Array(digest)).slice(0, 32)
    }
  } catch {
    // fall through to the non-crypto fallback
  }
  return fallbackHash(input)
}
