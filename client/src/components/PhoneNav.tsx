import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, LogOut, Menu, Moon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { EVENTS, track } from '../analytics'
import { useTheme } from '../lib/theme'
import { AccountAvatar } from './AccountMenu'
import { useAccountIdentity } from './accountIdentity'
import { splitForPhone, trackNav, useNavItems, type FrameKey, type NavItem } from './navItems'
import { SwitchTrack } from './ThemeToggle'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from './ui/sheet'

// Equal tabs; on the narrowest phones (under 360px) each tab takes its label's width plus an equal
// share of what is left, so "Transactions" still fits beside the short labels.
const TAB =
  'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs tracking-[-0.01em] transition-colors max-[359.98px]:basis-auto'
const TAB_OFF = 'font-semibold text-slate-500'
// The current tab: bolder and darker, its icon in gold ink, the gold marker above it (a solid
// line in forced-colours mode, where the gradient is not drawn).
const TAB_ON =
  'font-bold text-slate-900 before:absolute before:-top-[7px] before:h-[3px] before:w-7 before:rounded-b-[3px] before:bg-[linear-gradient(90deg,#f4db8e,#d2a033)] forced-colors:before:bg-none forced-colors:before:bg-[color:CanvasText] forced-colors:before:[forced-color-adjust:none]'

function Tab({ on, icon: Icon, children }: { on: boolean; icon: NavItem['icon']; children: ReactNode }) {
  return (
    <>
      <Icon aria-hidden strokeWidth={1.8} className={`size-[22px] shrink-0 ${on ? 'text-[var(--gold-ink)]' : ''}`} />
      <span className="max-w-full truncate">{children}</span>
    </>
  )
}

/** A row of the More sheet: a 32px lead column for the icon (or avatar), then the label. */
const ROW =
  "relative flex min-h-[52px] w-full items-center gap-3.5 text-left text-base font-semibold text-slate-900 not-first:before:absolute not-first:before:top-0 not-first:before:-right-4 not-first:before:left-[46px] not-first:before:border-t not-first:before:border-slate-200 not-first:before:content-['']"
const ROW_ICON = 'mx-1.5 size-5 shrink-0 text-slate-500'
const GROUP =
  'flex flex-col rounded-[14px] border border-slate-200/70 bg-card px-4 shadow-[var(--shadow-frame)] [--grp:var(--color-card)] dark:bg-surface-2 dark:shadow-none dark:[--grp:var(--color-surface-2)]'

/**
 * The phone frame's navigation (below 900px): a bottom tab bar with four pages (Dashboard, Jars,
 * Transactions and Reports when their flags are on) and More, which opens a bottom sheet with
 * the remaining pages (Accounts, Import, People, Allocation, Help), the account row, the Dark
 * mode switch and Sign out. The sheet is a modal dialog: Escape or a tap outside closes it and
 * focus returns to More. The tab bar reserves its height (--tabbar-h, safe area included) so it
 * never covers the page.
 */
export function PhoneNav({ active }: { active?: FrameKey }) {
  const items = useNavItems()
  const { tabs, more } = splitForPhone(items)
  const [open, setOpen] = useState(false)
  const { name, householdLabel } = useAccountIdentity()
  const { isDark, setMode } = useTheme()
  const { logout } = useAuth()
  // The Account page lives in the sheet too (its account row), so More is lit there as well.
  const accountHere = active === 'account'
  const moreHere = accountHere || more.some((m) => m.key === active)

  // The sheet belongs to the phone layout: widening the window past the breakpoint closes it.
  useEffect(() => {
    if (!open) return
    const mq = window.matchMedia?.('(min-width: 900px)')
    if (!mq) return
    const onChange = () => mq.matches && setOpen(false)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [open])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <nav
        aria-label="Primary"
        data-tabbar
        // Above the sheet's scrim while the sheet is open, and still tappable (the modal sheet turns
        // pointer events off on the page): a tab tapped then closes the sheet and opens its page.
        className={`fixed inset-x-0 bottom-0 flex h-[var(--tabbar-h)] border-t border-slate-200 bg-surface/95 pt-1.5 pr-[max(4px,env(safe-area-inset-right))] pb-[max(14px,env(safe-area-inset-bottom))] pl-[max(4px,env(safe-area-inset-left))] backdrop-blur-md min-[900px]:hidden ${
          open ? 'pointer-events-auto z-[85]' : 'z-40'
        }`}
      >
        {tabs.map((t) => {
          const on = t.key === active && !open
          return (
            <Link
              key={t.key}
              to={t.to}
              onClick={() => trackNav(t.to)}
              aria-current={t.key === active ? 'page' : undefined}
              // The tour's anchor for this page on phones (the sidebar's link is hidden here).
              data-tour={`nav-${t.key}`}
              className={`${TAB} ${on ? TAB_ON : TAB_OFF}`}
            >
              <Tab on={on} icon={t.icon}>
                {t.label}
              </Tab>
            </Link>
          )
        })}
        {more.length > 0 && (
          <SheetTrigger
            // The tour points at More for the pages that live in the sheet.
            data-tour="nav-more"
            data-tour-more={more.map((m) => m.key).join(' ')}
            className={`${TAB} ${moreHere || open ? TAB_ON : TAB_OFF}`}
          >
            <Tab on={moreHere || open} icon={Menu}>
              More
            </Tab>
          </SheetTrigger>
        )}
      </nav>

      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        // Widening past the breakpoint closes the sheet while More is hidden: focus then goes to
        // the page's main content instead of being lost on <body>.
        onCloseAutoFocus={(e) => {
          if (window.matchMedia?.('(min-width: 900px)').matches) {
            e.preventDefault()
            document.getElementById('main-content')?.focus()
          }
        }}
        overlayClassName="bg-[rgb(10_20_15/0.32)] backdrop-blur-[2px] dark:bg-black/55"
        className="bottom-[var(--tabbar-h)] max-h-[calc(100dvh-var(--tabbar-h)-2rem)] gap-3 rounded-t-[20px] border-0 bg-background pt-2 pr-[max(1rem,env(safe-area-inset-right))] pb-4 pl-[max(1rem,env(safe-area-inset-left))] shadow-[0_-12px_32px_-12px_rgb(10_30_20/0.35)] dark:border-t dark:border-slate-200 dark:bg-card dark:shadow-[0_-12px_32px_-8px_rgb(0_0_0/0.7)]"
      >
        <SheetTitle className="sr-only">More</SheetTitle>
        <SheetClose
          aria-label="Close"
          className="relative mx-auto mb-0.5 block h-[5px] w-[38px] shrink-0 rounded-full bg-slate-500/35 after:absolute after:-inset-x-5 after:-inset-y-3.5 after:content-['']"
        />
        <nav aria-label="More pages" className={GROUP}>
          {more.map((i) => {
            const here = i.key === active
            const Icon = i.icon
            return (
              <Link
                key={i.key}
                to={i.to}
                aria-current={here ? 'page' : undefined}
                onClick={() => {
                  trackNav(i.to)
                  setOpen(false)
                }}
                className={ROW}
              >
                <Icon aria-hidden strokeWidth={1.8} className={`${ROW_ICON} ${here ? 'text-[var(--gold-ink)]!' : ''}`} />
                <span className={here ? 'font-bold' : ''}>{i.label}</span>
              </Link>
            )
          })}
        </nav>
        <div className={GROUP}>
          <Link
            to="/account"
            aria-label={`Account settings: ${[name, householdLabel].filter(Boolean).join(', ')}`}
            aria-current={accountHere ? 'page' : undefined}
            onClick={() => setOpen(false)}
            className={`${ROW} min-h-[62px]`}
          >
            <AccountAvatar size={32} ring="var(--grp)" />
            <span className="flex min-w-0 flex-1 flex-col">
              {name && <span className={`truncate ${accountHere ? 'font-bold' : ''}`}>{name}</span>}
              <span className="truncate text-[13px] font-medium text-slate-500">{householdLabel}</span>
            </span>
            <ChevronRight aria-hidden strokeWidth={1.8} className="mr-1 size-4 shrink-0 text-slate-500" />
          </Link>
          <button type="button" role="switch" aria-checked={isDark} onClick={() => setMode(isDark ? 'light' : 'dark')} className={ROW}>
            <Moon aria-hidden strokeWidth={1.8} className={ROW_ICON} />
            Dark mode
            <SwitchTrack on={isDark} />
          </button>
          <button
            type="button"
            onClick={() => {
              track(EVENTS.logout)
              logout()
            }}
            className={ROW}
          >
            <LogOut aria-hidden strokeWidth={1.8} className={ROW_ICON} />
            Sign out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

