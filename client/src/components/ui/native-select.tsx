import type { ComponentProps } from 'react'
import { ChevronDownIcon } from 'lucide-react'

import { cn } from '../../lib/utils'

/*
 * A styled native <select>: keeps the platform picker, form submission and `selectOptions` in
 * tests. Adapted from shadcn/ui's NativeSelect:
 * - `className` goes on the wrapper, so callers size and place the control (`w-full`, `mt-1`);
 *   the select fills the wrapper, which would otherwise stay `w-fit`;
 * - focus is marked by the global :focus-visible outline plus the ring-coloured border (no ring);
 * - the chevron is full-strength muted-foreground (upstream fades it to 50%, under 3:1);
 * - options and groups paint the popover colours, because the app sets no `color-scheme` and the
 *   select itself is transparent: without them a dark-mode popup shows light text on white.
 */
function NativeSelect({
  className,
  size = 'default',
  ...props
}: Omit<ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }) {
  return (
    <div
      data-slot="native-select-wrapper"
      data-size={size}
      className={cn('group/native-select relative w-fit has-[select:disabled]:opacity-50', className)}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 pr-9 text-base shadow-xs transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive-text data-[size=sm]:h-8 data-[size=sm]:py-1 md:text-sm dark:bg-input/30 dark:hover:bg-input/50"
        {...props}
      />
      <ChevronDownIcon
        data-slot="native-select-icon"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
      />
    </div>
  )
}

function NativeSelectOption({ className, ...props }: ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-popover text-popover-foreground', className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({ className, ...props }: ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-popover text-popover-foreground', className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
