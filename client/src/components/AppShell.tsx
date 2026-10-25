import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'
import { AccountMenu } from './AccountMenu'
import { AppNav, SideNavLink, type FrameKey } from './AppNav'
import { JarLogo } from './Jar'
import { useNavItems } from './navItems'
import { Notice } from './Notice'
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
 * open the content, under the top bar: one Notice line each (restyle PR 17). The sidebar is marked
 * `data-sidebar` so a bar fixed over the foot of the screen (the analytics consent banner) can
 * keep to the content column (`--sidebar-w`, index.css).
 */
export function AppShell({
  active,
  title,
  month = false,
  actions,
  back,
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
  /**
   * A detail page's way back to its parent page (e.g. an account's page back to Accounts): a
   * chevron link named "Back to {label}" before the title, in place of the phone's logo. Left out,
   * the top bar is as on every other page.
   */
  back?: { to: string; label: string }
  children: ReactNode
}) {
  const { canWrite, canEnterData, isReadOnly } = useAuth()
  // One line, on the info tone for read-only and the warn tone for limited; what the access level
  // allows in full sits behind the line's (i).
  const access = isReadOnly
    ? {
        tone: 'info' as const,
        line: 'Read-only access: you can view everything, not change it.',
        hint: 'You can open every page and see every figure, but nothing here can be added, changed or deleted by you. Ask the owner or an admin for more access.',
      }
    : !canWrite && canEnterData
      ? {
          tone: 'warn' as const,
          line: 'Limited access: you can record transactions, mark bills paid and run allocation.',
          hint: 'You can add, split and assign transactions, mark bills paid and run allocation. The budget’s groups and lines, accounts, people and settings take an admin.',
        }
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
        data-sidebar=""
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
          <TopBar title={title} month={month} actions={desktop ? actions : undefined} back={back} />
          <div className="mx-auto flex w-full max-w-(--content-max) flex-col gap-4 px-4 pt-1 pb-[calc(var(--tabbar-h)+32px)] min-[900px]:gap-6 min-[900px]:px-10 min-[900px]:pb-14">
            {actions && !desktop && <div className="flex justify-end gap-2.5">{actions}</div>}
            <VerifyEmailBanner />
            <SharingReviewBanner />

            {greeting && (
              <Notice tone="ok" role="status" onDismiss={() => setGreeting(null)}>
                {greeting === 'joined'
                  ? 'You’ve joined the household.'
                  : greeting === 'started'
                    ? 'Your own budget is ready.'
                    : 'You’re back on your own budget.'}
              </Notice>
            )}
            {access && (
              <Notice tone={access.tone} role="status" hint={access.hint} hintLabel="About your access">
                {access.line}
              </Notice>
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
