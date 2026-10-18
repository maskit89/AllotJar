import { forwardRef, useId, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { Plus } from 'lucide-react'

/*
 * The Transactions list's small pieces (restyle PR 5, the approved "polished Warm" mock-up): the
 * row's tinted icon, the category chip in its budget colour and the dashed gold chip of something
 * to fill in ("+ Assign", "+ € amount"). Presentation only; the page owns what they do.
 */

/** The neutral colour of a row whose line is unknown (unassigned, or a line of an unloaded month). */
export const NEUTRAL = 'var(--color-slate-500)'

/** A row's 30px leading tile: a glyph for what the row is, on its colour's tint (as the Dashboard's lines). */
export function TxTile({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-[30px] shrink-0 place-items-center rounded-[9px] [&_svg]:size-4"
      style={{ background: `color-mix(in srgb, ${color} 13%, var(--color-card))`, color }}
    >
      {children}
    </span>
  )
}

/** A finger-sized hit area around a 24px chip (the mock-ups' `::after` inset), so it can be tapped. */
const HIT = "relative after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']"

/** The dashed gold chip of something to fill in (the mock-ups' `.chip.dash`). */
export const FILL_CHIP = `${HIT} inline-flex h-6 shrink-0 items-center gap-1 rounded-full border-[1.5px] border-dashed border-[color-mix(in_srgb,var(--gold-line)_80%,transparent)] px-[9px] text-xs font-semibold whitespace-nowrap text-[var(--gold-ink)] transition hover:bg-[color-mix(in_srgb,var(--color-gold)_10%,transparent)] [&_svg]:size-[13px] [&_svg]:shrink-0`

/** The category chip: a tinted pill with the line's colour dot (the mock-ups' `.cchip`). */
const CAT_CHIP =
  'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[13px] font-semibold whitespace-nowrap'

function catChipStyle(color: string): CSSProperties {
  return {
    background: `color-mix(in srgb, ${color} 12%, var(--color-card))`,
    color: `color-mix(in srgb, ${color} 55%, var(--color-foreground))`,
  }
}

/** The line's colour dot, or a glyph in its place (a jar's line). */
function Lead({ color, icon }: { color: string; icon?: ReactNode }) {
  return icon ? (
    <span aria-hidden className="grid shrink-0 [&_svg]:size-3.5">
      {icon}
    </span>
  ) : (
    <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: color }} />
  )
}

/** A jar's line: an outline chip with the jar glyph (the mock-ups' `.chip.line`), as a payment from a jar. */
const LINE_CHIP =
  'inline-flex h-[22px] max-w-full min-w-0 items-center gap-1 rounded-full px-[9px] text-xs font-semibold whitespace-nowrap text-slate-500 shadow-[inset_0_0_0_1px_var(--color-border)]'

/** A category chip that is not a button (a read-only login's row). `line`: a jar's line. */
export function CategoryChip({ color, icon, line = false, children }: { color: string; icon?: ReactNode; line?: boolean; children: ReactNode }) {
  return (
    <span className={line ? LINE_CHIP : CAT_CHIP} style={line ? undefined : catChipStyle(color)}>
      <Lead color={color} icon={icon} />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * The row's assign control, one button whichever way it looks, so focus stays on it when a save
 * turns "+ Assign" into the category chip: `color` set, the category chip (Reassign); unset, the
 * dashed gold "+ Assign". The page names it ("Reassign Lidl"); the category it shows is its
 * accessible description, so a screen reader still hears the row's category. A disabled chip fades
 * to 60%; `fade={false}` (opt-in, the Import review's unticked row, restyle PR 14) keeps its colour,
 * so a line already drawn in the muted colour stays readable.
 */
export const AssignChip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { color?: string; icon?: ReactNode; line?: boolean; label: ReactNode; fade?: boolean }
>(function AssignChip({ color, icon, line = false, label, className = '', fade = true, ...rest }, ref) {
  const labelId = useId()
  return (
    <button
      ref={ref}
      type="button"
      data-assign-chip=""
      aria-describedby={color ? labelId : undefined}
      className={`${HIT} ${
        color
          ? line
            ? `${LINE_CHIP} transition hover:text-slate-900`
            : `${CAT_CHIP} transition hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_30%,transparent)]`
          : FILL_CHIP
      } ${fade ? 'disabled:opacity-60' : ''} ${className}`}
      style={color && !line ? catChipStyle(color) : undefined}
      {...rest}
    >
      {color ? (
        <>
          <Lead color={color} icon={icon} />
          <span id={labelId} className="truncate">
            {label}
          </span>
        </>
      ) : (
        <>
          <Plus aria-hidden strokeWidth={2} />
          {label}
        </>
      )}
    </button>
  )
})
