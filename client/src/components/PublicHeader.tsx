import { JarLogo } from './Jar'
import { ThemeButton } from './ThemeToggle'

/**
 * The chrome the public pages share (restyle PR 16): the landing page (`/`) and the legal pages
 * (`/privacy`, `/terms`). Both are **SSR-safe**: the landing is prerendered to static HTML, so these
 * render no router context or state and navigate with plain `<a>` links (the theme button's hook has
 * a server snapshot). The pieces are the `.auth-top` row and the `.pub-foot` footer of index.css;
 * on the landing the row sits in the green room (white ink), on a legal page on the sage (`.legal`
 * restyles its ink and the theme button's ring there).
 */

/** The top row: the wordmark home, a quiet "Sign in" and the round theme button. */
export function PublicHeader() {
  return (
    <div className="auth-top">
      <a href="/" className="auth-brand" aria-label="AllotJar home">
        <JarLogo size={28} />
        <span className="auth-brand-name">
          Allot<span>Jar</span>
        </span>
      </a>
      <div className="pub-right">
        <nav aria-label="Primary">
          <a href="/login" className="pub-top-link">
            Sign in
          </a>
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
        <a href="/privacy">Privacy</a>
        <span aria-hidden>·</span>
        <a href="/terms">Terms</a>
      </nav>
    </footer>
  )
}
