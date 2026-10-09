import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach the merger the app's own shadow sizes (the --shadow-* tokens in index.css @theme), so a
// caller's `shadow-card` replaces a building block's default `shadow-sm` instead of stacking on it.
const twMerge = extendTailwindMerge({ extend: { theme: { shadow: ['card', 'hero'] } } })

/**
 * Joins class names and lets a later Tailwind class win over an earlier one of the same kind
 * (`cn('px-2', 'px-4')` gives `px-4`), so a caller's `className` can override a building block's
 * defaults. Used by the shadcn/ui building blocks in components/ui.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
