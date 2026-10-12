import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMonth } from '../features/MonthContext'
import { AccountMenu } from './AccountMenu'
import { JarLogo } from './Jar'
import { ThemeButton } from './ThemeToggle'

/**
 * The month switcher (‹ October 2026 ›): a pill that moves the app-wide month (MonthContext), so
 * every month-scoped screen follows. Phones show the short month (Oct 2026); the label stays one
 * element either way ("October 2026" with the tail of the month name hidden on phones).
 */
function MonthSwitcher() {
  const { label, goPrev, goNext } = useMonth()
  const space = label.indexOf(' ')
  const monthName = space > 0 ? label.slice(0, space) : label
  const rest = space > 0 ? label.slice(space) : ''
  // 38px circles as in the mock-up (32px on the narrowest phones, to leave the title room), each
  // with a touch target (the ::after) that fills the pill's height.
  const arrow =
    "relative grid size-[38px] place-items-center rounded-full text-slate-500 transition-colors after:absolute after:-inset-[3px] after:content-[''] hover:bg-slate-100 hover:text-slate-900 max-[359.98px]:size-8 min-[900px]:size-8"

  return (
    <div
      role="group"
      aria-label="Month"
      // The tour's month step points here, so it only spotlights a bar that has the arrows.
      data-tour="month"
      className="flex h-11 shrink-0 items-center gap-0.5 rounded-full border border-slate-200 bg-surface px-[3px] shadow-[var(--shadow-frame)] min-[900px]:h-10 min-[900px]:px-1"
    >
      <button type="button" aria-label="Previous month" onClick={goPrev} className={arrow}>
        <ChevronLeft aria-hidden strokeWidth={1.8} className="size-[18px]" />
      </button>
      {/* The viewed month is the screen's second-level heading, as it always was (assistive
          tech and the journeys find the month by it), and announces itself when it changes. */}
      <h2
        aria-live="polite"
        className="px-0.5 text-center text-sm font-semibold whitespace-nowrap text-slate-900 tabular-nums min-[900px]:min-w-[118px]"
      >
        {monthName.slice(0, 3)}
        <span className="max-[899.98px]:hidden">{monthName.slice(3)}</span>
        {rest}
      </h2>
      <button type="button" aria-label="Next month" onClick={goNext} className={arrow}>
        <ChevronRight aria-hidden strokeWidth={1.8} className="size-[18px]" />
      </button>
    </div>
  )
}

/**
 * The top bar every signed-in page opens with, sticky over the content: the page title (the
 * screen's one visible <h1>), the month switcher on the pages whose content follows the month,
 * the page's actions (desktop only: AppShell passes them here from 900px up, and into the content
 * below that), and the theme button. Phones get a slim version: the logo, the title, the month and
 * the account avatar (the account menu holds Dark mode there). On phones a little narrower than
 * the mock-up's 390px the month pill would squeeze the title, so the logo gives way when the pill
 * shows, and under 360px the title, the gaps and the month arrows step down a size.
 *
 * `back` (opt-in, a detail page such as an account's): the way back to the parent page, a 40px
 * chevron link named "Back to {label}" before the title, in place of the phone's logo. Left out,
 * the bar is as it always was.
 */
export function TopBar({
  title,
  month = false,
  actions,
  back,
}: {
  title?: ReactNode
  month?: boolean
  actions?: ReactNode
  back?: { to: string; label: string }
}) {
  return (
    <header data-tour="topbar" className="sticky top-0 z-30 bg-background/90 backdrop-blur-[10px]">
      <div className="mx-auto flex h-[60px] max-w-[1240px] items-center gap-2.5 px-4 max-[359.98px]:gap-2 min-[900px]:h-[76px] min-[900px]:gap-3 min-[900px]:px-10">
        {back ? (
          // A link (the way back is a place, not an action), drawn as the bar's icon buttons are; it
          // sits half its padding into the gutter so the chevron lines up with the page's edge.
          <Link
            to={back.to}
            aria-label={`Back to ${back.label}`}
            className="-mr-1 -ml-2.5 grid size-10 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-surface hover:text-slate-900"
          >
            <ChevronLeft aria-hidden strokeWidth={1.8} className="size-[18px]" />
          </Link>
        ) : (
          // Under 384px the logo, the month pill and the avatar leave the longest month-page title
          // ("Transactions") less than its width, so the logo gives way there.
          <span className={`shrink-0 min-[900px]:hidden ${month ? 'max-[383.98px]:hidden' : ''}`}>
            <JarLogo size={26} />
          </span>
        )}
        {/* The title takes the free width (pushing the rest to the right) and truncates last. */}
        {title ? (
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-[-0.02em] text-slate-900 max-[359.98px]:text-base min-[900px]:text-[22px]">
            {title}
          </h1>
        ) : (
          <div className="flex-1" />
        )}
        {month && <MonthSwitcher />}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
        <ThemeButton className="hidden min-[900px]:grid" />
        <span className="min-[900px]:hidden">
          <AccountMenu variant="avatar" />
        </span>
      </div>
    </header>
  )
}
