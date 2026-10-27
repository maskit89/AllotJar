import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

interface Options {
  /** Rows drawn in any case: the row being edited, or one a save moved further down. Once drawn, they stay drawn. */
  atLeast?: number
  /** A change (another account) starts again from the first batch. */
  resetKey?: unknown
  first?: number
  step?: number
}

/**
 * How many rows of a long list to draw: the first `first`, then `step` more each time the end of
 * what is drawn comes within about two screens of view. A register with years of daily rows draws
 * tens of thousands of elements at once otherwise, which takes seconds on a phone. Put
 * `sentinelRef` on an empty element after the last drawn row while `more` is true.
 *
 * Printing draws every row. Without IntersectionObserver (jsdom, a very old browser) every row is
 * drawn.
 */
export function useProgressiveList(total: number, { atLeast = 0, resetKey, first = 60, step = 120 }: Options = {}) {
  const supported = typeof IntersectionObserver !== 'undefined'
  const [limit, setLimit] = useState(first)
  const [key, setKey] = useState(resetKey)
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)

  // Adjusted while rendering, so the list never draws a frame without them.
  if (key !== resetKey) {
    setKey(resetKey)
    setLimit(Math.max(first, atLeast))
  } else if (atLeast > limit) {
    setLimit(atLeast)
  }

  // Observed afresh after each batch, so a sentinel still in view after one batch asks for the next.
  useEffect(() => {
    if (!sentinel || !supported) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + step)
      },
      { rootMargin: '0px 0px 1600px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, supported, step, limit])

  // The browser's print shows the whole list: drawn before the listener returns, since the
  // print is laid out straight after it.
  useEffect(() => {
    const all = () => flushSync(() => setLimit((l) => Math.max(l, total)))
    window.addEventListener('beforeprint', all)
    return () => window.removeEventListener('beforeprint', all)
  }, [total])

  const shown = supported ? Math.min(total, Math.max(limit, atLeast)) : total
  return { shown, more: shown < total, sentinelRef: setSentinel }
}
