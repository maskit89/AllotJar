/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** GA4 measurement ID (`G-XXXXXXXXXX`). Absent ⇒ analytics is disabled entirely. */
  readonly VITE_GA_MEASUREMENT_ID?: string
  /**
   * Deployment environment for this build. `'beta'` turns on the under-construction
   * banner + the registration data-loss acknowledgment; `'production'` (or unset) is
   * the clean general-availability build. Baked in at build time by the deploy workflow.
   */
  readonly VITE_APP_ENV?: 'beta' | 'production'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
