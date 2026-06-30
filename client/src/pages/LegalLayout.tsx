import { useEffect, type ReactNode } from 'react'
import { JarLogo } from '../components/Jar'

/**
 * Shared chrome for the public legal pages (/privacy, /terms): a simple header
 * with the brand mark, a constrained `.legal-prose` body, and a footer. These are
 * public, crawlable trust pages — no auth, no app shell. Content uses semantic
 * HTML inside `.legal-prose` (styled in index.css) so the pages read like a
 * document without class noise on every element.
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
    <div className="min-h-full">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
        <a href="/" className="flex items-center gap-2.5" aria-label="AllotJar home">
          <JarLogo />
          <span className="text-xl font-extrabold tracking-[-0.03em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </span>
        </a>
        <a
          href="/login"
          className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition hover:text-slate-900"
        >
          Sign in
        </a>
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-16 pt-4">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {lastUpdated}</p>
        <div className="legal-prose mt-8">{children}</div>
      </main>

      <footer className="mx-auto max-w-3xl px-5 py-10">
        <nav
          className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200 pt-8 text-sm"
          aria-label="Footer"
        >
          <a href="/" className="font-medium text-slate-600 hover:text-slate-900">
            Home
          </a>
          <a href="/privacy" className="font-medium text-slate-600 hover:text-slate-900">
            Privacy
          </a>
          <a href="/terms" className="font-medium text-slate-600 hover:text-slate-900">
            Terms
          </a>
          <a href="/login" className="font-medium text-slate-600 hover:text-slate-900">
            Sign in
          </a>
          <span className="text-slate-500">© {new Date().getFullYear()} AllotJar</span>
        </nav>
      </footer>
    </div>
  )
}
