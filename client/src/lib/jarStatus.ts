import type { BadgeTone } from '../components/ui'
import type { JarDto } from '../types'
import { formatMoney, fromAmount } from './money'
import { monthYear } from './dates'

// Mirrors the server's JarDto.Status (Unavailable | Overspent | Unfunded | FullyFunded |
// Behind | OnTrack — see AllotJar.Application/Jars/Dtos/JarDto.cs). Kept here so the Jars page
// and the dashboard shelf label a jar's state identically.

export interface JarStatusChip {
  label: string
  tone: BadgeTone
}

/**
 * A chip for the states worth calling out — the two that need attention (Behind,
 * Overspent), the one worth celebrating (FullyFunded) and Unavailable (the account's
 * balance can't be calculated, rule 67). Returns null for the quiet defaults (OnTrack,
 * and Unfunded where there's simply no target yet), so a healthy jar isn't stamped
 * with a redundant "On track" on every card.
 */
export function jarStatusChip(status: string): JarStatusChip | null {
  switch (status) {
    case 'Unavailable':
      return { label: 'Unavailable', tone: 'neutral' }
    case 'Behind':
      return { label: 'Behind', tone: 'amber' }
    case 'Overspent':
      return { label: 'Overspent', tone: 'rose' }
    case 'FullyFunded':
      return { label: 'Funded', tone: 'teal' }
    default:
      return null
  }
}

/**
 * The one-line pace summary under a jar: its monthly set-aside (with the projected
 * finish date when there is one), or — when nothing is being set aside — the reason,
 * so a €0/mo jar reads "Fully funded" / "No target yet" instead of a bare em-dash.
 */
export function jarPaceLabel(jar: JarDto, currency: string): string {
  const monthly = fromAmount(jar.requiredMonthlyContribution)
  if (monthly > 0) {
    const perMonth = `+${formatMoney(monthly, currency)}/mo`
    return jar.projectedFullyFundedDate
      ? `${perMonth} · full by ${monthYear(jar.projectedFullyFundedDate)}`
      : perMonth
  }
  switch (jar.status) {
    case 'Unavailable':
      return 'Balance not available'
    case 'FullyFunded':
      return 'Fully funded'
    case 'Unfunded':
      return 'No target yet'
    default:
      return '—'
  }
}
