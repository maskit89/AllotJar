import { useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { InfoHint } from '../InfoHint'
import { CARD_TITLE, TITLE_HINT } from '../budget/card'
import { EYEBROW } from '../budget/BudgetGroup'

/*
 * The Reports page's small pieces (restyle PR 7, the approved "polished Warm" mock-up): month
 * names, the card header (a short h2 and its (i)), the year switcher, the quiet month select and
 * the tables' look. Presentation only; the page owns the data.
 */

/** The card header: the title and its (i) at the left, the card's controls at the right. */
export function CardHead({
  id,
  title,
  hintLabel,
  hint,
  hintAlign = 'start',
  children,
  className = '',
}: {
  id: string
  title: string
  hintLabel?: string
  hint?: ReactNode
  hintAlign?: 'start' | 'center' | 'end'
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`mb-3.5 flex min-h-8 items-center justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 id={id} className={CARD_TITLE}>
          {title}
        </h2>
        {hint && (
          <InfoHint label={hintLabel ?? `About ${title.toLowerCase()}`} buttonClassName={TITLE_HINT} align={hintAlign}>
            {hint}
          </InfoHint>
        )}
      </div>
      {children}
    </div>
  )
}

/** The year switcher in the Trend card's header (‹ 2026 ›): an inset pill, as the quiet segmented control. */
export function YearSwitcher({ year, onPrev, onNext }: { year: number; onPrev: () => void; onNext: () => void }) {
  // 32px arrows (40×38 on a phone, in a 44px pill), each with a touch target that fills the pill's height.
  const arrow = `relative grid size-8 place-items-center rounded-lg text-slate-500 transition after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-[''] hover:bg-surface hover:text-slate-900 dark:hover:bg-popover max-[699.98px]:h-[38px] max-[699.98px]:w-10`
  return (
    <div
      role="group"
      aria-label="Year"
      className="flex h-[38px] shrink-0 items-center gap-0.5 rounded-[11px] bg-surface-2 px-[3px] shadow-[inset_0_0_0_1px_var(--color-line)] max-[699.98px]:h-11"
    >
      <button type="button" aria-label="Previous year" onClick={onPrev} className={arrow}>
        <ChevronLeft aria-hidden strokeWidth={1.8} className="size-4" />
      </button>
      {/* One text node, the year shown: the tests and assistive tech read it as it is. Polite, so
          the year an arrow moved to (and every card it drives) is said once it has loaded. */}
      <span aria-live="polite" className="min-w-11 text-center text-sm font-semibold text-slate-900 tabular-nums">
        {year}
      </span>
      <button type="button" aria-label="Next year" onClick={onNext} className={arrow}>
        <ChevronRight aria-hidden strokeWidth={1.8} className="size-4" />
      </button>
    </div>
  )
}

/**
 * A quiet native select (the Spending card's month): the year switcher's inset pill with a
 * chevron. Native, so the platform picker, arrow keys and `selectOptions` in tests all keep working.
 */
export function QuietSelect({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <select
        {...rest}
        className="h-[38px] appearance-none rounded-[11px] bg-surface-2 pr-8 pl-3 text-sm font-semibold text-slate-900 shadow-[inset_0_0_0_1px_var(--color-line)] transition hover:shadow-[inset_0_0_0_1px_var(--color-border)] max-[699.98px]:h-11 [&>option]:bg-popover [&>option]:text-popover-foreground"
      >
        {children}
      </select>
      <ChevronDown aria-hidden strokeWidth={1.8} className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-slate-500" />
    </span>
  )
}

/**
 * A wide table's box: it scrolls sideways inside the card when the table is wider (a phone, or the
 * jars' twelve months), and takes focus so a keyboard can scroll it too. Named by the table it
 * holds. While more of the table lies past an edge, that edge fades out (`fadeStart`/`fadeEnd`),
 * so no figure looks cut short; a table with a pinned column (PIN_START, PIN_END) fades at the
 * pinned column's inner edge instead (`data-more-start`/`data-more-end` on the box).
 */
export function TableBox({
  label,
  children,
  fadeStart = true,
  fadeEnd = true,
  className = '',
}: {
  label: string
  children: ReactNode
  fadeStart?: boolean
  fadeEnd?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ start: false, end: false })
  useEffect(() => {
    const box = ref.current
    if (!box) return
    const update = () => {
      const start = box.scrollLeft > 1
      const end = box.scrollWidth - box.clientWidth - box.scrollLeft > 1
      setMore((m) => (m.start === start && m.end === end ? m : { start, end }))
    }
    update()
    box.addEventListener('scroll', update, { passive: true })
    // The box's width (and the table's) changes when its side of a switch is shown, with the
    // window, and with the year's figures.
    const observer = new ResizeObserver(update)
    observer.observe(box)
    if (box.firstElementChild) observer.observe(box.firstElementChild)
    return () => {
      box.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])
  const fade = 'pointer-events-none absolute inset-y-0 z-[2] w-6 from-surface to-transparent'
  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        role="region"
        aria-label={label}
        tabIndex={0}
        data-more-start={more.start || undefined}
        data-more-end={more.end || undefined}
        className="group/box overflow-x-auto"
      >
        {children}
      </div>
      {fadeStart && more.start && <div aria-hidden className={`${fade} left-0 bg-linear-to-r`} />}
      {fadeEnd && more.end && <div aria-hidden className={`${fade} right-0 bg-linear-to-l`} />}
    </div>
  )
}

/** The tables' cells (the mock-ups' `.rp-tbl`): right-aligned figures, the first column at the left. */
export const CELL = 'py-3 pl-2.5 text-right whitespace-nowrap first:pl-0 first:text-left'
/** A head cell: the eyebrow, over a hairline. */
export const HEAD = `${CELL} ${EYEBROW} border-b border-line pt-0 pb-2 align-bottom`
/** A body row's cells, over a hairline. */
export const BODY_ROW = '[&>*]:border-b [&>*]:border-line'
/** The total row. */
export const FOOT = `${CELL} pt-3 pb-0 font-bold text-slate-900`
/** A table's size: a step under the page's rows, so a year of figures fits beside the Spending card. */
export const TABLE = 'w-full border-collapse text-[13px] tabular-nums'
/**
 * A cell of a column pinned at the box's left (the row names): the figures scroll under it, and it
 * fades into them while more of the table lies to the left.
 */
export const PIN_START = `sticky left-0 z-[1] bg-surface pr-2.5 after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-5 after:bg-linear-to-r after:from-surface after:to-transparent after:opacity-0 after:content-[''] group-data-[more-start]/box:after:opacity-100`
/** A cell of a column pinned at the box's right (the totals), fading into the figures before it. */
export const PIN_END = `sticky right-0 z-[1] bg-surface before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-5 before:bg-linear-to-l before:from-surface before:to-transparent before:opacity-0 before:content-[''] group-data-[more-end]/box:before:opacity-100`
