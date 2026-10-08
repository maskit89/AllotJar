import type { ComponentProps } from 'react'
import { Progress as ProgressPrimitive } from 'radix-ui'

import { cn } from '../../lib/utils'

// Radix treats a value outside 0..max as invalid (it logs an error and reads as indeterminate), so
// the value is clamped once and the same number drives both the announced value and the fill. Like
// Radix, a missing or non-positive `max` means 100.
function clampProgress(value: number | null | undefined, max: number | undefined) {
  const total = max !== undefined && max > 0 ? max : 100
  if (value == null || Number.isNaN(value)) return { total, value: null, percent: 0 }
  const clamped = Math.min(Math.max(value, 0), total)
  return { total, value: clamped, percent: (clamped / total) * 100 }
}

/*
 * Unlike upstream, `value` and `max` are passed on to the Radix root, so the bar is announced as a
 * progressbar with aria-valuenow / aria-valuemax (upstream keeps `value` back and the bar reads as
 * indeterminate), and the fill honours `max` instead of assuming 100. An overspent value reads as
 * full; a caller that needs to say so passes getValueLabel. In dark mode the fill uses the
 * brightened brand green (primary is under 3:1 against its track there), and in Windows
 * high-contrast mode the track gets an outline and the fill a system colour so the bar stays visible.
 */
function Progress({ className, value, max, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const progress = clampProgress(value, max)
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={progress.value}
      max={progress.total}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-primary/20 forced-colors:border forced-colors:border-border',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all dark:bg-brand-500 forced-colors:bg-[Highlight]"
        style={{ transform: `translateX(-${100 - progress.percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
