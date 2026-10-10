import type { HTMLAttributes } from 'react'
import { hueColor, type CategoryHue } from '../lib/categoryColors'

/**
 * The status tones of the restyle (PR 3): ok (paid, received, funded), warn (due soon, behind;
 * orange, never gold), bad (overdue, overspent, a missed deadline), line (a plain fact in an
 * outline, e.g. a due date) and neutral (a quiet state such as Skipped).
 */
export type ChipTone = 'ok' | 'warn' | 'bad' | 'line' | 'neutral'

const TONES: Record<ChipTone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  line: 'text-slate-500 shadow-[inset_0_0_0_1px_var(--color-border)]',
  neutral: 'bg-surface-2 text-slate-500 dark:bg-foreground/7',
}

/** A 22px status chip. The tone is also exposed as `data-tone` (tests and state scripts read it). */
export function StatusChip({ tone, className = '', ...rest }: HTMLAttributes<HTMLSpanElement> & { tone: ChipTone }) {
  return (
    <span
      data-tone={tone}
      className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-[9px] text-xs font-semibold whitespace-nowrap tabular-nums [&_svg]:size-3 [&_svg]:shrink-0 ${TONES[tone]} ${className}`}
      {...rest}
    />
  )
}

/**
 * A 6px progress bar on the track colour. `pct` is clamped to 0-100. The fill is the hue, or the
 * bad red when `over`. Decorative: the row says the same in words.
 */
export function MiniBar({ pct, hue, over = false, className = '' }: { pct: number; hue: CategoryHue; over?: boolean; className?: string }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <div aria-hidden className={`h-1.5 min-w-10 overflow-hidden rounded-full bg-track ${className}`}>
      <span
        className={`block h-full rounded-full ${over ? 'bg-bad' : ''}`}
        style={{ width: `${p}%`, ...(over ? {} : { background: hueColor(hue) }) }}
      />
    </div>
  )
}
