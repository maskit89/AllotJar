import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GOOGLE_CLIENT_ID, renderGoogleButton } from '../lib/googleAuth'
import { useTheme } from '../lib/theme'

/** Google draws its button at most this wide (px). */
const MAX_WIDTH = 400

/**
 * The official "Continue with Google" button (an iframe Google renders into our container),
 * or nothing at all when no client id is configured at build time — so environments without
 * the Google Cloud setup ship an unchanged login page. Script-load failures degrade to nothing
 * too (the password form is always there); the divider label is rendered by the parent only
 * through `onReady`, so a hidden button never leaves an orphaned "or" on the page.
 *
 * Drawn as the sign-in card wants it (restyle PR 9): Google's large pill, as wide as the card's
 * column (up to Google's 400px), 'outline' on the light page and 'filled_black' on the dark one.
 * Google fixes the look when it draws the iframe, so a theme change or a new column width redraws it.
 */
export function GoogleSignInButton({
  onCredential,
  onReady,
}: {
  /** Receives the signed Google ID token when the user completes the Google flow. */
  onCredential: (credential: string) => void
  /** Fires once the real button is on the page (lets the parent show its divider). */
  onReady?: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const { isDark } = useTheme()
  // Bumped when the column's width changes, so the button is redrawn at the new width.
  const [widthTick, setWidthTick] = useState(0)
  const drawnWidth = useRef(0)

  // Keep the latest callbacks without re-rendering Google's iframe on every parent render.
  const onCredentialRef = useRef(onCredential)
  const onReadyRef = useRef(onReady)
  useLayoutEffect(() => {
    onCredentialRef.current = onCredential
    onReadyRef.current = onReady
  })

  useEffect(() => {
    const el = container.current
    if (!GOOGLE_CLIENT_ID || !el) return
    let cancelled = false
    const width = Math.min(MAX_WIDTH, Math.floor(el.clientWidth))
    drawnWidth.current = width
    renderGoogleButton(el, (credential) => onCredentialRef.current(credential), {
      theme: isDark ? 'filled_black' : 'outline',
      shape: 'pill',
      // Unmeasured (no layout yet), Google picks its own width.
      width: width > 0 ? width : undefined,
    })
      .then(() => {
        if (!cancelled) onReadyRef.current?.()
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [isDark, widthTick])

  // A window resized across the phone breakpoint changes the column: redraw once it settles.
  useEffect(() => {
    const el = container.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const width = Math.min(MAX_WIDTH, Math.floor(el.clientWidth))
        if (width > 0 && width !== drawnWidth.current) setWidthTick((t) => t + 1)
      }, 150)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [failed])

  if (!GOOGLE_CLIENT_ID || failed) return null

  return <div ref={container} className="flex justify-center" data-testid="google-signin" />
}
