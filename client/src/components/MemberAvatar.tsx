import { hueColor, type CategoryHue } from '../lib/categoryColors'

/**
 * A person, the same way on every page (restyle PR 3): their initial on a tinted circle. The
 * Dashboard's income lines show it at 30px; `className` sets another size (and the type size). It
 * is decorative: whatever shows it says who in words for assistive tech.
 */
export function MemberAvatar({ name, hue, className = 'size-[30px] text-xs' }: { name: string; hue: CategoryHue; className?: string }) {
  const c = hueColor(hue)
  return (
    <span
      aria-hidden
      className={`grid place-items-center rounded-full font-[650] ${className}`}
      style={{
        background: `color-mix(in srgb, ${c} 16%, var(--color-card))`,
        color: `color-mix(in srgb, ${c} 62%, var(--color-foreground))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 28%, transparent)`,
      }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
