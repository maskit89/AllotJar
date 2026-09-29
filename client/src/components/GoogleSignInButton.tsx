import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GOOGLE_CLIENT_ID, renderGoogleButton } from '../lib/googleAuth'

/**
 * The official "Continue with Google" button (an iframe Google renders into our container),
 * or nothing at all when no client id is configured at build time — so environments without
 * the Google Cloud setup ship an unchanged login page. Script-load failures degrade to nothing
 * too (the password form is always there); the divider label is rendered by the parent only
 * through `onReady`, so a hidden button never leaves an orphaned "or" on the page.
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

  // Keep the latest callbacks without re-rendering Google's iframe on every parent render.
  const onCredentialRef = useRef(onCredential)
  const onReadyRef = useRef(onReady)
  useLayoutEffect(() => {
    onCredentialRef.current = onCredential
    onReadyRef.current = onReady
  })

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !container.current) return
    let cancelled = false
    renderGoogleButton(container.current, (credential) => onCredentialRef.current(credential), {
      width: 336, // matches the auth card's inner width (max-w-sm minus p-8)
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
  }, [])

  if (!GOOGLE_CLIENT_ID || failed) return null

  return <div ref={container} className="flex justify-center" data-testid="google-signin" />
}
