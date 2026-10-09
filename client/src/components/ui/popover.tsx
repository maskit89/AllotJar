import type { ComponentProps } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '../../lib/utils'

/*
 * Adapted to AllotJar (see button.tsx for the shared rules): the panel sits at z-[90], above the
 * app's own layers and above a dialog (z-[80]) it opens from, and upstream's `outline-hidden` is
 * left out: the app's unlayered :focus-visible outline wins over it anyway, and it rightly marks
 * the panel when keyboard focus lands on the panel itself (one with nothing focusable inside).
 * Radix gives the panel role="dialog" with no title part, so every caller names it with aria-label,
 * or aria-labelledby pointing at a heading inside it.
 */
function Popover({ ...props }: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[90] w-72 origin-(--radix-popover-content-transform-origin) rounded-md border border-border bg-popover dark:border-foreground/12 p-4 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ ...props }: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
