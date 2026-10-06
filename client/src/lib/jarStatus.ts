import type { BadgeTone } from '../components/ui'
import type { JarDto } from '../types'
import { formatMoney, fromAmount } from './money'
import { formatDate, monthYear } from './dates'

// Mirrors the server's JarDto.Status (Unavailable | Completed | DeadlineMissed | FundedLate |
// Overspent | Ongoing | Unscheduled | FullyFunded | Behind | OnTrack — see
// AllotJar.Application/Jars/Dtos/JarDto.cs). Kept here so the Jars page and the dashboard shelf
// label a jar's state identically.

export interface JarStatusChip {
  label: string
  tone: BadgeTone
}

/**
 * A chip for the states worth calling out — the ones that need attention (a missed deadline
 * (rule 20) and Funded late (rule 57), Behind, Overspent, a jar with no usable plan), the ones
 * that mark an ending (FullyFunded; Completed, rule 55) and Unavailable (the account's balance
 * can't be calculated, rule 67). Returns null for the quiet defaults (OnTrack, Ongoing), so a healthy jar isn't
 * stamped with a redundant "On track" on every card.
 */
export function jarStatusChip(status: string): JarStatusChip | null {
  switch (status) {
    case 'Unavailable':
      return { label: 'Unavailable', tone: 'neutral' }
    case 'Completed':
      return { label: 'Completed', tone: 'neutral' }
    case 'DeadlineMissed':
      return { label: 'Deadline missed', tone: 'rose' }
    case 'FundedLate':
      return { label: 'Funded late', tone: 'amber' }
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
  // Rule 56: a completed jar keeps what it holds, visibly, until the user moves it.
  if (jar.status === 'Completed') {
    const left = fromAmount(jar.currentBalance ?? 0)
    return left > 0 ? `Completed · ${formatMoney(left, currency)} left to move` : 'Completed'
  }
  if (jar.status === 'Unscheduled') return 'Give it a date or a monthly amount'
  // Rule 60: a skipped month plans nothing; the rest of the schedule carries on.
  if (jar.skippedThisMonth) return 'Skipped this month'
  // Rule 20: the missed deadline and what is still short stay in view until the user acts;
  // rule 57: reached late, the notice stays but nothing is short.
  if (jar.status === 'DeadlineMissed' && jar.deadline) {
    return `Deadline ${formatDate(jar.deadline)} missed · ${formatMoney(fromAmount(jar.shortfall ?? 0), currency)} short`
  }
  if (jar.status === 'FundedLate' && jar.deadline) return `Funded after the deadline on ${formatDate(jar.deadline)}`
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
  if (jar.status === 'Completed') {
    return jar.completedOn ? `Completed on ${formatDate(jar.completedOn)} · no more contributions planned` : 'No more contributions planned'
  }
  if (jar.status === 'DeadlineMissed' || jar.status === 'FundedLate') return 'Mark the cycle paid, or dismiss it to save toward the next one'
  if (jar.status === 'Ongoing') return 'Ongoing'
  if (jar.fundingCompletesOn) {
    const due = jar.deadline ? ` · ${dueLabel(jar)} ${formatDate(jar.deadline)}` : ''
    return `Funded by ${monthYear(jar.fundingCompletesOn)}${due}${repeatsLabel(jar)}`
  }
  if (jar.estimatedMonthsToTarget !== null && jar.estimatedMonthsToTarget > 0) {
    const n = jar.estimatedMonthsToTarget
    return `About ${n} more month${n === 1 ? '' : 's'} at this rate (an estimate, not a deadline)`
  }
  if (jar.deadline) return `${capitalise(dueLabel(jar))} ${formatDate(jar.deadline)}${repeatsLabel(jar)}`
  return null
}

/** A Recurring jar's date is the next due date; a Goal's is when the money is needed by. */
function dueLabel(jar: JarDto): string {
  return jar.recurMonths !== null ? 'next due' : 'needed by'
}

/** " · repeats every year" for a Recurring jar, in the words the form uses; nothing for a Goal. */
function repeatsLabel(jar: JarDto): string {
  const n = jar.recurMonths
  if (n === null) return ''
  return ` · repeats every ${n === 12 ? 'year' : n === 1 ? 'month' : `${n} months`}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * How a Recurring jar's last cycle ended (W03), in one line: "Last cycle · due 1 Dec 2025 ·
 * paid 28 Nov 2025 (€550.00)", "… · funded on time", "… · funded late", "… · missed", "… · waiting
 * for the deadline" (unpaid and not yet judged). Null when no cycle has closed yet, or for a Goal.
 */
export function jarLastCycleLabel(jar: JarDto, currency: string): string | null {
  const cycle = jar.lastCycle
  if (!cycle || jar.recurMonths === null) return null
  const due = `Last cycle · due ${formatDate(cycle.deadline)}`
  switch (cycle.outcome) {
    case 'Paid': {
      const paid = cycle.paidOn ? `paid ${formatDate(cycle.paidOn)}` : 'paid'
      const amount = cycle.paidAmount !== null ? ` (${formatMoney(fromAmount(cycle.paidAmount), currency)})` : ''
      return `${due} · ${paid}${amount}${cycle.paidOn && !cycle.paidOnTime ? ', after the deadline' : ''}`
    }
    case 'Funded':
      return `${due} · funded on time, payment not recorded`
    case 'Waiting':
      // Its payment was removed before the deadline: judged only when the deadline comes (D17).
      return `${due} · waiting for the deadline`
    case 'FundedLate':
      return `${due} · funded late`
    case 'Missed':
      return `${due} · missed`
    default:
      return due
  }
}
