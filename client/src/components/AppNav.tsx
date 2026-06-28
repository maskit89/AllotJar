import { Link } from 'react-router-dom'
import { useFeatures } from '../features/FeatureContext'
import { useHousehold } from '../features/HouseholdContext'
import { EVENTS, track } from '../analytics'

export type NavKey = 'budget' | 'transactions' | 'accounts' | 'funds' | 'people' | 'allocation' | 'reports' | 'help'

/**
 * The primary navigation. On the desktop sidebar (`variant="sidebar"`) it's a
 * vertical list — the active item is filled with the accent-soft tint and a solid
 * square marker (`aria-current="page"`); the rest are muted with a hollow marker.
 * On the mobile top bar (`variant="topbar"`) the same items render as a
 * horizontally-scrollable row of ≥40px pills. Accounts and Reports are hidden
 * when their feature flag is off; People is always available (it's where you
 * add/invite people), while Allocation — which only makes sense with two or more
 * people — appears only once the budget is shared. `onNavigate` lets the shell
 * react when a link is tapped.
 */
export function AppNav({
  active,
  onNavigate,
  variant = 'sidebar',
}: {
  active?: NavKey
  onNavigate?: () => void
  variant?: 'sidebar' | 'topbar'
}) {
  const features = useFeatures()
  const { isShared } = useHousehold()

  const items: { key: NavKey; to: string; label: string; show: boolean }[] = [
    { key: 'budget', to: '/', label: 'Budget', show: true },
    { key: 'transactions', to: '/transactions', label: 'Transactions', show: true },
    { key: 'accounts', to: '/accounts', label: 'Accounts', show: features.accounts },
    { key: 'funds', to: '/funds', label: 'Funds', show: features.sinkingFunds },
    { key: 'reports', to: '/reports', label: 'Reports', show: features.reports },
    { key: 'people', to: '/people', label: 'People', show: features.householdAllocation },
    { key: 'allocation', to: '/allocation', label: 'Allocation', show: features.householdAllocation && isShared },
    { key: 'help', to: '/help', label: 'Help', show: true },
  ]

  const onClick = (to: string) => {
    track(EVENTS.navClick, { destination: to })
    onNavigate?.()
  }

  const visible = items.filter((i) => i.show)

  if (variant === 'topbar') {
    return (
      <nav aria-label="Primary" className="flex flex-1 gap-1.5 overflow-x-auto pb-0.5">
        {visible.map((i) => {
          const isActive = i.key === active
          return (
            <Link
              key={i.key}
              to={i.to}
              onClick={() => onClick(i.to)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex min-h-10 shrink-0 items-center rounded-full px-[15px] text-[13px] transition ${
                isActive
                  ? 'bg-brand-600 font-semibold text-white'
                  : 'border border-slate-200 bg-surface font-semibold text-slate-500 hover:border-slate-400 hover:text-slate-900'
              }`}
            >
              {i.label}
            </Link>
          )
        })}
      </nav>
    )
  }

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {visible.map((i) => {
        const isActive = i.key === active
        return (
          <Link
            key={i.key}
            to={i.to}
            onClick={() => onClick(i.to)}
            aria-current={isActive ? 'page' : undefined}
            data-tour={i.key === 'help' ? 'help' : undefined}
            className={`flex items-center gap-[11px] rounded-[11px] px-[11px] py-[9px] text-sm transition ${
              isActive
                ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                : 'font-medium text-slate-500 hover:bg-surface hover:text-slate-900'
            }`}
          >
            <span
              aria-hidden
              className={`h-4 w-4 rounded-[5px] ${
                isActive ? 'bg-brand-600 dark:bg-brand-500' : 'border-[1.5px] border-slate-300'
              }`}
            />
            {i.label}
          </Link>
        )
      })}
    </nav>
  )
}
