// Build-time deployment-environment flags.
//
// VITE_APP_ENV is inlined by Vite at build time (set by .github/workflows/deploy.yml
// for the beta deploy). Centralising it here keeps `import.meta.env` access in one
// place and lets tests mock the flag with `vi.mock('../lib/env', ...)` instead of
// fighting the read-only `import.meta.env`.

/** The deployment environment this bundle was built for. Unset locally ⇒ treated as non-beta. */
export const APP_ENV = import.meta.env.VITE_APP_ENV

/**
 * True when this is the public **beta** build. Gates the under-construction banner
 * and the registration "my data may be lost" acknowledgment. The general-availability
 * (production) build leaves both off.
 */
export const IS_BETA = APP_ENV === 'beta'
