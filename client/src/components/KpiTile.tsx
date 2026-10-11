import { useId, type HTMLAttributes, type ReactNode } from 'react'
import { InfoHint } from './InfoHint'
import { hueColor, type CategoryHue } from '../lib/categoryColors'

/*
 * The KPI row (restyle PR 3): one green hero tile with the screen's gold number, then up to two
 * plain tiles. It lays itself out by its own width (a container query), so it reads the same in
 * the phone frame, beside the desktop sidebar and on a wide screen:
 *  - from 640px: one row, the hero half again as wide as each tile; a plain tile's icon shows
 *    from 720px (a third of a narrower row has no room for it beside a five-figure number), and
 *    its number steps up to 30px from 850px;
 *  - narrower: the hero across the top, the two tiles side by side under it (or, when there is
 *    only one, a slim full-width strip: the label and its sub-line, the number at the right).
 * A row that sits on a grid of cards (`onGrid`, the Jars page; `thirds`, the Accounts page) takes
 * that grid's columns instead.
 */

/**
 * The row: pass the hero first, then the tiles. `tiles` is how many plain tiles follow it.
 * `onGrid`: the row sits on a grid of equal columns below it (the Jars page's jars, with the same
 * 24px gap): two columns from 640px and three from 900px, the hero over two of them there.
 * `thirds`: the hero and two tiles on a grid of three equal columns (the Accounts page's cards)
 * from 900px; from 640px one row as the default (the hero half again as wide as each tile). With
 * no tiles (`tiles={0}`) the hero takes the whole row, so nothing sits beside an empty slot.
 */
export function KpiRow({
  tiles,
  onGrid = false,
  thirds = false,
  children,
  className = '',
}: {
  tiles: 0 | 1 | 2
  onGrid?: boolean
  thirds?: boolean
  children: ReactNode
  className?: string
}) {
  const cols = thirds
    ? tiles === 0
      ? '@min-[640px]:[&>:first-child]:col-span-2'
      : '@min-[640px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] @min-[900px]:grid-cols-3'
    : onGrid
    ? '@min-[640px]:grid-cols-2 @min-[900px]:grid-cols-3 @min-[900px]:[&>:first-child]:col-span-2'
    : tiles === 2
      ? '@min-[640px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]'
      : tiles === 1
        ? '@min-[640px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]'
        : ''
  return (
    <div className={`@container ${className}`}>
      <div className={`grid grid-cols-2 gap-3 @min-[640px]:gap-6 ${cols}`}>{children}</div>
    </div>
  )
}

export interface KpiTileProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: string
  /** The (i) hint after the label: what the number means. */
  hint?: ReactNode
  /** The hint's accessible name (defaults to "About {label}"). */
  hintLabel?: string
  /** A plain tile's icon, drawn in a tinted square in its top-right corner (wide rows only). */
  icon?: ReactNode
  hue?: CategoryHue
  /**
   * The icon's colour when it is not one of the category hues (a CSS colour, e.g. the Transactions
   * page's clay `var(--color-clay)` for Spent); overrides `hue`.
   */
  iconColor?: string
  value: ReactNode
  /** The number's accessible name, when the glyphs alone are not a good one. */
  valueLabel?: string
  /** A plain tile's number in the bad red (e.g. a total below zero); the default ink otherwise. */
  valueTone?: 'bad'
  /** One short line under the number (or the bar). */
  sub?: ReactNode
  /** Sub in the ok tone (e.g. "All received"). */
  subTone?: 'muted' | 'ok'
  /** Something between the number and the sub: the hero's bar, a status chip. */
  extra?: ReactNode
  /** The green hero tile with the gold number (one per row, first). */
  hero?: boolean
  /**
   * A plain tile alone beside the hero: a slim strip across the narrow row. 'bar': the strip keeps
   * its sub-line and its bar (`extra`): the label at the left, the number and the sub-line at the
   * right, the bar across the strip under them.
   */
  strip?: boolean | 'bar'
}

/** One tile of the KPI row. */
export function KpiTile({
  label,
  hint,
  hintLabel,
  icon,
  hue = 'emerald',
  iconColor,
  value,
  valueLabel,
  valueTone,
  sub,
  subTone = 'muted',
  extra,
  hero = false,
  strip = false,
  className = '',
  ...rest
}: KpiTileProps) {
  const labelId = useId()
  const shape =
    'relative flex min-w-0 flex-col gap-1.5 rounded-[14px] p-4 @min-[640px]:min-h-[150px] @min-[640px]:gap-2 @min-[640px]:rounded-2xl @min-[640px]:px-6 @min-[640px]:py-[22px]'
  const hintEl = hint && (
    <InfoHint
      label={hintLabel ?? `About ${label.toLowerCase()}`}
      buttonClassName={`relative -my-1 inline-grid size-[22px] place-items-center rounded-full opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:opacity-100 focus-visible:opacity-100 ${
        hero ? 'text-[#d5ebdf] hover:bg-white/10' : 'text-slate-500 hover:bg-slate-500/10'
      }`}
    >
      {hint}
    </InfoHint>
  )

  if (hero) {
    return (
      <section
        className={`kpi-hero col-span-2 has-[[role=tooltip]]:z-10 @min-[640px]:col-span-1 ${shape} ${className}`}
        {...rest}
      >
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-[#d5ebdf] @min-[640px]:text-sm">
          {label}
          {hintEl}
        </p>
        <p
          className="gold-number w-fit text-[30px] leading-[1.1] font-bold tracking-[-0.025em] @min-[640px]:text-[38px]"
          aria-label={valueLabel}
        >
          {value}
        </p>
        {extra}
        {sub && <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[#d5ebdf]">{sub}</div>}
      </section>
    )
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={`${shape} border border-slate-200/70 bg-surface shadow-card has-[[role=tooltip]]:z-10 ${
        strip === 'bar'
          ? // Narrow: one line (the label, then the number and its sub-line at the right) over the bar.
            'col-span-2 flex-row! flex-wrap items-baseline gap-x-1.5! gap-y-2.5! px-4 py-3 @min-[640px]:col-span-1 @min-[640px]:flex-col! @min-[640px]:flex-nowrap @min-[640px]:items-stretch @min-[640px]:gap-2! @min-[640px]:px-6 @min-[640px]:py-[22px]'
          : strip
            ? // Narrow: a two-column strip (the label over its sub-line, the number at the right).
              'col-span-2 grid! grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3! gap-y-0.5! px-4 py-3 @min-[640px]:col-span-1 @min-[640px]:flex! @min-[640px]:items-stretch @min-[640px]:gap-2! @min-[640px]:px-6 @min-[640px]:py-[22px]'
            : ''
      } ${className}`}
      {...rest}
    >
      {/* The label and the number keep clear of the icon wherever it shows. */}
      <p
        id={labelId}
        className={`flex items-center gap-1.5 text-[13px] font-medium text-slate-500 @min-[640px]:text-sm ${icon ? '@min-[720px]:pr-10' : ''} ${
          // The strip's label keeps to one line; a sub-line with no room beside the number wraps
          // under it, at the right.
          strip === 'bar' ? '@max-[640px]:flex-1 @max-[640px]:whitespace-nowrap' : ''
        }`}
      >
        {label}
        {hintEl}
      </p>
      {icon && (
        <span
          aria-hidden
          className="absolute top-[18px] right-[18px] hidden size-9 place-items-center rounded-[10px] @min-[720px]:grid [&_svg]:size-[18px]"
          style={{
            background: `color-mix(in srgb, ${iconColor ?? hueColor(hue)} 13%, var(--color-card))`,
            color: iconColor ?? hueColor(hue),
          }}
        >
          {icon}
        </span>
      )}
      <p
        className={`leading-[1.1] font-bold tracking-[-0.025em] tabular-nums ${valueTone === 'bad' ? 'text-bad' : 'text-slate-900'} ${icon ? '@min-[720px]:pr-10' : ''} ${
          // A strip has half the row. A third of the row is narrow until about 850px (a 1,000px
          // window beside the sidebar): the number stays a size down there, so five figures fit.
          strip === 'bar'
            ? 'text-lg @min-[640px]:text-[30px]'
            : strip
              ? 'row-span-2 text-lg @min-[640px]:text-[30px]'
              : 'text-[22px] @min-[850px]:text-[30px]'
        }`}
        aria-label={valueLabel}
      >
        {value}
      </p>
      {/* The chip and the sub-line share one line (the chip first), as in the mock-up. A bar
          strip's bar takes a line of its own: under the number in a tile, across the foot of the
          narrow strip (its sub-line then sits beside the number). */}
      {(extra || sub) && (
        <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 ${strip === 'bar' ? '@max-[640px]:contents' : ''}`}>
          {strip === 'bar' && extra ? <div className="basis-full @max-[640px]:order-3 @min-[640px]:mt-1.5 @min-[640px]:mb-0.5">{extra}</div> : extra}
          {sub && (
            <span
              className={`inline-flex items-center gap-1.5 text-[13px] ${subTone === 'ok' ? 'text-ok' : 'text-slate-500'} ${
                strip === 'bar' ? '@max-[640px]:ml-auto @max-[640px]:text-xs' : ''
              }`}
            >
              {sub}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** The hero's progress bar: gold on a faint white track. `pct` is clamped to 0-100. */
export function HeroBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/16">
      <span className="block h-full rounded-full bg-[linear-gradient(90deg,#e5be5e,#f4db8e)]" style={{ width: `${p}%` }} />
    </div>
  )
}
