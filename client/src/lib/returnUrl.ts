/**
 * Validates a ?returnUrl= value so post-login redirects can only ever stay inside the app:
 * a single-slash-rooted path ("/accept-invite?code=…"), never an absolute or scheme-relative
 * URL ("https://…", "//evil.example") that could bounce a fresh session to another site.
 */
export function safeInternalPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}
