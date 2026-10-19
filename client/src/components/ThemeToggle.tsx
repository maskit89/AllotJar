import { useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'

/**
 * The theme control: one round icon button, a toggle (`aria-pressed`) named "Dark mode". It shows
 * a moon in light mode and a sun in dark mode (the theme a press brings). The top bar's on desktop,
 * and the one in the green room of the signed-out pages (AuthFrame) and the public pages' header
 * (PublicHeader); the old Light | Dark segmented toggle is gone (restyle PR 16). Inside the app the
 * account menu's and the More sheet's Dark mode switches do the same job.
 */
export function ThemeButton({ className = '' }: { className?: string }) {
  const { isDark, setMode } = useTheme()
  const mounted = useMounted()
  const Icon = isDark ? Sun : Moon
  return (
    <button
      type="button"
      aria-label="Dark mode"
      // In the prerendered landing page (the static render, before the app mounts) the theme is not
      // known: the button carries no state, and the page's own `.dark` class (set by theme-init.js
      // before the first paint) shows the right icon, so a dark visitor never sees the light state
      // flip (#351 P3-1). Mounted, it reads the theme as before.
      aria-pressed={mounted ? isDark : undefined}
      onClick={() => setMode(isDark ? 'light' : 'dark')}
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-surface hover:text-slate-900',
        className,
      )}
    >
      {mounted ? (
        <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
      ) : (
        <>
          <Moon className="size-[18px] dark:hidden" strokeWidth={1.8} aria-hidden />
          <Sun className="hidden size-[18px] dark:block" strokeWidth={1.8} aria-hidden />
        </>
      )}
    </button>
  )
}

const noSubscribe = () => () => {}
/**
 * False in a static render (renderToStaticMarkup, the landing prerender: React takes the server
 * snapshot), true in the app, from its first render on (createRoot takes the client snapshot), so
 * the app's own first render is unchanged and there is no effect or second render.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
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
