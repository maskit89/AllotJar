import { useEffect, useState } from 'react'
import { EVENTS, track } from '../analytics'

const KEY = 'zbb.theme'
type Mode = 'light' | 'dark'

/** jsdom has no matchMedia, so every access is guarded. */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function currentMode(): Mode {
  const stored = localStorage.getItem(KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return systemPrefersDark() ? 'dark' : 'light'
}

function apply(mode: Mode) {
  document.documentElement.classList.toggle('dark', mode === 'dark')
}

/**
 * The Light/Dark theme control — a small segmented toggle (the redesign shows it
 * top-right of the top bar and on the auth screens). Persists the explicit choice
 * and, until the user picks, follows the OS `prefers-color-scheme` live. The
 * initial class is set by a script in index.html so there's no flash on load.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(() => currentMode())

  useEffect(() => apply(mode), [mode])

  // Track system changes only while the user hasn't chosen explicitly.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = () => {
      if (!localStorage.getItem(KEY)) setMode(mq.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function choose(next: Mode) {
    localStorage.setItem(KEY, next)
    setMode(next)
    track(EVENTS.themeChanged, { theme: next })
  }

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
            onClick={() => choose(m)}
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
