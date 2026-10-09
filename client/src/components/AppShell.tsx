import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'
import { AccountMenu } from './AccountMenu'
import { AppNav, SideNavLink, type FrameKey } from './AppNav'
import { JarLogo } from './Jar'
import { useNavItems } from './navItems'
import { PhoneNav } from './PhoneNav'
import { SharingReviewBanner } from './SharingReviewBanner'
import { StagingBanner } from './StagingBanner'
import { TopBar } from './TopBar'
import { VerifyEmailBanner } from './VerifyEmailBanner'

/**
 * The frame every signed-in page renders in (the approved "polished Warm" mock-ups).
 *
 * Desktop (900px and up): a sidebar on the side tone (the wordmark, the primary nav with the
 * current page on a raised card with a gold marker, Help and the account button at the foot) and
 * a sticky top bar over the content (the page title as the screen's <h1>, the month switcher on
 * month-scoped pages, the page's actions and the theme button).
 * Phone (below 900px): a slim top bar (logo, title, month, account avatar) and a bottom tab bar
 * whose More sheet holds the other pages, the account, Dark mode and Sign out (PhoneNav).
 *
 * The banners (verify email, sharing review, the household greeting, read-only / limited access)
 * open the content, under the top bar.
 */
export function AppShell({
  active,
  title,
  month = false,
  actions,
  children,
}: {
  /** The frame's current place: a nav page, or 'account' (the account button is marked then). */
  active?: FrameKey
  /** The page's title: the top bar's visible <h1>, the screen's one top-level heading. */
  title?: string
  /**
   * Show the month switcher. Only for pages whose content follows the app-wide month (they read
   * useMonth): the Dashboard, Transactions, People and Allocation.
   */
  month?: boolean
  /**
   * The page's own buttons (e.g. "Add transaction"), for the page PRs to come: on desktop they sit
   * in the top bar beside the month; on phones, where the top bar has no room, they open the
   * content as a right-aligned row. They render in one place at a time (never two mounted copies).
   */
  actions?: ReactNode
  // Kept for call-site compatibility; the frame uses one 1240px column.
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

  const help = useNavItems().find((i) => i.key === 'help')
  const desktop = useMediaQuery('(min-width: 900px)')

  return (
    <div className="min-h-screen bg-background min-[900px]:grid min-[900px]:grid-cols-[248px_minmax(0,1fr)]">
      {/* Bypass Blocks (2.4.1): a keyboard skip link to the main content. It appears at once
          (transition-none: the reduced-motion rule would otherwise tween its ring in). */}
      <a
        href="#main-content"
        className="sr-only rounded-lg transition-none font-semibold text-brand-700 focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:border focus:border-brand-500 focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-card dark:text-brand-200"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar (900px and up). */}
      <aside
        data-tour="sidebar"
        className="sticky top-0 hidden h-screen flex-col gap-1.5 overflow-y-auto border-r border-slate-200 bg-side px-3.5 pt-[18px] pb-3.5 min-[900px]:flex"
      >
        <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-5">
          <JarLogo size={30} />
          <span className="text-lg font-bold tracking-[-0.015em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </span>
        </div>

        <AppNav active={active} />

        <div className="mt-auto flex flex-col gap-1.5 pt-3">
          {help && <SideNavLink item={help} active={active} />}
          <AccountMenu variant="sidebar" current={active === 'account'} />
        </div>
      </aside>

      {/* Content column: the sticky top bar, then the page. */}
      <div className="flex min-w-0 flex-col">
        {/* Not sticky inside the app: the top bar is what stays in view. */}
        <div className="*:static">
          <StagingBanner />
        </div>
        <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
          <TopBar title={title} month={month} actions={desktop ? actions : undefined} />
          <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-4 px-4 pt-1 pb-[calc(var(--tabbar-h)+32px)] min-[900px]:gap-6 min-[900px]:px-10 min-[900px]:pb-14">
            {actions && !desktop && <div className="flex justify-end gap-2.5">{actions}</div>}
            <VerifyEmailBanner />
            <SharingReviewBanner />

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
          </div>
        </main>
      </div>

      {/* Phone navigation (below 900px): the bottom tab bar and its More sheet. */}
      <PhoneNav active={active} />
    </div>
  )
}
