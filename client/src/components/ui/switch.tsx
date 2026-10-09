import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '../../lib/utils'

/*
 * No focus ring: the global :focus-visible outline marks the switch (see button.tsx). The off
 * track keeps the full input colour in dark mode too (upstream fades it to 80%, which drops the
 * track under 3:1 against the card). In Windows high-contrast mode, where backgrounds are
 * dropped, the checked track and the thumb take system colours so the state stays visible.
 */
function Switch({
  className,
  size = 'default',
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & { size?: 'sm' | 'default' }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input forced-colors:data-[state=checked]:bg-[Highlight]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-card ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground forced-colors:bg-[CanvasText]!"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
