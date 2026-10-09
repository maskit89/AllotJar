import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

/*
 * Keyboard focus: the app's global :focus-visible outline (index.css) marks the field, and the
 * border turns to the ring colour as upstream does. shadcn's focus ring and `outline-none` are left
 * out, since the unlayered outline would beat them and the ring would double it.
 */
function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring',
        'aria-invalid:border-destructive-text',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
