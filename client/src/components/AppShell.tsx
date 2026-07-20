import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { AppNav, type NavKey } from './AppNav'
import { StagingBanner } from './StagingBanner'
import { JarLogo } from './Jar'
import { TopBar } from './TopBar'
import { VerifyEmailBanner } from './VerifyEmailBanner'
import { LogoutIcon, SettingsIcon } from './icons'
import { EVENTS, track } from '../analytics'

/** Two-letter initials from a display name (or the email's first letter). */
function initialsOf(name: string, email: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
  return initials || email?.trim().charAt(0).toUpperCase() || '?'
}

/**
 * The user chip + dropdown menu pinned to the sidebar (and the avatar on the
 * mobile top bar). Since the redesign's clean top bar leaves no room for them,
 * this is where Account settings, household switching, and Sign out live. Opens
 * upward in the sidebar, downward on mobile.
 */
function UserMenu({ compact = false }: { compact?: boolean }) {
  const { email, displayName, preferredCurrency, households, switchHousehold, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = displayName || email || ''
  const initials = initialsOf(name, email)
  const householdLabel = households.find((h) => h.isActive)?.label ?? 'Personal'
  const multi = households.length > 1
  const avatar = (
    <span
      className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-brand-600 text-[13px] font-semibold text-white"
      aria-hidden
    >
      {initials}
    </span>
  )

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`flex items-center gap-[11px] rounded-xl text-left transition hover:bg-slate-100 ${
          compact ? 'p-0.5' : 'w-full p-2'
        }`}
      >
        {avatar}
        {!compact && (
          <span className="min-w-0">
            {name && <span className="block truncate text-[13.5px] font-semibold text-slate-900">{name}</span>}
            <span className="block truncate text-[11.5px] text-slate-500">
              {preferredCurrency} · {householdLabel}
            </span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-30 w-56 rounded-xl border border-slate-200 bg-surface p-1.5 shadow-card ${
            compact ? 'right-0 top-full mt-2' : 'bottom-full left-0 mb-2'
          }`}
        >
          {multi && (
            <>
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Household
              </p>
              {households.map((h) => (
                <button
                  key={h.ownerId}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (!h.isActive) void switchHousehold(h.ownerId)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition hover:bg-slate-100 ${
                    h.isActive ? 'font-semibold text-brand-700 dark:text-brand-200' : 'text-slate-700'
                  }`}
                >
                  <span className="truncate">{h.label}</span>
                  {h.isActive && <span aria-hidden>✓</span>}
                </button>
              ))}
              <div className="my-1 border-t border-slate-100" />
            </>
          )}
          <Link
            to="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
          >
            <SettingsIcon className="h-4 w-4 text-slate-500" />
            Account settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              track(EVENTS.logout)
              logout()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
          >
            <LogoutIcon className="h-4 w-4 text-slate-500" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The shared dashboard chrome, redesigned to the screenshots: a desktop left
 * sidebar (jar logo · primary nav · user-chip menu) that collapses below 900px
 * into a horizontal top bar with scrollable nav pills + the user menu. The
 * content column opens with the shared TopBar (month navigator + Zero-based pill
 * + theme toggle) — every authenticated page renders its hero/content beneath it.
 */
export function AppShell({
  active,
  title,
  children,
}: {
  active?: NavKey
  /**
   * The page's accessible name. Rendered as a visually-hidden `<h1>` so every
   * screen exposes exactly one top-level heading for assistive tech and the
   * skip-link target — the redesign's visual header is the TopBar, not an on-page
   * title. Pages that already render their own visible `<h1>` (e.g. Help) omit it.
   */
  title?: string
  // Kept for call-site compatibility; the redesign uses a single 1180px column.
  maxWidth?: '4xl' | '5xl'
  children: ReactNode
}) {
  const { canWrite, canEnterData, isReadOnly } = useAuth()
  const accessBanner = isReadOnly
    ? 'You have read-only access — you can view everything but cannot make changes.'
    : !canWrite && canEnterData
      ? 'You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings.'
      : null

  // A one-time greeting after a household change: ?joined=1 (accepted an invite), ?started=1
  // (started an own budget) or ?left=1 (left a joined household, landing back in their own).
  // The param is stripped immediately so a refresh doesn't repeat it.
  const [greeting, setGreeting] = useState<'joined' | 'started' | 'left' | null>(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('joined')) return 'joined'
    if (params.has('started')) return 'started'
    if (params.has('left')) return 'left'
    return null
  })
  useEffect(() => {
    if (greeting) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [greeting])

  return (
    <div className="min-h-screen min-[900px]:flex">
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
          <span className="text-lg font-extrabold tracking-[-0.035em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </span>
        </div>

        <AppNav active={active} variant="sidebar" />

        <div className="mt-auto border-t border-slate-200 pt-[14px]">
          <UserMenu />
        </div>
      </aside>

      {/* Mobile top bar (<900px): logo + scrollable nav pills + user menu. */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-surface-2 px-3.5 py-3 min-[900px]:hidden">
        <div className="flex shrink-0 items-center gap-2">
          <JarLogo compact />
          <span className="text-base font-extrabold tracking-[-0.035em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </span>
        </div>
        <AppNav active={active} variant="topbar" />
        <UserMenu compact />
      </header>

      {/* Content column. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <StagingBanner />
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-[1180px] flex-col gap-[22px] px-[clamp(16px,4.5vw,38px)] pb-11 pt-[clamp(18px,3.4vw,30px)] focus:outline-none"
        >
          {title && <h1 className="sr-only">{title}</h1>}
          <TopBar />
          <VerifyEmailBanner />

          {greeting && (
            <div
              role="status"
              className="flex items-start justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
            >
              <span>
                {greeting === 'joined'
                  ? 'You’ve joined this household — you’re viewing its shared budget now. You can switch households anytime from the account menu.'
                  : greeting === 'started'
                    ? 'This is your own budget — set up your first month below. You can switch back to the shared household anytime from the account menu.'
                    : 'You’ve left that household — you’re viewing your own budget now. Nothing was deleted; you can be invited back anytime.'}
              </span>
              <button
                type="button"
                onClick={() => setGreeting(null)}
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 text-brand-700 transition hover:bg-brand-100 dark:text-brand-200"
              >
                ✕
              </button>
            </div>
          )}
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
