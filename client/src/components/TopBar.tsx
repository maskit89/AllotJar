import { useMonth } from '../features/MonthContext'
import { ThemeToggle } from './ThemeToggle'

/**
 * The shared top bar every data screen opens with (above the hero): a month
 * navigator (`‹ June 2026 ›`) + the "Zero-based" signature pill on the left, and
 * the Light/Dark theme toggle on the right. The month comes from the app-wide
 * MonthContext so all month-scoped screens move together.
 */
export function TopBar() {
  const { label, goPrev, goNext } = useMonth()

  const arrow =
    'flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-slate-200 bg-surface text-[15px] text-slate-500 transition hover:border-brand-600 hover:text-slate-900 active:scale-95'

  return (
    <div data-tour="topbar" className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <button type="button" aria-label="Previous month" onClick={goPrev} className={arrow}>
          ‹
        </button>
        <h2 className="min-w-[128px] text-center text-[22px] font-bold tracking-[-0.02em] text-slate-900 tabular-nums">
          {label}
        </h2>
        <button type="button" aria-label="Next month" onClick={goNext} className={arrow}>
          ›
        </button>
        <span className="ml-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
          Zero-based
        </span>
      </div>
      <ThemeToggle />
    </div>
  )
}
