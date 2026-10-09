import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { EVENTS, track } from '../analytics'

const KEY = 'zbb.theme'
/** Fired on window when a theme control pins a choice, so every mounted control follows. */
const CHANGED = 'zbb:theme'
export type ThemeMode = 'light' | 'dark'

/** jsdom has no matchMedia, so every access is guarded. */
function systemQuery(): MediaQueryList | undefined {
  return window.matchMedia?.('(prefers-color-scheme: dark)')
}

/** The last pick made on this page, for when storage is blocked and can't hold it. */
let picked: ThemeMode | null = null

function stored(): string | null {
  try {
    return localStorage.getItem(KEY) ?? picked
  } catch {
    return picked
  }
}

/** The explicit choice when there is one, else the OS scheme. */
function currentMode(): ThemeMode {
  const s = stored()
  if (s === 'light' || s === 'dark') return s
  return systemQuery()?.matches ? 'dark' : 'light'
}

function apply(mode: ThemeMode) {
  document.documentElement.classList.toggle('dark', mode === 'dark')
}

function subscribe(onChange: () => void) {
  const mq = systemQuery()
  mq?.addEventListener('change', onChange)
  window.addEventListener(CHANGED, onChange)
  return () => {
    mq?.removeEventListener('change', onChange)
    window.removeEventListener(CHANGED, onChange)
  }
}

/**
 * The app's theme, shared by every theme control on screen (the top bar's button, the account
 * menu's and the More sheet's Dark mode switches, the auth pages' Light/Dark toggle). Until the
 * user picks, it follows the OS `prefers-color-scheme` live; a pick is persisted under
 * localStorage 'zbb.theme' and from then on wins over the OS. The initial class is set by
 * public/theme-init.js before first paint, so there is no flash on load.
 */
export function useTheme() {
  const mode = useSyncExternalStore(subscribe, currentMode, (): ThemeMode => 'light')

  useEffect(() => apply(mode), [mode])

  const setMode = useCallback((next: ThemeMode) => {
    picked = next
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Storage blocked (site data off): `picked` keeps the choice for this page's controls.
    }
    apply(next)
    window.dispatchEvent(new Event(CHANGED))
    track(EVENTS.themeChanged, { theme: next })
  }, [])

  return { mode, isDark: mode === 'dark', setMode }
}
