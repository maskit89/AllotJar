import { IS_STAGING } from '../lib/env'
import { Notice } from './Notice'

/**
 * A persistent, full-width "this is the staging environment" strip shown only in the
 * staging build (VITE_APP_ENV=staging): one line on the warn tone (Notice `strip`) saying the
 * data here is test data that may be reset. The general-availability (production) build renders
 * nothing.
 *
 * Kept **SSR-safe** (no hooks, state or browser globals) so it can sit at the top
 * of the prerendered landing page as well as the live SPA. Sticky so it stays in
 * view as the user scrolls; `role="status"` so assistive tech announces it politely.
 */
export function StagingBanner() {
  if (!IS_STAGING) return null
  return (
    <Notice variant="strip" tone="warn" role="status">
      Staging · test data, may be reset
    </Notice>
  )
}
