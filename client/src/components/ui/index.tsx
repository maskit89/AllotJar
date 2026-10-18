import { Fragment, useId } from 'react'
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  ElementType,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'

/**
 * In-house UI primitives built on the existing Tailwind v4 `@theme` tokens —
 * no component library. Keep these small and composable; pages and feature
 * components style themselves by reaching for these plus utility classes.
 */

/**
 * A soft, modern surface: rounded, hairline border, gentle `shadow-card`.
 * Polymorphic via `as` so it can render a semantic element (e.g. `section`)
 * while keeping the same look.
 */
export function Card<T extends ElementType = 'div'>({
  as,
  className = '',
  ...rest
}: { as?: T; className?: string } & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className'>) {
  const Component = (as ?? 'div') as ElementType
  return (
    <Component
      className={`rounded-2xl border border-slate-200/70 bg-surface shadow-card ${className}`}
      {...rest}
    />
  )
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-slate-300 bg-surface text-slate-700 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
}

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
}

/**
 * A button with a handful of variants/sizes. Forwards every native button prop
 * (incl. `aria-label`, `type`, `onClick`, `disabled`), so it's a drop-in for the
 * app's existing hand-rolled buttons without changing their accessible names.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    />
  )
}

/**
 * A bordered form input — the counterpart to the borderless inline editors used
 * in the budget grid. No width baked in, so callers add `w-full` (forms) or a
 * fixed width (inline form fields). Forwards every native input prop.
 */
export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-lg border border-input bg-surface px-3 py-2 text-sm text-slate-800 transition placeholder:text-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50 ${className}`}
      {...rest}
    />
  )
}

/** A bordered select that matches `Input`. Forwards every native select prop. */
export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-lg border border-input bg-surface px-3 py-2 text-sm text-slate-700 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
}

/**
 * The Badge's tones, on the restyle's status tokens (restyle PR 20; the old amber, violet, rose and
 * teal tints are gone): ok (funded, paid), warn (behind, needs a plan; orange, never gold), bad
 * (overspent, a missed deadline), brand, and neutral.
 */
export type BadgeTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad'

const BADGE_TONES: Record<BadgeTone, string> = {
  // neutral rides the inverted slate ramp, so it needs no `dark:` variant.
  neutral: 'bg-slate-100 text-slate-600',
  brand: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200',
  // The status tokens flip in the .dark block themselves.
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
}

/** A small rounded pill for counts, tags and statuses. */
export function Badge({
  tone = 'neutral',
  className = '',
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]} ${className}`}
      {...rest}
    />
  )
}

/**
 * A page's opening row: an optional `<h1>` title, a muted subtitle and a right-hand actions slot.
 * Inside the app frame the top bar already shows the page title as the screen's `<h1>`, so pages
 * there pass only the subtitle and actions; `title` is for a page outside the frame.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={`flex flex-wrap justify-between gap-4 ${title ? 'items-end' : 'items-center'}`}>
      <div>
        {title && <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>}
        {subtitle && <p className={`text-sm text-slate-500 ${title ? 'mt-1' : ''}`}>{subtitle}</p>}
      </div>
      {actions}
    </div>
  )
}

/**
 * A segmented control — a row of mutually-exclusive options rendered as toggle
 * buttons (`aria-pressed`), not an ARIA tablist, so it stays accessible without
 * the full roving-tabindex tab pattern. The selected option is raised.
 *
 * `variant="quiet"` (the Transactions list's filter, restyle PR 5): the polished mock-ups' control,
 * as wide as its options, the selected one raised off-white instead of filled green. An option may
 * carry a `badge` (a count drawn after its label, hidden from assistive tech so the option keeps its
 * name) and a `description` (what the badge says, in words, as the button's description).
 *
 * `fill` (quiet only; the sign-in card's "Sign in | Create account" switch, restyle PR 9): the group
 * takes the full width as a pill, its options share it equally and stand 36px tall (40px on a phone).
 * The selected pill also carries a hairline edge in the fields' 3:1 border colour (its off-white fill
 * alone barely differs from the track), and a real border in forced-colours mode, where fills and
 * shadows are dropped. Left out, the quiet control is unchanged.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  variant = 'solid',
  fill = false,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; badge?: ReactNode; description?: string }[]
  ariaLabel?: string
  variant?: 'solid' | 'quiet'
  fill?: boolean
}) {
  const baseId = useId()
  if (variant === 'quiet') {
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className={
          fill
            ? 'grid w-full auto-cols-fr grid-flow-col gap-0.5 rounded-full bg-surface-2 p-1 shadow-[inset_0_0_0_1px_var(--color-line)] dark:bg-background dark:shadow-[inset_0_0_0_1px_var(--color-border)]'
            : 'inline-flex shrink-0 gap-0.5 rounded-[11px] bg-surface-2 p-[3px] shadow-[inset_0_0_0_1px_var(--color-line)]'
        }
      >
        {options.map((o, i) => {
          const selected = o.value === value
          const descId = o.description ? `${baseId}-${i}` : undefined
          return (
            <Fragment key={o.value}>
              <button
                type="button"
                aria-pressed={selected}
                aria-describedby={descId}
                onClick={() => onChange(o.value)}
                // The ::after reaches over the group's 3px padding, so a phone's 38px option is a 44px target.
                className={`relative inline-flex items-center gap-1.5 px-3.5 text-sm font-semibold transition after:absolute after:inset-x-0 after:content-[''] ${
                  fill
                    ? 'h-9 justify-center rounded-full after:-inset-y-1 max-[699.98px]:h-10'
                    : 'h-8 rounded-lg after:-inset-y-[3px] max-[699.98px]:h-[38px]'
                } ${
                  selected
                    ? fill
                      ? 'seg-fill-on bg-surface text-slate-900 forced-colors:border-2 forced-colors:border-[CanvasText] dark:bg-popover'
                      : 'bg-surface text-slate-900 shadow-[var(--shadow-frame)] dark:bg-popover dark:shadow-[0_1px_2px_rgb(0_0_0/0.35),inset_0_1px_0_rgb(255_255_255/0.05)]'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                {o.label}
                {o.badge != null && (
                  <span
                    aria-hidden
                    className={`inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-slate-500)_14%,var(--color-card))] px-[5px] text-xs tabular-nums ${
                      selected ? 'text-slate-900' : 'text-slate-500'
                    }`}
                  >
                    {o.badge}
                  </span>
                )}
              </button>
              {descId && (
                <span id={descId} className="sr-only">
                  {o.description}
                </span>
              )}
            </Fragment>
          )
        })}
      </div>
    )
  }
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      // The track: the inset surface ringed by a hairline, so it keeps its shape on the sage page
      // (where a plain tint all but vanishes) as well as on a card.
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-surface-2 p-1 text-sm font-medium shadow-[inset_0_0_0_1px_var(--color-border)]"
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1.5 transition ${
              selected
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * An inline error message, on the bad status tone (restyle PR 20: the bad text on its tint with a
 * hairline of the same red, in place of the old rose-50 card; the tokens flip in dark themselves).
 * `role="alert"` so assistive tech announces it when it appears.
 */
export function ErrorBanner({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      data-tone="bad"
      className={`rounded-lg bg-bad-bg px-4 py-3 text-sm font-medium text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-bad)_24%,transparent)] ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * A friendly empty/zero-data placeholder: an optional icon medallion, a title,
 * supporting copy and an optional actions row. Replaces ad-hoc "nothing here yet"
 * divs so empty states look intentional and consistent. On the neutral tone (restyle PR 20): the
 * card surface with a quiet dashed hairline, the icon on the neutral tint, the title in the ink.
 */
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      data-empty-state=""
      className="rounded-2xl border-[1.5px] border-dashed border-[color-mix(in_srgb,var(--color-slate-500)_32%,transparent)] bg-surface px-6 py-12 text-center max-[699.98px]:rounded-[14px] max-[699.98px]:px-5 max-[699.98px]:py-10"
    >
      {icon && (
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-slate-500 dark:bg-foreground/7">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-slate-900">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {children && <div className="mt-5 flex flex-wrap justify-center gap-3">{children}</div>}
    </div>
  )
}
