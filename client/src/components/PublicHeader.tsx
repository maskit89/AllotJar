import type { MouseEvent, ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { JarLogo } from './Jar'
import { ThemeButton } from './ThemeToggle'

/**
 * The chrome the public pages share (restyle PR 16): the landing page (`/`) and the legal pages
 * (`/privacy`, `/terms`). Both are **SSR-safe**: the landing is prerendered to static HTML, so these
 * read no router state, and their links are `PublicLink`s: a plain `<a>` in the static HTML, an
 * in-app link once the app is running (the theme button's hook has a server snapshot). The pieces are the `.auth-top` row and the `.pub-foot` footer of index.css;
 * on the landing the row sits in the green room (white ink), on a legal page on the sage (`.legal`
 * restyles its ink and the theme button's ring there).
 */

/**
 * A link between the public pages and the sign-in pages. In the prerendered landing (no router) it is
 * a plain `<a href>`; once the app is running it is a router `Link`, so following it switches the page
 * in place, with no reload and no boot splash, and starts the new page at the top. The markup is the
 * same `<a href>` either way, so a modified click (new tab) and the static HTML behave as before.
 */
export function PublicLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'aria-label'?: string }) {
  const inRouter = useInRouterContext()
  if (!inRouter) {
    return (
      <a href={to} className={className} {...rest}>
        {children}
      </a>
    )
  }
  const toTop = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) window.scrollTo(0, 0)
  }
  return (
    <Link to={to} className={className} onClick={toTop} {...rest}>
      {children}
    </Link>
  )
}

/** The top row: the wordmark home, a quiet "Sign in" and the round theme button. */
export function PublicHeader() {
  return (
    <div className="auth-top">
      <PublicLink to="/" className="auth-brand" aria-label="AllotJar home">
        <JarLogo size={28} />
        <span className="auth-brand-name">
          Allot<span>Jar</span>
        </span>
      </PublicLink>
      <div className="pub-right">
        <nav aria-label="Primary">
          <PublicLink to="/login" className="pub-top-link">
            Sign in
          </PublicLink>
        </nav>
        <ThemeButton className="auth-theme" />
      </div>
    </div>
  )
}

/** The quiet footer: the year, Privacy and Terms. */
export function PublicFooter() {
  return (
    <footer className="pub-foot">
      <nav aria-label="Footer">
        <span>© {new Date().getFullYear()} AllotJar</span>
        <span aria-hidden>·</span>
        <PublicLink to="/privacy">Privacy</PublicLink>
        <span aria-hidden>·</span>
        <PublicLink to="/terms">Terms</PublicLink>
      </nav>
    </footer>
  )
}
