import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { JarDto } from '../../types'
import { formatMoney, fromAmount } from '../../lib/money'
import { jarStatusChip } from '../../lib/jarStatus'
import { hueForIndex } from '../../lib/categoryColors'
import type { BadgeTone } from '../ui'
import { GlassJar } from '../GlassJar'
import { StatusChip, type ChipTone } from '../StatusChip'
import { CARD_TITLE, DASH_CARD } from './card'

/** The jar chip words come from lib/jarStatus (shared with the Jars page); the tones map here. */
const CHIP_TONE: Record<BadgeTone, ChipTone> = {
  rose: 'bad',
  amber: 'warn',
  teal: 'ok',
  brand: 'ok',
  neutral: 'neutral',
  violet: 'neutral',
}

/** Attention first: the states that need something done, then the quiet ones, then the endings. */
const ORDER: Record<string, number> = {
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

/** The narrowest a jar's cell gets before the shelf holds fewer jars per row. */
const CELL = 110
const GAP = 8
/**
 * Three jars to a shelf down to this width (cells of about 95px, which fit "Home insurance" and a
 * "Deadline missed" chip on a 375px phone); narrower (a 320-360px phone), two.
 */
const MIN_THREE = 300

/** The shelf's width, kept current (0 where nothing is laid out, e.g. in tests). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/**
 * The Jars card (restyle PR 3): the household's jars as glass jars standing on gold-edged
 * shelves, the ones that need attention first, each with its balance and either its state (the
 * Jars page's words; a healthy jar gets none) or this month's plan. The header says what the
 * jars hold in all, and for a past or future month which day the balances are as of (rule 48);
 * "Manage" goes to the Jars page. A failed read says so instead of passing for "no jars".
 */
export function JarsCard({
  jars,
  failed,
  currency,
  asOf,
  className = '',
}: {
  jars: JarDto[]
  failed: boolean
  currency: string
  /** "as of 31 Jan 2026" (a past month), "balances as of today" (a future one), else null. */
  asOf: string | null
  className?: string
}) {
  const [shelfRef, width] = useWidth()
  // Only jars whose balance is known count; an unavailable one reads as such (rule 67).
  const savedMinor = jars.reduce((s, j) => s + (j.currentBalance === null ? 0 : fromAmount(j.currentBalance)), 0)
  // Each jar keeps the colour of its place in the household's list (as on the Jars page).
  const ordered = jars
    .map((jar, index) => ({ jar, hue: hueForIndex(index), index }))
    .sort((a, b) => (ORDER[a.jar.status] ?? 6) - (ORDER[b.jar.status] ?? 6) || a.index - b.index)
  const fit = Math.floor((width + GAP) / (CELL + GAP))
  // Nothing laid out yet (or in tests): three to a shelf.
  const perRow = width === 0 ? 3 : Math.min(6, Math.max(fit, width >= MIN_THREE ? 3 : 2))
  const shelves: (typeof ordered)[] = []
  for (let i = 0; i < ordered.length; i += perRow) shelves.push(ordered.slice(i, i + perRow))
  const cell = `calc((100% - ${(perRow - 1) * GAP}px) / ${perRow})`

  return (
    <section aria-labelledby="jars-heading" className={`${DASH_CARD} ${className}`}>
      <div className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
          <h2 id="jars-heading" className={CARD_TITLE}>
            Jars
          </h2>
          {!failed && <span className="text-[13px] text-slate-500 tabular-nums">{formatMoney(savedMinor, currency)} saved</span>}
        </div>
        {/* Named by its text alone: "Manage jars" would also match the sidebar's "Jars" link
            for a name-substring lookup (the journeys' getByRole('link', { name: 'Jars' })). The
            card title describes it instead. */}
        <Link
          to="/jars"
          aria-describedby="jars-heading"
          className="relative -mr-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-sm font-semibold text-brand-700 transition after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"
        >
          Manage
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      </div>
      {asOf && !failed && <p className="-mt-2 mb-3.5 text-xs text-slate-500">{asOf}</p>}

      {failed ? (
        <p role="status" className="text-sm text-slate-500">
          Could not load your jars for this month. Change month or reload to try again.
        </p>
      ) : (
        <div ref={shelfRef} className="flex flex-col gap-[26px] pt-1">
          {shelves.map((row, r) => (
            <div
              key={r}
              className="jar-shelf grid justify-center gap-1 min-[700px]:gap-2"
              style={{ gridTemplateColumns: `repeat(${row.length}, ${cell})` }}
            >
              {row.map(({ jar, hue }) => {
                const balance = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
                const target = fromAmount(jar.targetAmount)
                const pct = target > 0 && balance !== null ? (balance / target) * 100 : 0
                const monthly = fromAmount(jar.plannedThisMonth)
                // An unknown balance already reads "Not available" (rule 67): no "Unavailable"
                // chip under it saying the same again.
                const chip = balance === null && jar.status === 'Unavailable' ? null : jarStatusChip(jar.status)
                return (
                  <div key={jar.id} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
                    <GlassJar
                      pct={pct}
                      hue={hue}
                      label={`${jar.name}: ${Math.round(Math.max(0, Math.min(100, pct)))}% of goal`}
                      className="mb-4"
                    />
                    <span className="max-w-full truncate text-[13px] leading-[1.3] font-semibold text-slate-900">{jar.name}</span>
                    {balance === null ? (
                      <span className="text-[13px] font-semibold text-slate-500">Not available</span>
                    ) : (
                      <span
                        className={`text-base font-bold tracking-[-0.01em] tabular-nums ${balance < 0 ? 'text-bad' : 'text-slate-900'}`}
                      >
                        {formatMoney(balance, currency)}
                      </span>
                    )}
                    {/* One status-aware line: a chip for a state worth calling out, else this
                        month's plan, so the shelf never contradicts the Jars page. */}
                    {chip ? (
                      <StatusChip tone={CHIP_TONE[chip.tone]} className="mt-1">
                        {chip.label}
                      </StatusChip>
                    ) : (
                      monthly > 0 && (
                        <span className="mt-1 inline-flex h-[22px] items-center text-xs font-semibold text-slate-500 tabular-nums">
                          +{formatMoney(monthly, currency)}/mo
                        </span>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
