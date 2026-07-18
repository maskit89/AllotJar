// Build-time deployment-environment flags.
//
// VITE_APP_ENV is inlined by Vite at build time (set by .github/workflows/deploy.yml:
// 'staging' for the staging deploy, 'production' for the GA deploy). Centralising it
// here keeps `import.meta.env` access in one place and lets tests mock the flag with
// `vi.mock('../lib/env', ...)` instead of fighting the read-only `import.meta.env`.

/** The deployment environment this bundle was built for. Unset locally ⇒ treated as non-staging. */
export const APP_ENV = import.meta.env.VITE_APP_ENV

/**
 * True when this is the IP-restricted **staging** build. Gates the test-environment banner
 * and the registration "my data may be lost" acknowledgment. The general-availability
 * (production) build leaves both off.
 */
export const IS_STAGING = APP_ENV === 'staging'
