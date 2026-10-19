import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { InfoHint } from './InfoHint'

/**
 * The app's one banner (restyle PR 17): a single short line on one of the status tones, with at
 * most an (i) holding the detail, one quiet action and a dismiss ✕. Replaces the per-banner amber /
 * violet / brand strips of the staging, verify-email, sharing-review, household-greeting, access and
 * analytics-consent banners.
 *
 * Two shapes:
 * - `row` (the default): a card row inside the app column, as the restyled pages' cards (off-white,
 *   hairline, 12px radius, 44px tall), with the tone on a small tinted icon tile at the start.
 * - `strip`: a full-width tinted band (the staging banner), sticky at the top of the screen.
 *
 * The tone is exposed as `data-tone` (tests and state scripts read it). Hook-free, so the strip can
 * be prerendered with the landing page (the (i) is the only child with hooks, and only when given).
 */
export type NoticeTone = 'info' | 'warn' | 'bad' | 'ok'

const ICONS: Record<NoticeTone, typeof Info> = { info: Info, warn: TriangleAlert, bad: CircleAlert, ok: CircleCheck }

/** The tone's colour as `--tone` (the hairline, the action's hover and the tile mix from it). */
const TONE: Record<NoticeTone, string> = {
  info: '[--tone:var(--color-brand-600)] [--tone-bg:var(--color-brand-50)] dark:[--tone:var(--color-brand-500)]',
  warn: '[--tone:var(--color-warn)] [--tone-bg:var(--color-warn-bg)]',
  bad: '[--tone:var(--color-bad)] [--tone-bg:var(--color-bad-bg)]',
  ok: '[--tone:var(--color-ok)] [--tone-bg:var(--color-ok-bg)]',
}

export function Notice({
  tone = 'info',
  variant = 'row',
  icon = true,
  hint,
  hintLabel = 'More about this',
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  className = '',
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  tone?: NoticeTone
  /** A card row in the app column (default), or the full-width sticky strip. */
  variant?: 'row' | 'strip'
  /** The tone's icon before the line; `false` for none. */
  icon?: boolean
  /** The line's detail, behind an (i) after it. */
  hint?: ReactNode
  /** The (i)'s accessible name. */
  hintLabel?: string
  /** One quiet action at the end of the row (a `NoticeAction`, or a link styled as one). */
  action?: ReactNode
  /** Given, a ✕ at the end of the row dismisses the banner. */
  onDismiss?: () => void
  dismissLabel?: string
  /** The one line. */
  children: ReactNode
}) {
  const Icon = ICONS[tone]
  if (variant === 'strip') {
    return (
      <div
        data-tone={tone}
        className={`sticky top-0 z-40 flex min-h-10 items-center justify-center gap-2 bg-[var(--tone-bg)] px-4 py-1.5 text-center text-[13px] leading-snug font-semibold text-[var(--tone)] shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--tone)_18%,transparent)] ${TONE[tone]} ${className}`}
        {...rest}
      >
        {icon && <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2} />}
        <span>{children}</span>
      </div>
    )
  }
  return (
    <div
      data-tone={tone}
      className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl bg-card py-1.5 pr-1.5 pl-2 text-sm font-semibold text-slate-900 shadow-[var(--shadow-frame),inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)] ${TONE[tone]} ${className}`}
      {...rest}
    >
      {icon && (
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--tone-bg)] text-[var(--tone)] [&_svg]:size-4"
        >
          <Icon strokeWidth={2} />
        </span>
      )}
      <span className={`flex min-w-0 flex-1 items-center gap-1 py-1 ${icon ? '' : 'pl-2'}`}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        {hint && (
          <InfoHint
            label={hintLabel}
            align="center"
            buttonClassName="relative -my-1 inline-grid size-[22px] shrink-0 place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
          >
            {hint}
          </InfoHint>
        )}
      </span>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 dark:hover:bg-foreground/7"
        >
          <X aria-hidden className="size-4" strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}

/**
 * A banner's quiet action: brand-green text, 32px tall with a 44px target, a soft tint on hover.
 * Never a second primary: the page under the banner keeps its one green button.
 */
export function NoticeAction({ className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[13px] font-bold whitespace-nowrap text-brand-700 transition after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50 dark:text-brand-200 dark:hover:bg-foreground/7 ${className}`}
      {...rest}
    />
  )
}
