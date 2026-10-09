import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'

/**
 * The Light/Dark segmented toggle on the signed-out screens (sign in, forgot password, accept
 * invite, confirm email, reset password). Inside the app the top bar's ThemeButton and the
 * account menu's Dark mode switch do the same job.
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme()

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-[11px] border border-slate-200 bg-surface-2 p-[3px]"
    >
      {(['light', 'dark'] as const).map((m) => {
        const selected = mode === m
        return (
          <button
            key={m}
            type="button"
            aria-pressed={selected}
            aria-label={m === 'light' ? 'Light mode' : 'Dark mode'}
            onClick={() => setMode(m)}
            className={`rounded-lg px-4 py-1.5 text-[13px] font-semibold capitalize transition ${
              selected ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            {m}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The top bar's theme control on desktop: one round icon button, a toggle (`aria-pressed`) named
 * "Dark mode". It shows a moon in light mode and a sun in dark mode (the theme a press brings).
 */
export function ThemeButton({ className = '' }: { className?: string }) {
  const { isDark, setMode } = useTheme()
  const Icon = isDark ? Sun : Moon
  return (
    <button
      type="button"
      aria-label="Dark mode"
      aria-pressed={isDark}
      onClick={() => setMode(isDark ? 'light' : 'dark')}
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-surface hover:text-slate-900',
        className,
      )}
    >
      <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
    </button>
  )
}

/**
 * The picture of a Dark mode switch (track + thumb) for rows whose own element carries the
 * switch role and state, so the menu and the More sheet draw it the same way. Decorative.
 * Both parts are drawn with background colours, which forced-colours mode (Windows high
 * contrast) removes, so there they are redrawn in system colours: an outlined track, filled
 * with Highlight when on, and a thumb in the text colour.
 */
export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative ml-auto inline-flex h-[22px] w-9 shrink-0 rounded-full transition-colors forced-colors:border forced-colors:border-[color:CanvasText] forced-colors:[forced-color-adjust:none] ${
        on
          ? 'bg-brand-600 dark:bg-primary forced-colors:bg-[color:Highlight]'
          : 'bg-slate-100 shadow-[inset_0_0_0_1.5px_var(--color-input)] forced-colors:bg-[color:Canvas] forced-colors:shadow-none'
      }`}
    >
      <span
        className={`absolute top-[3px] left-[3px] size-4 rounded-full transition-transform forced-colors:top-0.5 forced-colors:left-0.5 ${
          on
            ? 'translate-x-[14px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] forced-colors:bg-[color:HighlightText]'
            : 'bg-slate-500 forced-colors:bg-[color:CanvasText]'
        }`}
      />
    </span>
  )
}
