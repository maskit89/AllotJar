import { useEffect, useState } from 'react'

/**
 * How many rows of a long list to draw: the first `first`, then `step` more each time the end of
 * what is drawn comes within about two screens of view. A register with years of daily rows draws
 * tens of thousands of elements at once otherwise, which takes seconds on a phone. Put
 * `sentinelRef` on an empty element after the last drawn row while `more` is true.
 *
 * `atLeast` is drawn in any case: the row being edited, or one a save moved further down, stays
 * on the page. Without IntersectionObserver (jsdom, a very old browser) every row is drawn.
 */
export function useProgressiveList(total: number, atLeast = 0, first = 60, step = 120) {
  const supported = typeof IntersectionObserver !== 'undefined'
  const [limit, setLimit] = useState(first)
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)

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

  const shown = supported ? Math.min(total, Math.max(limit, atLeast)) : total
  return { shown, more: shown < total, sentinelRef: setSentinel }
}
