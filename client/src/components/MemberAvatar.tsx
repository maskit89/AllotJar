import { hueColor, type CategoryHue } from '../lib/categoryColors'

/**
 * A person, the same way on every page (restyle PR 3): their initial on a tinted circle. The
 * Dashboard's income lines show it at 30px; `className` sets another size (and the type size). It
 * is decorative: whatever shows it says who in words for assistive tech.
 *
 * `color` (opt-in, the Account settings page, restyle PR 12) tints it with another colour than a
 * member hue, e.g. `var(--color-steel)` for a sign-in not linked to a person, as the People page
 * draws those. Left out, the hue's colour is used, as before.
 */
export function MemberAvatar({
  name,
  hue,
  color,
  className = 'size-[30px] text-xs',
}: {
  name: string
  hue: CategoryHue
  color?: string
  className?: string
}) {
  const c = color ?? hueColor(hue)
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
