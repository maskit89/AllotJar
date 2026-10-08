import type { ComponentProps } from 'react'
import { Toggle as TogglePrimitive } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

/*
 * Adapted to AllotJar (see button.tsx for the shared rules): no focus ring and no `outline-none`
 * (the global :focus-visible outline marks the toggle), and no aria-invalid ring, only the
 * destructive border. A pressed toggle is filled with the brand green, like the app's
 * SegmentedControl and ThemeToggle, because upstream's accent tint is only about 1.1:1 from the
 * unpressed state.
 */
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive-text data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        sm: 'h-8 min-w-8 px-1.5',
        lg: 'h-10 min-w-10 px-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
