import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

// Focus is marked like Input's: the global :focus-visible outline plus the ring-coloured border.
function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive-text md:text-sm dark:bg-input/30',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
