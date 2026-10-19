import type { BadgeTone } from '../components/ui'
import type { ChipTone } from '../components/StatusChip'
import type { JarDto } from '../types'
import { RECUR_MONTHS_OPTIONS } from '../types'
import { formatMoney, fromAmount } from './money'
import { formatDate, monthYear } from './dates'

// Mirrors the server's JarDto.Status (Unavailable | Completed | DeadlineMissed | FundedLate |
// Overspent | Ongoing | Unscheduled | FullyFunded | Behind | OnTrack — see
// AllotJar.Application/Jars/Dtos/JarDto.cs). Kept here so the Jars page and the dashboard shelf
// label a jar's state identically.

/**
 * A jar's date as the person gave it: "Mar 2027" when it is just a month (the 1st of it,
 * `monthOnly`), otherwise the full date ("1 Mar 2027").
 */
export function jarDate(iso: string, monthOnly: boolean): string {
  return isMonth(iso, monthOnly) ? monthYear(iso) : formatDate(iso)
}

function isMonth(iso: string, monthOnly: boolean): boolean {
  return monthOnly && iso.endsWith('-01')
}

/** The date `months` after `iso` (a day past the end of the month lands on its last day). */
function monthsLater(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/**
 * The cycle deadline the server moves the jar to (JarSchedule.NextCycleDeadline): the first
 * `anchor + k·step` months after `after`, stepped from the anchor so a clamped month does not stay
 * clamped (rule 62: 31 Jan → 28 Feb → 31 Mar).
 */
export function nextCycleDeadline(anchor: string, after: string, step: number): string {
  const [ay, am] = anchor.split('-').map(Number)
  const [y, m] = after.split('-').map(Number)
  let cycles = Math.max(0, Math.floor(((y - ay) * 12 + (m - am)) / step))
  let next = monthsLater(anchor, cycles * step)
  while (next <= after) next = monthsLater(anchor, ++cycles * step)
  return next
}

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
      return { label: 'Deadline missed', tone: 'bad' }
    case 'FundedLate':
      return { label: 'Funded late', tone: 'warn' }
    case 'Behind':
      return { label: 'Behind', tone: 'warn' }
    case 'Overspent':
      return { label: 'Overspent', tone: 'bad' }
    case 'Unscheduled':
      return { label: 'Needs a plan', tone: 'warn' }
    case 'FullyFunded':
      return { label: 'Funded', tone: 'ok' }
    default:
      return null
  }
}

/** How a jar chip reads in the restyle's status tones (StatusChip), on the Dashboard shelf and the Jars page. */
export const JAR_CHIP_TONE: Record<BadgeTone, ChipTone> = {
  bad: 'bad',
  warn: 'warn',
  ok: 'ok',
  brand: 'ok',
  neutral: 'neutral',
}

/**
 * The chip a jar's card shows (the shelf and the Jars page): jarStatusChip, except that an unknown
 * balance already reads "Not available" (rule 67), so no "Unavailable" chip says the same again.
 */
export function jarCardChip(jar: Pick<JarDto, 'status' | 'currentBalance'>): JarStatusChip | null {
  return jar.currentBalance === null && jar.status === 'Unavailable' ? null : jarStatusChip(jar.status)
}

/** Attention first: the states that need something done, then the quiet ones, then the endings. */
const ATTENTION_ORDER: Record<string, number> = {
  DeadlineMissed: 0,
  Overspent: 1,
  Unavailable: 2,
  Behind: 3,
  FundedLate: 4,
  Unscheduled: 5,
  OnTrack: 6,
  Ongoing: 6,
  FullyFunded: 7,
  Completed: 8,
}

/**
 * The jars in the order the shelf and the Jars page show them (attention first, then the
 * household's own order), each with its place in the household's list: a jar's colour comes from
 * that place, so it keeps its colour wherever it is shown.
 */
export function byAttention<T extends Pick<JarDto, 'status'>>(jars: T[]): { jar: T; index: number }[] {
  return jars
    .map((jar, index) => ({ jar, index }))
    .sort((a, b) => (ATTENTION_ORDER[a.jar.status] ?? 6) - (ATTENTION_ORDER[b.jar.status] ?? 6) || a.index - b.index)
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
  // A jar can't be planned by a date without a target, so a target-less one is asked for both.
  if (jar.status === 'Unscheduled') return jar.targetAmount > 0 ? 'Give it a date or a monthly amount' : 'Give it a target and a date, or a monthly amount'
  // Rule 60: a skipped month plans nothing; the rest of the schedule carries on.
  if (jar.skippedThisMonth) return 'Skipped this month'
  // Rule 20: the missed deadline and what is still short stay in view until the user acts;
  // rule 57: reached late, the notice stays but nothing is short.
  if (jar.status === 'DeadlineMissed' && jar.deadline) {
    return `Deadline ${jarDate(jar.deadline, jar.monthOnly)} missed · ${formatMoney(fromAmount(jar.shortfall ?? 0), currency)} short`
  }
  if (jar.status === 'FundedLate' && jar.deadline) {
    return isMonth(jar.deadline, jar.monthOnly)
      ? `Funded after the ${monthYear(jar.deadline)} deadline`
      : `Funded after the deadline on ${formatDate(jar.deadline)}`
  }
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
 * Where the plan is heading, in a few words: the date the money is due or needed by, and how
 * often a repeating jar comes round; a fixed monthly target's estimate (rule 58, never a
 * deadline); an ongoing pot's monthly amount. Null when the other lines already say it: a
 * completed jar (the chip and the month line, rule 56) and a missed deadline (the month line
 * and the card's own buttons, rules 20 and 57). The month the funding completes isn't repeated
 * here: the form's preview shows it, and the deadline stays the deadline (rule 36). `month` names
 * only the month of the date (see jarDueLabel).
 */
export function jarHorizonLabel(jar: JarDto, currency: string, opts: { month?: boolean } = {}): string | null {
  switch (jar.status) {
    case 'Unavailable':
    case 'Unscheduled':
    case 'Completed':
    case 'DeadlineMissed':
    case 'FundedLate':
      return null
    case 'Ongoing': {
      const monthly = jar.monthlyContribution ?? 0
      return monthly > 0 ? `${formatMoney(fromAmount(monthly), currency)} every month` : null
    }
  }
  if (jar.estimatedMonthsToTarget !== null && jar.estimatedMonthsToTarget > 0) {
    const n = jar.estimatedMonthsToTarget
    return `About ${n} month${n === 1 ? '' : 's'} to go (estimate)`
  }
  const due = jarDueLabel(jar, opts)
  return due === null || jar.recurMonths === null ? due : `${due} · ${cadenceLabel(jar.recurMonths)}`
}

/**
 * When a jar's money is due (a Recurring jar) or needed by (a Goal), as the person gave the date:
 * "Due 1 Dec 2026", "Needed by Mar 2027". `month` names only the month ("Due Dec 2026"), for a
 * card too narrow for the day. Null without a deadline.
 */
export function jarDueLabel(jar: Pick<JarDto, 'deadline' | 'monthOnly' | 'recurMonths'>, opts: { month?: boolean } = {}): string | null {
  if (!jar.deadline) return null
  const when = opts.month ? monthYear(jar.deadline) : jarDate(jar.deadline, jar.monthOnly)
  return jar.recurMonths === null ? `Needed by ${when}` : `Due ${when}`
}

/** A Recurring jar's cadence in the Repeats field's words: "yearly", "monthly", "every 6 months". */
export function cadenceLabel(recurMonths: number): string {
  const option = RECUR_MONTHS_OPTIONS.find((o) => o.value === recurMonths)
  return option ? option.label.toLowerCase() : `every ${recurMonths} months`
}

/**
 * How a Recurring jar's last cycle ended (W03), in a few words: "Last cycle paid 28 Nov 2025
 * (€550.00)", "… funded on time", "… funded late", "… missed", "… waiting for its deadline"
 * (unpaid and not yet judged). Null when no cycle has closed yet, or for a Goal.
 */
export function jarLastCycleLabel(jar: JarDto, currency: string): string | null {
  const cycle = jar.lastCycle
  if (!cycle || jar.recurMonths === null) return null
  switch (cycle.outcome) {
    case 'Paid': {
      const paid = cycle.paidOn ? `Last cycle paid ${formatDate(cycle.paidOn)}` : 'Last cycle paid'
      const amount = cycle.paidAmount !== null ? ` (${formatMoney(fromAmount(cycle.paidAmount), currency)})` : ''
      return `${paid}${amount}${cycle.paidOn && !cycle.paidOnTime ? ', late' : ''}`
    }
    case 'Funded':
      return 'Last cycle funded on time'
    case 'Waiting':
      // Its payment was removed before the deadline: judged only when the deadline comes (D17).
      return 'Last cycle waiting for its deadline'
    case 'FundedLate':
      return 'Last cycle funded late'
    case 'Missed':
      return 'Last cycle missed'
    default:
      return `Last cycle due ${jarDate(cycle.deadline, jar.monthOnly)}`
  }
}
