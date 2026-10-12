import { useLayoutEffect, useRef } from 'react'
import { Button } from '../components/ui'

/**
 * The denied-by-default cookie-consent banner. Google Analytics is not loaded and no
 * identifiers are set until the user presses Accept here. Built from the audited UI
 * primitives so it stays WCAG-clean in both themes; it's a non-modal region (no focus
 * trap) pinned to the bottom of the viewport.
 *
 * While shown it publishes its height as `--consent-h` on <html> (removed when it goes), so a
 * page whose last control would otherwise sit under it can keep clear (the Help page's Privacy
 * card, restyle PR 13). Nothing in the frame reads it: no other page changes.
 */
export function ConsentBanner({
  onAccept,
  onDecline,
}: {
  onAccept: () => void
  onDecline: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--consent-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    publish()
    // Its height follows the text's wrapping (the viewport's width, the font).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--consent-h')
    }
  }, [])
  return (
    // Clear of the home indicator and a landscape notch (the page opts into the whole screen with
    // viewport-fit=cover, so the safe-area insets are real on iPhones).
    <div
      ref={ref}
      role="region"
      aria-label="Analytics consent"
      className="fixed inset-x-0 bottom-0 z-50 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-slate-200/70 bg-surface p-4 shadow-card sm:flex-row sm:items-center sm:gap-4">
        <p className="text-sm leading-relaxed text-slate-600">
          We use <strong>Google Analytics</strong> to understand how the app is used and improve it.
          We never send your name, email, account names or any amounts — only anonymous usage. You can
          change this anytime under <strong>Help</strong>.
        </p>
        <div className="flex shrink-0 gap-2 sm:ml-auto">
          <Button variant="secondary" size="sm" onClick={onDecline}>
            Decline
          </Button>
          <Button size="sm" onClick={onAccept}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  )
}
