import { useEffect, type ReactNode } from 'react'
import { PublicFooter, PublicHeader } from '../components/PublicHeader'
import { StagingBanner } from '../components/StagingBanner'

/**
 * Shared chrome for the public legal pages (/privacy, /terms), restyle PR 16: the landing page's
 * header row (the wordmark home, "Sign in", the theme button) on the sage page (a document page: no
 * green room), one off-white card with the gold hairline holding the h1, the "Last updated" line and
 * the `.legal-prose` text at a comfortable reading measure, and the landing's quiet footer. These
 * are public, crawlable trust pages — no auth, no app shell. Content uses semantic HTML inside
 * `.legal-prose` (styled in index.css) so the pages read like a document without class noise on
 * every element. Navigation is `PublicLink`s, as on the landing (in-app links, no reload).
 */
export function LegalLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string
  lastUpdated: string
  children: ReactNode
}) {
  // Give each legal page a distinct document title (browser tab + crawlers that
  // render JS). These pages are not prerendered, so this runs client-side only.
  useEffect(() => {
    const previous = document.title
    document.title = `${title} — AllotJar`
    return () => {
      document.title = previous
    }
  }, [title])

  return (
    <div className="auth-page legal">
      {/* Bypass Blocks (2.4.1): the keyboard skip link, as the landing's. */}
      <a
        href="#main-content"
        className="sr-only rounded-lg font-semibold text-brand-700 transition-none focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:border focus:border-brand-500 focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-card dark:text-brand-200"
      >
        Skip to main content
      </a>
      <StagingBanner />
      <header className="legal-top">
        <PublicHeader />
      </header>

      <main id="main-content" tabIndex={-1} className="legal-main focus:outline-none">
        <article className="legal-card">
          <h1 className="legal-title">{title}</h1>
          <p className="legal-date">Last updated: {lastUpdated}</p>
          <div className="legal-prose">{children}</div>
        </article>
      </main>

      <PublicFooter />
    </div>
  )
}
