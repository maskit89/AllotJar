import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CategoryHue } from '../lib/categoryColors'
import { currencyNoun, detectLocaleDefaults } from '../lib/money'
import { useMediaQuery } from '../lib/useMediaQuery'
import { GlassJar } from './GlassJar'
import { JarLogo } from './Jar'
import { StagingBanner } from './StagingBanner'
import { ThemeButton } from './ThemeToggle'

/** One glass jar on the room's shelf: its colour, how full, and its width on desktop and on a phone. */
type ShelfJar = { hue: CategoryHue; pct: number; width: number; phone: number }

// Two jars each side of the card, the outer ones smaller, the inner ones nearer the card (the
// approved mock-up's fills). Sky blue is not an app hue: the shelf tints its teal jar sky (index.css).
const LEFT: ShelfJar[] = [
  { hue: 'teal', pct: 38, width: 60, phone: 40 },
  { hue: 'emerald', pct: 74, width: 88, phone: 54 },
]
const RIGHT: ShelfJar[] = [
  { hue: 'rose', pct: 52, width: 80, phone: 50 },
  { hue: 'indigo', pct: 30, width: 62, phone: 42 },
]

/** A jar standing on the plank: its glass ends a little above the drawing's foot, so it sinks to meet it. */
function ShelfJarAt({ jar, width, className = '' }: { jar: ShelfJar; width: number; className?: string }) {
  return (
    <span className={`block ${className}`} style={{ marginBottom: -(width / 16 - 1) }}>
      <GlassJar pct={jar.pct} hue={jar.hue} width={width} />
    </span>
  )
}

/** The desktop room: the gradient, the glow and the quiet shelf, two jars each side of the card. */
const RoomShelf = memo(function RoomShelf() {
  return (
    <div className="auth-room" aria-hidden>
      <div className="auth-shelf">
        <div className="auth-jars auth-jars-l">
          <ShelfJarAt jar={LEFT[0]} width={LEFT[0].width} className="auth-jar-outer" />
          <ShelfJarAt jar={LEFT[1]} width={LEFT[1].width} />
        </div>
        <div className="auth-jars auth-jars-r">
          <ShelfJarAt jar={RIGHT[0]} width={RIGHT[0].width} />
          <ShelfJarAt jar={RIGHT[1]} width={RIGHT[1].width} className="auth-jar-outer" />
        </div>
        <div className="auth-plank" />
      </div>
    </div>
  )
})

/** The phone band's small shelf: the same four jars in a row. */
const BandShelf = memo(function BandShelf() {
  return (
    <div className="auth-pshelf" aria-hidden>
      <div className="auth-jars">
        {[...LEFT, ...RIGHT].map((jar) => (
          <ShelfJarAt key={jar.hue} jar={jar} width={jar.phone} />
        ))}
      </div>
      <div className="auth-plank" />
    </div>
  )
})

/**
 * The frame of the four signed-out pages (sign in and create account, forgot password, reset
 * password, accept invite), restyle PR 9, the approved "Green banner" mock-up. On desktop a green
 * room runs across the top of the sage page: the wordmark on its left, the theme button on its
 * right, one line of copy under a soft gold glow, and a quiet shelf of four glass jars, two each
 * side of the card. The off-white card with the gold hairline stands in front of the shelf and
 * reaches down onto the sage, and the sage under it deepens into a quiet floor. On a phone the room
 * is a compact green band of one fixed height on every page, and the card a sheet that hangs from its
 * foot down to the bottom of the screen; the sheet's last group (Google's button, the foot links)
 * rests on the bottom edge, so the line, the jars and the form never move when the mode changes,
 * a notice appears or Google's button arrives late.
 *
 * Only the shelf the screen shows is drawn (the room's on a desktop, the band's on a phone; CSS hides
 * the other as well), and it is memoised: it never changes, so typing in a field does not redraw it.
 *
 * The page puts its card content in `children` (its own title, form, notices and links).
 * `srTitle` adds a visually hidden h1 for a card without a visible title (sign in).
 * `staging` shows the StagingBanner above the room (off for Accept invite, which never had it).
 */
export function AuthFrame({
  children,
  srTitle,
  staging = true,
  dense = false,
}: {
  children: ReactNode
  srTitle?: string
  staging?: boolean
  /** A taller form (Create account): a little less space between its parts on a phone. */
  dense?: boolean
}) {
  // The line's money word follows the visitor's browser locale (as the sign-in page always did).
  const [noun] = useState(() => currencyNoun(detectLocaleDefaults().currency))
  const phone = useMediaQuery('(max-width: 699.98px)')

  return (
    <div className="auth-page">
      {staging && <StagingBanner />}
      <div className={`auth${dense ? ' auth-dense' : ''}`}>
        {!phone && <RoomShelf />}

        <header className="auth-band">
          <div className="auth-top">
            <span className="auth-brand">
              <JarLogo size={28} />
              <span className="auth-brand-name">
                Allot<span>Jar</span>
              </span>
            </span>
            <ThemeButton className="auth-theme" />
          </div>
          <div className="auth-hero">
            <p className="auth-line">
              Give every <span className="gold-number">{noun}</span> a job.
            </p>
            {phone && <BandShelf />}
          </div>
        </header>

        <main className="auth-main">
          {srTitle && <h1 className="sr-only">{srTitle}</h1>}
          <div className="auth-card">{children}</div>
        </main>
      </div>
    </div>
  )
}

/**
 * A card's title row: the page's heading and, beside it (outside the heading, so the heading keeps
 * its name), an optional (i) hint holding the page's explanation. `eyebrow` puts a small label above.
 * The heading is the page's h1 unless `as` says h2 (a state inside a page that has its own h1); `sub`
 * is one short muted line under it.
 */
export function AuthTitle({
  children,
  hint,
  eyebrow,
  sub,
  as: Heading = 'h1',
  focusOnMount = false,
}: {
  children: ReactNode
  hint?: ReactNode
  eyebrow?: string
  /** One short muted line under the title. */
  sub?: ReactNode
  as?: 'h1' | 'h2'
  /** Take focus when shown: a state that replaces the form (where focus was) starts here, and a
   *  screen reader reads the new title. */
  focusOnMount?: boolean
}) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusOnMount) ref.current?.focus()
  }, [focusOnMount])
  return (
    <div className="auth-head">
      {eyebrow && <p className="auth-eyebrow">{eyebrow}</p>}
      <div className="auth-head-row">
        <Heading ref={ref} className="auth-title" tabIndex={focusOnMount ? -1 : undefined}>
          {children}
        </Heading>
        {hint}
      </div>
      {sub && <p className="auth-sub">{sub}</p>}
    </div>
  )
}
