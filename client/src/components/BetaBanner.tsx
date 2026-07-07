import { IS_BETA } from '../lib/env'

/**
 * A persistent, full-width "this is a beta" strip shown only in the beta build
 * (VITE_APP_ENV=beta). It warns that the app is under active development and that
 * data may be reset or lost — the general-availability build renders nothing.
 *
 * Kept **SSR-safe** (no hooks, state or browser globals) so it can sit at the top
 * of the prerendered landing page as well as the live SPA. Sticky so it stays in
 * view as the user scrolls; `role="status"` so assistive tech announces it politely.
 */
export function BetaBanner() {
  if (!IS_BETA) return null
  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-[13px] leading-snug text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/60 dark:text-amber-100"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" aria-hidden="true">
        <path
          d="M12 9v4m0 4h.01M10.3 3.86l-8.18 14.2A2 2 0 0 0 3.85 21h16.3a2 2 0 0 0 1.73-2.94L13.7 3.86a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        <strong className="font-semibold">Beta</strong> — AllotJar is under active development.
        Features may change and your data can be reset or lost without notice.
      </span>
    </div>
  )
}
