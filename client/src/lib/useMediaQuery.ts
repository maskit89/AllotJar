import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches, kept live as the window changes. jsdom has no matchMedia, so
 * there (and before hydration) it reads `fallback`.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia?.(query)
      mq?.addEventListener('change', onChange)
      return () => mq?.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? fallback,
    () => fallback,
  )
}
