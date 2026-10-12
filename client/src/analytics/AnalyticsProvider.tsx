import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useFeatures } from '../features/FeatureContext'
import { useAuth } from '../auth/AuthContext'
import { HOUSEHOLD_ROLE_LABELS } from '../types'
import { isConfigured } from './gtag'
import { getConsent, setConsent as persistConsent, type ConsentChoice } from './consent'
import { clearUser, setUser, setUserRole, startTracking, track, trackPageView } from './analytics'
import { hashUserId } from './hash'
import { EVENTS } from './events'
import { RouteAnalytics } from './RouteAnalytics'
import { ConsentBanner } from './ConsentBanner'

interface AnalyticsState {
  /** Analytics is offered to the user (the feature flag is on). Drives the banner + the Help page's Privacy card. */
  available: boolean
  /** The stored consent choice, or null when the user hasn't decided yet. */
  consent: ConsentChoice | null
  /** The banner's Accept / Decline and the Help switch turning on / off: the choice is stored, never cleared. */
  accept: () => void
  decline: () => void
  /** Forget the stored choice so the banner reappears (nothing in the UI calls it today). */
  reset: () => void
}

/** A safe default so consumers (and page tests) work even without a provider. */
const NOOP: AnalyticsState = {
  available: false,
  consent: null,
  accept() {},
  decline() {},
  reset() {},
}

const AnalyticsContext = createContext<AnalyticsState>(NOOP)

/**
 * Owns analytics consent and lifecycle. Tracking only ever starts when all three hold:
 * the feature flag is on, a build-time measurement ID exists, and the user granted
 * consent. The consent banner is shown on the flag alone (so it works even before an ID
 * is deployed); without an ID, granting simply starts nothing.
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const features = useFeatures()
  const { email, role } = useAuth()

  const available = features.analytics
  const [consent, setConsentState] = useState<ConsentChoice | null>(() => getConsent())

  // The single condition under which we actually send data to GA.
  const tracking = available && isConfigured() && consent === 'granted'

  // Start tracking (idempotent) and record the initial page view + opt-in, once live.
  useEffect(() => {
    if (!tracking) return
    startTracking()
    trackPageView(window.location.pathname)
    track(EVENTS.consentUpdated, { consent: 'granted' })
  }, [tracking])

  // Keep GA's User-ID + role property synced to the hashed, non-PII identity of the user.
  useEffect(() => {
    if (!tracking) return
    let cancelled = false
    if (email) {
      void hashUserId(email).then((id) => {
        if (!cancelled) setUser(id)
      })
      setUserRole(HOUSEHOLD_ROLE_LABELS[role] ?? null)
    } else {
      clearUser()
    }
    return () => {
      cancelled = true
    }
  }, [tracking, email, role])

  const accept = useCallback(() => {
    persistConsent('granted')
    setConsentState('granted')
  }, [])
  const decline = useCallback(() => {
    persistConsent('denied')
    setConsentState('denied')
  }, [])
  const reset = useCallback(() => {
    persistConsent(null)
    setConsentState(null)
  }, [])

  const value = useMemo<AnalyticsState>(
    () => ({ available, consent, accept, decline, reset }),
    [available, consent, accept, decline, reset],
  )

  return (
    <AnalyticsContext.Provider value={value}>
      <RouteAnalytics />
      {children}
      {available && consent === null && <ConsentBanner onAccept={accept} onDecline={decline} />}
    </AnalyticsContext.Provider>
  )
}

/** Analytics consent state + controls. Safe to call without a provider (returns a no-op). */
export function useAnalytics(): AnalyticsState {
  return useContext(AnalyticsContext)
}
