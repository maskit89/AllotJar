import type { ComponentType } from 'react'
import { ArrowLeftRight, ChartColumn, CircleHelp, Download, House, Landmark, Split, Users, type LucideProps } from 'lucide-react'
import { EVENTS, track } from '../analytics'
import { useAuth } from '../auth/AuthContext'
import { useFeatures } from '../features/FeatureContext'
import { useHousehold } from '../features/HouseholdContext'
import { JarNavIcon } from './icons'

export type NavKey =
  | 'budget'
  | 'transactions'
  | 'accounts'
  | 'jars'
  | 'people'
  | 'allocation'
  | 'reports'
  | 'import'
  | 'help'

/** What a page tells the frame it is: a nav page, or the Account page (reached from the account
 *  button, so the frame marks that instead). */
export type FrameKey = NavKey | 'account'

export interface NavItem {
  key: NavKey
  to: string
  label: string
  icon: ComponentType<LucideProps>
  /** main: the sidebar's first block; more: below its divider; help: the sidebar's foot. */
  group: 'main' | 'more' | 'help'
}

// The order follows how a household sets up: accounts first, then jars, then the transactions
// (and their import), then the reports; People and Allocation sit below the divider.
const ALL: NavItem[] = [
  { key: 'budget', to: '/', label: 'Dashboard', icon: House, group: 'main' },
  { key: 'accounts', to: '/accounts', label: 'Accounts', icon: Landmark, group: 'main' },
  { key: 'jars', to: '/jars', label: 'Jars', icon: JarNavIcon, group: 'main' },
  { key: 'transactions', to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, group: 'main' },
  { key: 'import', to: '/import', label: 'Import', icon: Download, group: 'main' },
  { key: 'reports', to: '/reports', label: 'Reports', icon: ChartColumn, group: 'main' },
  { key: 'people', to: '/people', label: 'People', icon: Users, group: 'more' },
  { key: 'allocation', to: '/allocation', label: 'Allocation', icon: Split, group: 'more' },
  { key: 'help', to: '/help', label: 'Help', icon: CircleHelp, group: 'help' },
]

/** Which pages get the phone tab bar's slots, in priority order: the first four visible pages
 *  get a tab (the everyday pages first; Accounts is set up once and lives under More). */
const TAB_PRIORITY: NavKey[] = ['budget', 'jars', 'transactions', 'reports', 'accounts', 'people', 'allocation', 'import']
const TAB_COUNT = 4

/**
 * The pages the frame links to, after the feature-flag and role rules: Accounts, Jars and
 * Reports only when their flag is on; People whenever household allocation is on (it is where
 * you add and invite people); Allocation, which splits money between two or more people, only
 * once the budget is shared; Import only when the statement-import flag is on and the login may
 * change the budget (the page itself refuses read-only and limited logins). Dashboard,
 * Transactions and Help always show.
 */
export function useNavItems(): NavItem[] {
  const features = useFeatures()
  const { isShared } = useHousehold()
  const { canWrite } = useAuth()
  const show: Record<NavKey, boolean> = {
    budget: true,
    transactions: true,
    jars: features.jars,
    accounts: features.accounts,
    reports: features.reports,
    people: features.householdAllocation,
    allocation: features.householdAllocation && isShared,
    import: features.camtImport && canWrite,
    help: true,
  }
  return ALL.filter((i) => show[i.key])
}

/**
 * The phone layout's split of the same pages: four tabs in the bottom bar (Dashboard, Jars,
 * Transactions, Reports when all are on; a page whose flag is off gives its tab to the next one
 * in TAB_PRIORITY), and everything else in the More sheet, Help last. Both keep the sidebar's
 * order.
 */
export function splitForPhone(items: NavItem[]): { tabs: NavItem[]; more: NavItem[] } {
  const byKey = new Map(items.map((i) => [i.key, i]))
  const tabKeys = new Set(
    TAB_PRIORITY.filter((k) => byKey.has(k)).slice(0, TAB_COUNT),
  )
  const tabs = items.filter((i) => tabKeys.has(i.key))
  const more = items.filter((i) => !tabKeys.has(i.key))
  return { tabs, more }
}

/** Every frame link reports where it goes (sidebar, tab bar and More sheet alike). */
export function trackNav(to: string) {
  track(EVENTS.navClick, { destination: to })
}
