import type { ReactNode } from 'react'

/*
 * The Account settings page's small pieces (restyle PR 12, the approved mock-ups account*.py).
 * Presentation only; the page owns what they do.
 */

/** A dialog's actions (the mock-ups' `.as-acts`): right-aligned, a full-width pair on a phone. */
export const DIALOG_ACTIONS = 'flex justify-end gap-2 pt-4 max-[699.98px]:gap-2.5 max-[699.98px]:pt-[18px]'

/**
 * A dialog's two buttons: 40px, 44px and half the width each on a phone. The main one is
 * aria-disabled while it works (it keeps the focus), and looks as a disabled one does.
 */
export const DIALOG_BUTTON =
  'h-10 rounded-[10px]! aria-disabled:pointer-events-none aria-disabled:opacity-50 max-[699.98px]:h-11 max-[699.98px]:flex-1'

/** A dialog's quiet Cancel. */
export const DIALOG_CANCEL = `${DIALOG_BUTTON} px-3.5! text-slate-500! dark:hover:bg-foreground/7`

/** A dialog's main action, the green of the page's one primary button. */
export const DIALOG_PRIMARY = `${DIALOG_BUTTON} min-w-[104px] px-[18px]! shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] dark:bg-primary dark:hover:bg-brand-600`

/**
 * A dialog's footer with a quiet action at its left (the jar dialogs, restyle PR 18: the other way
 * out, such as archiving from the skip dialog). On a phone the quiet action takes a line of its own
 * above the pair, so the pair never wraps.
 */
export const DIALOG_ACTIONS_SPLIT = 'flex items-center justify-end gap-2 pt-4 max-[699.98px]:flex-wrap max-[699.98px]:gap-2.5 max-[699.98px]:pt-[18px]'

/** The quiet text action at a split footer's left. */
export const DIALOG_QUIET =
  'mr-auto h-10 rounded-[10px]! px-2.5! text-slate-500! max-[699.98px]:-ml-2.5 max-[699.98px]:h-11 max-[699.98px]:flex-[1_1_100%] max-[699.98px]:justify-start dark:hover:bg-foreground/7'

/** A dialog's one action in the bad tone, tinted (not solid) to keep the sheet calm: Archive jar. */
export const DIALOG_BAD = `${DIALOG_BUTTON} inline-flex min-w-[104px] items-center justify-center px-[18px] text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-50 bg-bad-bg text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-bad)_28%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-bad)_10%,var(--color-bad-bg))]`

/** A dialog's one line of body under its title (the explanation sits behind the title's (i)). */
export const DIALOG_BODY = '-mt-1 text-sm leading-normal text-slate-500'

/** A dialog's field label (the Allocation dialogs' labels). */
export const DIALOG_FIELD_LABEL = 'flex min-h-[22px] items-center gap-1 text-[13px] font-semibold text-slate-500'

/** A dialog's compact panel in the field colour: a list of choices, or a preview (the Import dialogs' panels). */
export const DIALOG_PANEL = 'rounded-xl bg-[var(--dlg-field)] shadow-[inset_0_0_0_1px_var(--color-line)]'

/** The page's one primary button, Save (the mock-ups' `.btn`): 38px, full width and 44px on a phone. */
export const SAVE_BUTTON =
  'h-[38px] rounded-[10px]! px-4! shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] max-[699.98px]:h-11 max-[699.98px]:w-full dark:bg-primary dark:hover:bg-brand-600'

/** The rows' small outline action (the mock-ups' `.btn.outline.sm`): 32px, 40px for a finger on a phone. */
export const OUTLINE_SM =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-slate-200 bg-surface px-3 text-[13px] font-semibold whitespace-nowrap text-slate-900 shadow-[var(--shadow-frame)] transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-50 max-[699.98px]:h-10 max-[699.98px]:px-3.5 dark:hover:bg-foreground/7'

/** The (i) beside a row's title or a field's label: a 22px target, the icon at 15px, a 40px hit area. */
export const ROW_HINT =
  "relative -my-1 inline-grid size-[22px] shrink-0 place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"

/** A card's rows (the mock-ups' `.row`): 56px or taller, a hairline between them. */
export const ROW = 'flex min-h-14 min-w-0 items-center gap-3.5 py-3 not-first:border-t not-first:border-line max-[699.98px]:gap-3'

/** A row's title (14px, 600), and the line under it. */
export const ROW_TITLE = 'truncate text-sm font-semibold text-slate-900'

/** A row's 30px leading tile: a glyph on its colour's tint (the mock-ups' `cat_icon(..., 'bic sm')`). */
export function Tile({ color, tint = '13%', children }: { color: string; tint?: string; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-[30px] shrink-0 place-items-center rounded-[9px] [&_svg]:size-4"
      style={{ background: `color-mix(in srgb, ${color} ${tint}, var(--color-card))`, color }}
    >
      {children}
    </span>
  )
}

/** Google's four-colour mark (its brand colours, the same in both themes). Decorative. */
export function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.87 2.69-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
    </svg>
  )
}
