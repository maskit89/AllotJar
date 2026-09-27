import type { BadgeTone } from '../components/ui'
import type { JarDto } from '../types'
import { formatMoney, fromAmount } from './money'
import { formatDate, monthYear } from './dates'

// Mirrors the server's JarDto.Status (Unavailable | Overspent | Ongoing | Unscheduled |
// FullyFunded | Behind | OnTrack — see AllotJar.Application/Jars/Dtos/JarDto.cs). Kept here so
// the Jars page and the dashboard shelf label a jar's state identically.

export interface JarStatusChip {
  label: string
  tone: BadgeTone
}

/**
 * A chip for the states worth calling out — the ones that need attention (Behind, Overspent,
 * a jar with no usable plan), the one worth celebrating (FullyFunded) and Unavailable (the
 * account's balance can't be calculated, rule 67). Returns null for the quiet defaults
 * (OnTrack, Ongoing), so a healthy jar isn't stamped with a redundant "On track" on every card.
 */
export function jarStatusChip(status: string): JarStatusChip | null {
  switch (status) {
    case 'Unavailable':
      return { label: 'Unavailable', tone: 'neutral' }
    case 'Behind':
      return { label: 'Behind', tone: 'amber' }
    case 'Overspent':
      return { label: 'Overspent', tone: 'rose' }
    case 'Unscheduled':
      return { label: 'Needs a plan', tone: 'amber' }
    case 'FullyFunded':
      return { label: 'Funded', tone: 'teal' }
    default:
      return null
  }
}

/**
 * Rule 14, in one line: this month's plan, what has actually gone in since the month began and
 * what is still to go — three separate figures, the plan never shrinking because money landed.
 * When nothing is planned the line says why instead of showing a bare dash.
 */
export function jarMonthLabel(jar: JarDto, currency: string): string {
  if (jar.status === 'Unavailable') return 'Balance not available'
  if (jar.status === 'Unscheduled') return 'Add a deadline or a monthly amount to plan contributions'
  const planned = fromAmount(jar.plannedThisMonth)
  if (planned <= 0) {
    if (jar.status === 'FullyFunded') {
      const excess = fromAmount(jar.currentBalance ?? 0) - fromAmount(jar.targetAmount)
      return excess > 0 ? `Fully funded · ${formatMoney(excess, currency)} above target` : 'Fully funded'
    }
    return 'Nothing to set aside this month'
  }
  return `Plan ${formatMoney(planned, currency)} · in ${formatMoney(fromAmount(jar.contributedThisMonth), currency)} · to go ${formatMoney(fromAmount(jar.remainingThisMonth), currency)}`
}

/**
 * Where the plan is heading: the funding-completion month and the deadline it serves (rule 36
 * keeps them distinct), the estimated months for a fixed monthly target (rule 58, never a
 * deadline), or "ongoing". Null when there is nothing to say.
 */
export function jarHorizonLabel(jar: JarDto): string | null {
  if (jar.status === 'Unavailable' || jar.status === 'Unscheduled') return null
  if (jar.status === 'Ongoing') return 'Ongoing'
  if (jar.fundingCompletesOn) {
    const due = jar.deadline ? ` · due ${formatDate(jar.deadline)}` : ''
    const repeats = jar.recurMonths ? ', then it repeats' : ''
    return `Funded by ${monthYear(jar.fundingCompletesOn)}${due}${repeats}`
  }
  if (jar.estimatedMonthsToTarget !== null && jar.estimatedMonthsToTarget > 0) {
    const n = jar.estimatedMonthsToTarget
    return `About ${n} more month${n === 1 ? '' : 's'} at this rate (an estimate, not a deadline)`
  }
  if (jar.deadline) return `Due ${formatDate(jar.deadline)}`
  return null
}
