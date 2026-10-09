import { Link } from 'react-router-dom'
import { trackNav, useNavItems, type FrameKey, type NavItem } from './navItems'

export type { FrameKey, NavKey } from './navItems'

/**
 * One sidebar link: a lucide icon and the label, 40px tall. The current page sits on a raised
 * card with its icon in gold ink and a gold marker on the sidebar's left edge (in forced-colours
 * mode, where neither the card nor the gradient is drawn, an outlined box and a solid marker), and
 * carries `aria-current="page"`. Its `data-tour` anchor is what the onboarding tour spotlights.
 */
export function SideNavLink({ item, active, onNavigate }: { item: NavItem; active?: FrameKey; onNavigate?: () => void }) {
  const isActive = item.key === active
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      onClick={() => {
        trackNav(item.to)
        onNavigate?.()
      }}
      aria-current={isActive ? 'page' : undefined}
      data-tour={item.key === 'help' ? 'help' : `nav-${item.key}`}
      className={`relative flex h-10 items-center gap-[11px] rounded-[10px] px-3 text-sm font-semibold transition-colors ${
        isActive
          ? 'bg-surface text-slate-900 shadow-[var(--shadow-frame)] before:absolute before:inset-y-[9px] before:-left-[14px] before:w-[3px] before:rounded-r-[3px] before:bg-[linear-gradient(180deg,#f4db8e,#d2a033)] forced-colors:border forced-colors:border-[color:CanvasText] forced-colors:before:bg-none forced-colors:before:bg-[color:CanvasText] forced-colors:before:[forced-color-adjust:none]'
          : 'text-slate-500 hover:bg-surface/55 hover:text-slate-900'
      }`}
    >
      <Icon
        aria-hidden
        strokeWidth={1.8}
        className={`size-[18px] shrink-0 ${isActive ? 'text-[var(--gold-ink)]' : ''}`}
      />
      <span className="truncate">{item.label}</span>
    </Link>
  )
}

/**
 * The desktop sidebar's primary navigation: Dashboard, Transactions, Jars, Accounts and Reports,
 * a divider, then People, Allocation and Import. Which of them show follows the feature flags and
 * the household (see useNavItems); Help sits in the sidebar's foot instead (AppShell). On phones
 * the same pages live in the bottom tab bar and its More sheet (PhoneNav).
 */
export function AppNav({ active, onNavigate }: { active?: FrameKey; onNavigate?: () => void }) {
  const items = useNavItems()
  const main = items.filter((i) => i.group === 'main')
  const more = items.filter((i) => i.group === 'more')

  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {main.map((i) => (
        <SideNavLink key={i.key} item={i} active={active} onNavigate={onNavigate} />
      ))}
      {more.length > 0 && <hr className="mx-2.5 my-2.5 border-slate-200" />}
      {more.map((i) => (
        <SideNavLink key={i.key} item={i} active={active} onNavigate={onNavigate} />
      ))}
    </nav>
  )
}
