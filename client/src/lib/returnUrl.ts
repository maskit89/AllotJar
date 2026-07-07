/**
 * Validates a ?returnUrl= value so post-login redirects can only ever stay inside the app:
 * a single-slash-rooted path ("/accept-invite?code=…"), never an absolute or scheme-relative
 * URL ("https://…", "//evil.example") that could bounce a fresh session to another site.
 */
export function safeInternalPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  // Control characters (tab/newline/CR/...) are stripped by the WHATWG URL parser, so a value
  // like "/<TAB>/evil.example" would resolve to scheme-relative "//evil.example" downstream —
  // reject them outright (0x00-0x1F and DEL).
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return null
  }
  return value
}
