import type { ComponentProps } from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '../../lib/utils'

/*
 * Adapted to AllotJar (see button.tsx for the shared rules): no focus ring or outline classes on
 * the triggers or the panel. The app's global :focus-visible outline marks a focused tab, and the
 * panel (focusable, as Radix makes it) when Tab moves into it; upstream's `outline-none` on the
 * panel would lose to that unlayered rule anyway. The active tab is filled with the brand green,
 * like the app's SegmentedControl, because upstream's white pill on the muted list is only about
 * 1.1:1 and hard to see.
 */
function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,box-shadow] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
