import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

/*
 * shadcn/ui building blocks (new-york style, Tailwind v4), adapted to AllotJar:
 * - colours come only from the semantic tokens in index.css (bg-primary, border-border...), so
 *   dark mode follows the `.dark` class with no per-component work;
 * - no focus-visible ring: the app's global :focus-visible outline (index.css) already marks
 *   keyboard focus everywhere, and a second indicator would double it;
 * - a plain <Button> is type="button", like the older ui/index.tsx Button, so it never submits a
 *   form by accident; forms pass type="submit".
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive-text [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline:
          'border border-border bg-card text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        // Primary green is too dark to read as text on the dark card, so dark links use the
        // brightened brand step (#5fc093, 8:1 on the card).
        link: 'text-primary underline-offset-4 hover:underline dark:text-brand-500',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      type={asChild ? type : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
