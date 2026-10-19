import type { ReactNode } from 'react'
import { Target, Users } from 'lucide-react'
import { BandShelf, RoomShelf } from '../components/AuthFrame'
import { JarNavIcon } from '../components/icons'
import { PublicFooter, PublicHeader, PublicLink } from '../components/PublicHeader'
import { StagingBanner } from '../components/StagingBanner'
import { hueColor, type CategoryHue } from '../lib/categoryColors'

/**
 * The public landing page, the front door at `allotjar.com/` for anonymous visitors (signed-in
 * users get the dashboard instead; see App.tsx). Restyle PR 15: the sign-in pages' look
 * (AuthFrame, restyle PR 9). The green room runs across the top of the sage page with the wordmark,
 * a quiet "Sign in" and the theme button; the line "Give every euro a job." under the gold glow; the
 * shelf of glass jars, two each side of the off-white card with the gold hairline, which holds one
 * sentence, the page's one primary button ("Create your free account", with "Sign in" beside it) and
 * the free-to-start note. Under the room: three short feature cards, one closing line with the same
 * button, and a quiet footer. On a phone the room is the compact band with the small shelf and the
 * card hangs from its foot. The room, band and card are the `auth-*` rules in index.css; the page's
 * own parts are the `land-*` rules there. The header row and the footer are the public pages'
 * shared pieces (PublicHeader.tsx, restyle PR 16: the legal pages draw the same ones).
 *
 * It is **self-contained and SSR-safe**: it renders to static HTML at build time
 * (scripts/prerender.mjs → renderToStaticMarkup), so nothing it renders may read `window`,
 * `document` or `navigator` during render, or read router state. Its links are `PublicLink`s: plain
 * `<a>` links to /login in the static HTML, in-app links (no reload) once the app is running. The line always says "euro" (the app is euro-first), so the prerendered
 * HTML never changes after the SPA mounts. The theme button's hook has a server snapshot (light),
 * and the theme itself is applied before paint by /theme-init.js.
 */

const REGISTER = '/login?register=1'
const SIGN_IN = '/login'

/** The page's primary: the sign-in form's green pill, as a link. */
function CreateAccount() {
  return (
    <PublicLink
      to={REGISTER}
      className="auth-pill land-pill inline-flex items-center justify-center rounded-lg bg-brand-600 font-semibold text-white transition hover:bg-brand-700 dark:bg-primary dark:hover:bg-brand-600"
    >
      Create your free account
    </PublicLink>
  )
}

/** The three things the app does: a glyph in the hue's tint, a short title and one line. */
const FEATURES: { title: string; line: string; hue: CategoryHue; icon: ReactNode }[] = [
  {
    title: 'Budget to zero',
    line: 'Plan the month until Remaining to budget reads zero.',
    hue: 'emerald',
    icon: <Target strokeWidth={1.8} aria-hidden />,
  },
  {
    title: 'Jars for the big bills',
    line: 'Set a little aside each month for insurance, the car and the holiday.',
    hue: 'teal',
    icon: <JarNavIcon strokeWidth={1.8} aria-hidden />,
  },
  {
    title: 'Budget together',
    line: 'One shared budget for everyone in your household.',
    hue: 'indigo',
    icon: <Users strokeWidth={1.8} aria-hidden />,
  },
]

export function LandingPage() {
  return (
    <div className="auth-page land">
      {/* Bypass Blocks (2.4.1): the keyboard skip link, as the app frame's. */}
      <a
        href="#main-content"
        className="sr-only rounded-lg font-semibold text-brand-700 transition-none focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:border focus:border-brand-500 focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-card dark:text-brand-200"
      >
        Skip to main content
      </a>
      <StagingBanner />
      <div className="auth">
        {/* Both shelves are drawn; the CSS shows the room's on a desktop and the band's on a phone, so
            the static HTML is the same whatever the screen. */}
        <RoomShelf />

        <header className="auth-band">
          <PublicHeader />
          <div className="auth-hero">
            <h1 className="auth-line">
              Give every <span className="gold-number">euro</span> a job.
            </h1>
            <BandShelf />
          </div>
        </header>

        {/* tabIndex -1: the skip link's target is programmatically focusable (as AppShell's main). */}
        <main id="main-content" tabIndex={-1} className="auth-main focus:outline-none">
          <div className="auth-card">
            <p className="land-lead">
              Zero-based budgeting for households: plan the month to zero, with jars for the big bills
              and a budget you share.
            </p>
            <div className="land-actions">
              <CreateAccount />
              <PublicLink to={SIGN_IN} className="auth-link land-signin">
                Sign in
              </PublicLink>
            </div>
            <p className="land-note">Free to start · No card required</p>
          </div>

          <section className="land-features" aria-labelledby="land-features-h">
            <h2 id="land-features-h" className="sr-only">
              What AllotJar does
            </h2>
            <ul className="land-cards">
              {FEATURES.map((f) => (
                <li key={f.title} className="land-f">
                  <span
                    aria-hidden
                    className="land-glyph"
                    style={{
                      background: `color-mix(in srgb, ${hueColor(f.hue)} 13%, var(--color-card))`,
                      color: hueColor(f.hue),
                    }}
                  >
                    {f.icon}
                  </span>
                  <h3>{f.title}</h3>
                  <p>{f.line}</p>
                </li>
              ))}
            </ul>
            <p className="land-promise">
              <b>In your currency, the way you write it</b>
              <span className="land-dot" aria-hidden>
                {' · '}
              </span>
              <b>Your data is never sold.</b>
            </p>
          </section>

          <section className="land-close" aria-labelledby="land-close-h">
            <h2 id="land-close-h">Ready to give every euro a job?</h2>
            <CreateAccount />
          </section>
        </main>

        <PublicFooter />
      </div>
    </div>
  )
}
