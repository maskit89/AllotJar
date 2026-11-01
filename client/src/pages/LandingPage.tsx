import type { CSSProperties, ReactNode } from 'react'
import { BarChart3, Check, FileUp, Lock, Smartphone } from 'lucide-react'
import { GlassJar } from '../components/GlassJar'
import { PublicFooter, PublicHeader, PublicLink } from '../components/PublicHeader'
import { StagingBanner } from '../components/StagingBanner'
import { hueColor, type CategoryHue } from '../lib/categoryColors'

/**
 * The public landing page, the front door at `allotjar.com/` for anonymous visitors (signed-in
 * users get the dashboard instead; see App.tsx). Since 31 Oct 2026 the "Product tour" Christopher
 * picked (after #398's short card left Sign in hidden in the corner and said nothing of what the
 * app does): the legal pages' header row on the sage page, then
 *  - the hero: the line "Give every euro a job.", one sentence, both buttons side by side
 *    (Create free account, Sign in) with the free-to-start note, and a slice of the app (the
 *    Remaining to budget tile at zero, a shelf of jars, two budget rows);
 *  the figures, chips and roles in the pictures are the app's own words (Funded only on a full jar;
 *  the roles Owner, Admin, Limited);
 *  - "Budgeting in three steps": money comes in, give it a job, spend without worry;
 *  - three features (budget, jars, together), each three short ticked points beside a picture;
 *  - four small extras (import, reports, on your phone, private);
 *  - the green closing band with both buttons again; the footer.
 * The pictures are drawn with the app's own pieces (the hero tile, GlassJar, rows and chips) and are
 * decoration: hidden from assistive tech, their words are said by the points beside them. The page's
 * parts are the `land-*` rules in index.css; the header row and the footer are the public pages'
 * shared pieces (PublicHeader.tsx).
 *
 * It is **self-contained and SSR-safe**: it renders to static HTML at build time
 * (scripts/prerender.mjs → renderToStaticMarkup), so nothing it renders may read `window`,
 * `document` or `navigator` during render, or read router state. Its links are `PublicLink`s: plain
 * `<a>` links to /login in the static HTML, in-app links (no reload) once the app is running. The
 * line always says "euro" (the app is euro-first), so the prerendered HTML never changes after the
 * SPA mounts. The theme button's hook has a server snapshot (light), and the theme itself is applied
 * before paint by /theme-init.js.
 */

const REGISTER = '/login?register=1'

/** The two buttons side by side (one above the other on a phone) and the note under them. */
function Ctas({ onGreen = false, center = false }: { onGreen?: boolean; center?: boolean }) {
  return (
    <div className={`land-cta${center ? ' land-center' : ''}${onGreen ? ' land-on-green' : ''}`}>
      <div className="land-btns">
        <PublicLink to={REGISTER} className="land-pill">
          Create free account
        </PublicLink>
        <PublicLink to="/login" className="land-ghost">
          Sign in
        </PublicLink>
      </div>
      <p className="land-note">Free to start · No card required</p>
    </div>
  )
}

type ShelfJar = { name: string; amount: string; pct: number; hue: CategoryHue; sub?: string; funded?: boolean }

const JARS: ShelfJar[] = [
  { name: 'Holiday', amount: '€640', pct: 64, hue: 'teal', sub: '€80/mo' },
  { name: 'Car service', amount: '€210', pct: 42, hue: 'indigo', sub: '€35/mo' },
  { name: 'Christmas', amount: '€180', pct: 30, hue: 'rose', sub: '€40/mo' },
  // Full: the one jar whose chip says Funded (the app's word, for a jar at its whole target).
  { name: 'Insurance', amount: '€420', pct: 100, hue: 'emerald', funded: true },
]

/** A row of glass jars on the plank, each with its name and amount (and, with `plans`, its monthly
 *  amount, or Funded for a full jar). The plank sits at the jars' feet: `--shelf-top` follows the jar's width. */
function Shelf({ jars = JARS, width = 52, plans = false }: { jars?: ShelfJar[]; width?: number; plans?: boolean }) {
  const style = {
    gridTemplateColumns: `repeat(${jars.length}, minmax(0, 1fr))`,
    '--shelf-top': `${Math.round((width * 84) / 64) - 2}px`,
  } as CSSProperties
  return (
    <div className="land-shelf" style={style}>
      {jars.map((j) => (
        <div key={j.name} className="land-jar">
          <GlassJar pct={j.pct} hue={j.hue} width={width} />
          <span className="land-jar-name">{j.name}</span>
          <span className="land-jar-amt">{j.amount}</span>
          {plans && (j.funded ? <Chip>Funded</Chip> : <span className="land-jar-sub">{j.sub}</span>)}
        </div>
      ))}
    </div>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="land-chip">
      <Check size={12} strokeWidth={2.6} aria-hidden />
      {children}
    </span>
  )
}

/** A budget row: the name, a bar (or a chip) and the figure at the right. */
function Row({ name, right, bar, chip }: { name: string; right: ReactNode; bar?: { pct: number; hue: CategoryHue }; chip?: string }) {
  return (
    <div className="land-row">
      <span>{name}</span>
      {chip ? (
        <Chip>{chip}</Chip>
      ) : (
        <span className="land-bar">
          <i style={{ width: `${bar?.pct ?? 0}%`, background: hueColor(bar?.hue ?? 'indigo') }} />
        </span>
      )}
      <span>{right}</span>
    </div>
  )
}

const left = (amount: string) => <span className="land-muted">{amount} left</span>

/** The Dashboard's green hero tile with its gold number and a full bar. */
function HeroTile({ label, value, done }: { label: string; value: string; done?: string }) {
  return (
    <div className="land-tile kpi-hero">
      <p className="land-tile-label">{label}</p>
      <p className="land-tile-num gold-number">{value}</p>
      <div className="land-tile-bar">
        <span style={{ width: '100%' }} />
      </div>
      {done && (
        <p className="land-tile-done">
          <Check size={14} strokeWidth={2.4} aria-hidden /> {done}
        </p>
      )}
    </div>
  )
}

/** The hero's picture: the month at zero, the jars, two rows. */
function AppSlice() {
  return (
    <div className="land-shot" aria-hidden>
      <HeroTile label="Remaining to budget" value="€0.00" done="Every euro has a job" />
      <div className="land-card">
        <div className="land-card-head">
          <span>Jars</span>
          <span>€1,450 saved</span>
        </div>
        <Shelf />
      </div>
      <div className="land-rows">
        <Row name="Groceries" bar={{ pct: 58, hue: 'indigo' }} right={left('€180')} />
        <Row name="Rent" chip="Paid" right="€1,200" />
      </div>
    </div>
  )
}

function Steps() {
  return (
    <section className="land-sec" aria-labelledby="land-steps-h">
      <h2 id="land-steps-h" className="land-sec-h">
        Budgeting in three steps
      </h2>
      <ol className="land-steps">
        <li className="land-step">
          <div className="land-pic" aria-hidden>
            <div className="land-pic-tile kpi-hero">
              <span className="land-tile-label">Income</span>
              <span className="land-tile-num gold-number">€2,600</span>
            </div>
          </div>
          <h3>
            <span className="land-n" aria-hidden>
              1
            </span>
            Money comes in
          </h3>
        </li>
        <li className="land-step">
          <div className="land-pic" aria-hidden>
            <Shelf jars={JARS.slice(0, 3)} width={46} />
          </div>
          <h3>
            <span className="land-n" aria-hidden>
              2
            </span>
            Give it a job
          </h3>
        </li>
        <li className="land-step">
          <div className="land-pic land-pic-rows" aria-hidden>
            <Row name="Groceries" bar={{ pct: 58, hue: 'indigo' }} right={left('€180')} />
            <Row name="Insurance" chip="Funded" right="€420" />
          </div>
          <h3>
            <span className="land-n" aria-hidden>
              3
            </span>
            Spend without worry
          </h3>
        </li>
      </ol>
    </section>
  )
}

/** One feature: the eyebrow, the title and three ticked points, beside its picture. */
function Feature({ eyebrow, title, points, flip = false, children }: { eyebrow: string; title: string; points: string[]; flip?: boolean; children: ReactNode }) {
  return (
    <section className={`land-feat${flip ? ' land-flip' : ''}`} aria-label={title}>
      <div className="land-feat-words">
        <p className="land-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <ul className="land-points">
          {points.map((p) => (
            <li key={p}>
              <span className="land-tick" aria-hidden>
                <Check size={13} strokeWidth={2.8} />
              </span>
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="land-shot" aria-hidden>
        {children}
      </div>
    </section>
  )
}

function Person({ letter, name, role, hue }: { letter: string; name: string; role: string; hue: CategoryHue }) {
  return (
    <div className="land-row land-row-person">
      <span className="land-avatar" style={{ background: `color-mix(in srgb, ${hueColor(hue)} 18%, var(--color-card))`, color: hueColor(hue) }}>
        {letter}
      </span>
      <span>{name}</span>
      <span className="land-muted">{role}</span>
    </div>
  )
}

function Features() {
  return (
    <div className="land-feats">
      <Feature eyebrow="Budget" title="Plan the month to zero" points={['Every euro gets a job', 'Leftovers carry into next month', 'See what’s left at a glance']}>
        <HeroTile label="Remaining to budget" value="€320.00" />
        <div className="land-rows">
          <Row name="Rent" chip="Paid" right="€1,200" />
          <Row name="Groceries" bar={{ pct: 58, hue: 'indigo' }} right={left('€180')} />
          <Row name="Transport" bar={{ pct: 30, hue: 'teal' }} right={left('€105')} />
        </div>
      </Feature>
      <Feature flip eyebrow="Jars" title="Jars for the big bills" points={['Set a target and a due date', 'Know what to put aside each month', 'Replans itself when you pay']}>
        <div className="land-card">
          <div className="land-card-head">
            <span>Jars</span>
            <span>€1,450 saved</span>
          </div>
          <Shelf plans />
        </div>
      </Feature>
      <Feature eyebrow="Together" title="One budget for the household" points={['Invite your partner', 'Shared and private accounts', 'Pocket money for the kids']}>
        <div className="land-rows">
          <Person letter="A" name="Alex" role="Owner" hue="emerald" />
          <Person letter="S" name="Sam" role="Admin" hue="indigo" />
          <Person letter="M" name="Mia" role="Limited" hue="rose" />
        </div>
      </Feature>
    </div>
  )
}

const EXTRAS: { title: string; line: string; icon: ReactNode }[] = [
  { title: 'Import statements', line: 'CSV or PDF from any bank', icon: <FileUp strokeWidth={1.8} /> },
  { title: 'Reports', line: 'What each jar really cost', icon: <BarChart3 strokeWidth={1.8} /> },
  { title: 'On your phone', line: 'Install it like an app', icon: <Smartphone strokeWidth={1.8} /> },
  { title: 'Private', line: 'No bank login. Never sold.', icon: <Lock strokeWidth={1.8} /> },
]

function Extras() {
  return (
    <section className="land-sec" aria-labelledby="land-extras-h">
      <h2 id="land-extras-h" className="sr-only">
        Also in AllotJar
      </h2>
      <ul className="land-extras">
        {EXTRAS.map((e) => (
          <li key={e.title}>
            <span className="land-glyph" aria-hidden>
              {e.icon}
            </span>
            <div>
              <h3>{e.title}</h3>
              <p>{e.line}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function LandingPage() {
  return (
    <div className="land">
      {/* Bypass Blocks (2.4.1): the keyboard skip link, as the app frame's. */}
      <a
        href="#main-content"
        className="sr-only rounded-lg font-semibold text-brand-700 transition-none focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:border focus:border-brand-500 focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-card dark:text-brand-200"
      >
        Skip to main content
      </a>
      <StagingBanner />
      <header className="land-top">
        <PublicHeader />
      </header>

      {/* tabIndex -1: the skip link's target is programmatically focusable (as AppShell's main). */}
      <main id="main-content" tabIndex={-1} className="focus:outline-none">
        <section className="land-hero" aria-labelledby="land-h1">
          <div className="land-words">
            <h1 id="land-h1" className="land-h1">
              Give every <span>euro</span> a job.
            </h1>
            <p className="land-lead">Zero-based budgeting for your household, with jars for the big bills.</p>
            <Ctas />
          </div>
          <AppSlice />
        </section>
        <Steps />
        <Features />
        <Extras />
        <section className="land-close kpi-hero" aria-labelledby="land-close-h">
          <h2 id="land-close-h">
            Ready to give every <span className="gold-number">euro</span> a job?
          </h2>
          <Ctas onGreen center />
        </section>
      </main>

      <PublicFooter />
    </div>
  )
}
