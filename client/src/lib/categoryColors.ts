// The redesign's five-hue category palette. The hue is carried by a *graphic*
// (a dot, a progress bar, a jar lid/body) — never by pill text, which stays
// `--ink` so the 4.5:1 body-text rule holds (the hue versions of amber/emerald/
// teal fail as text in light mode). Each hue resolves to a CSS variable defined
// in index.css (`--color-cat-*`), which flips for dark mode at the token level.

import { AccountType } from '../types'

export const CATEGORY_HUES = ['indigo', 'amber', 'teal', 'rose', 'emerald'] as const

export type CategoryHue = (typeof CATEGORY_HUES)[number]

/**
 * A stable hue for a category by its position among its siblings. The data has
 * no colour field, so we cycle the palette by index — deterministic per render
 * (the reference assigns hues the same way, cycling across groups).
 */
export function hueForIndex(index: number): CategoryHue {
  return CATEGORY_HUES[((index % CATEGORY_HUES.length) + CATEGORY_HUES.length) % CATEGORY_HUES.length]
}

/** The hue's solid colour, for dots / bars / jar lids (a graphic — needs 3:1). */
export function hueColor(hue: CategoryHue): string {
  return `var(--color-cat-${hue})`
}

/** The hue at 14% alpha, for pill / jar-body / bar-track tints. */
export function hueTint(hue: CategoryHue): string {
  // `color-mix` keeps the dark-mode flip automatic (the var already swapped).
  return `color-mix(in srgb, var(--color-cat-${hue}) 14%, transparent)`
}

/** Account types map to fixed hues (per the handoff: Savings→emerald, etc.). */
export function hueForAccountType(type: number): CategoryHue {
  switch (type) {
    case AccountType.Savings:
      return 'emerald'
    case AccountType.Cash:
      return 'amber'
    case AccountType.CreditCard: // no longer offered (rule 75); rows recorded before keep their hue
      return 'rose'
    case AccountType.Current:
      return 'indigo'
    default:
      return 'teal'
  }
}
