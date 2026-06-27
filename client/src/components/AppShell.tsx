import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { AppNav, type NavKey } from './AppNav'
import { HouseholdSwitcher } from './HouseholdSwitcher'
import { JarLogo } from './Jar'
import { HelpIcon, LogoutIcon, SettingsIcon } from './icons'
import { ThemeToggle } from './ThemeToggle'
import { EVENTS, track } from '../analytics'

/** Two-letter initials from a display name (or the email's first letter). */
function initialsOf(name: string, email: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
  return initials || email?.trim().charAt(0).toUpperCase() || '?'
}

/**
 * The shared dashboard chrome, redesigned: a desktop left **sidebar** (the jar
 * logo, primary nav, a pinned user chip) that collapses below 900px into a
 * horizontal **top bar** with scrollable nav pills. A slim top header in the
 * content column carries the global actions (household switcher, theme, help,
 * settings, sign-out) and a "Zero-based" signature pill. Every authenticated page
 * renders its hero + content inside the 1180px column.
 */
export function AppShell({
  active,
  maxWidth = '5xl',
  children,
}: {
  active?: NavKey
  maxWidth?: '4xl' | '5xl'
  children: ReactNode
}) {
  const { email, displayName, preferredCurrency, households, logout, canWrite, canEnterData, isReadOnly } = useAuth()
  // Only Limited/Read-only roles are restricted; Owner/Admin have full write access.
  const accessBanner = isReadOnly
    ? 'You have read-only access — you can view everything but cannot make changes.'
    : !canWrite && canEnterData
      ? 'You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings.'
      : null
  const width = maxWidth === '4xl' ? 'max-w-[1080px]' : 'max-w-[1180px]'
  const name = displayName || email || ''
  const initials = initialsOf(name, email)
  const householdLabel = households.find((h) => h.isActive)?.label ?? 'Personal'

  const headerActions = (
    <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
      <ThemeToggle />
      <Link
        to="/help"
        data-tour="help"
        aria-label="Help & guide"
        title="Help & guide"
        className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <HelpIcon className="h-5 w-5" />
      </Link>
      <Link
        to="/account"
        aria-label="Account settings"
        title="Account settings"
        className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <SettingsIcon className="h-5 w-5" />
      </Link>
      <button
        type="button"
        onClick={() => {
          track(EVENTS.logout)
          logout()
        }}
        className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 sm:px-3"
      >
        <LogoutIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-50 min-[900px]:flex">
      {/* Bypass Blocks (2.4.1): a keyboard skip link to the main content. */}
      <a
        href="#main-content"
        className="sr-only rounded-lg font-semibold text-brand-700 focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:border focus:border-brand-500 focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-card"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar (≥900px). */}
      <aside
        data-tour="sidebar"
        className="sticky top-0 hidden h-screen w-[230px] shrink-0 flex-col gap-1 self-stretch overflow-y-auto border-r border-slate-200 bg-surface-2 px-[18px] py-6 min-[900px]:flex"
      >
        <div className="flex items-center gap-[11px] px-2 pb-[22px]">
          <JarLogo />
          <span className="text-lg font-bold tracking-[-0.02em] text-slate-900">allotjar</span>
        </div>

        <AppNav active={active} variant="sidebar" />

        <div className="mt-auto flex items-center gap-[11px] border-t border-slate-200 pt-[18px]">
          <span
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-brand-600 text-[13px] font-semibold text-white"
            aria-hidden
          >
            {initials}
          </span>
          <div className="min-w-0">
            {name && <div className="truncate text-[13.5px] font-semibold text-slate-900">{name}</div>}
            <div className="truncate text-[11.5px] text-slate-500">
              {preferredCurrency} · {householdLabel}
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile top bar (<900px): logo + scrollable nav pills. */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-surface-2 px-3.5 py-3 min-[900px]:hidden">
        <div className="flex shrink-0 items-center gap-2">
          <JarLogo compact />
          <span className="text-base font-bold tracking-[-0.02em] text-slate-900">allotjar</span>
        </div>
        <AppNav active={active} variant="topbar" />
      </header>

      {/* Content column. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-surface/80 px-4 backdrop-blur sm:px-6">
          <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
            Zero-based
          </span>
          <HouseholdSwitcher />
          {headerActions}
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className={`mx-auto w-full space-y-[22px] px-[clamp(16px,4.5vw,38px)] pb-11 pt-[clamp(18px,3.4vw,30px)] focus:outline-none ${width}`}
        >
          {accessBanner && (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {accessBanner}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}
