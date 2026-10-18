import { useLayoutEffect, useRef } from 'react'
import { Notice, NoticeAction } from '../components/Notice'

/**
 * The denied-by-default cookie-consent banner. Google Analytics is not loaded and no
 * identifiers are set until the user presses Accept here. One Notice line with Decline / Accept
 * (restyle PR 17; both quiet, so the page under it keeps its one primary button), a non-modal
 * region (no focus trap) pinned over the foot of the screen.
 *
 * Where it sits: on a phone above the tab bar (`--tabbar-h`, which PhoneNav reserves, safe area
 * included), never over it; on a wide screen within the content column, clear of the sidebar and
 * its Help item (`--sidebar-w`, set by AppShell's sidebar). The pinned wrapper lets touches through
 * to the tab bar beneath it; only the card itself takes them.
 *
 * While shown it publishes the room it takes from the bottom of the screen as `--consent-h` on
 * <html> (removed when it goes): the card, its gap and the tab bar below, so a page whose last
 * control would otherwise sit under it can keep clear (the Help page's Privacy card, restyle PR 13,
 * which pads by `--consent-h` less `--tabbar-h`). Nothing in the frame reads it: no other page changes.
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
    // Its height follows the line's wrapping (the viewport's width, the font) and the tab bar's
    // room, which is the wrapper's padding: the border box, since the content box alone would not
    // report the tab bar mounting after the first measure (the Help page would then pad too little).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(el, { box: 'border-box' })
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--consent-h')
    }
  }, [])
  return (
    // Clear of the home indicator and a landscape notch (the page opts into the whole screen with
    // viewport-fit=cover, so the safe-area insets are real on iPhones), and of the tab bar.
    <div
      ref={ref}
      role="region"
      aria-label="Analytics consent"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(calc(var(--tabbar-h)+12px),calc(env(safe-area-inset-bottom)+1rem))] pl-[max(1rem,env(safe-area-inset-left))] min-[900px]:left-[var(--sidebar-w,0px)] min-[900px]:px-10"
    >
      <Notice
        tone="info"
        className="pointer-events-auto mx-auto max-w-3xl shadow-[var(--shadow-frame-lg),inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]"
        action={
          <span className="flex shrink-0 gap-0.5">
            <NoticeAction onClick={onDecline} className="text-slate-600">
              Decline
            </NoticeAction>
            <NoticeAction onClick={onAccept}>Accept</NoticeAction>
          </span>
        }
      >
        We use Google Analytics for anonymous usage only; change it under Help.
      </Notice>
    </div>
  )
}
