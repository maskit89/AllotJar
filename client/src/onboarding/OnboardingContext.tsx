import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { TOUR_STEP_COUNT } from './tourSteps'
import { EVENTS, track } from '../analytics'

type Phase = 'idle' | 'welcome' | 'tour'

/** What we remember per user so onboarding never nags a returning user. */
interface OnboardingRecord {
  v: 1
  welcomeSeen: boolean
  tourDone: boolean
  checklistDismissed: boolean
}

const DEFAULT_RECORD: OnboardingRecord = {
  v: 1,
  welcomeSeen: false,
  tourDone: false,
  checklistDismissed: false,
}

const keyFor = (email: string) => `zbb.onboarding:${email}`

function readRecord(email: string | null): OnboardingRecord {
  if (!email) return DEFAULT_RECORD
  try {
    const raw = localStorage.getItem(keyFor(email))
    if (raw) return { ...DEFAULT_RECORD, ...(JSON.parse(raw) as Partial<OnboardingRecord>) }
  } catch {
    /* ignore malformed storage */
  }
  return DEFAULT_RECORD
}

interface OnboardingApi {
  phase: Phase
  tourStep: number
  totalTourSteps: number
  checklistVisible: boolean
  startTour: () => void
  nextTourStep: () => void
  prevTourStep: () => void
  endTour: () => void
  dismissWelcome: () => void
  dismissChecklist: () => void
  replay: () => void
}

/** A no-op default so consumers work even without a provider (e.g. in page tests). */
const NOOP: OnboardingApi = {
  phase: 'idle',
  tourStep: 0,
  totalTourSteps: TOUR_STEP_COUNT,
  checklistVisible: false,
  startTour() {},
  nextTourStep() {},
  prevTourStep() {},
  endTour() {},
  dismissWelcome() {},
  dismissChecklist() {},
  replay() {},
}

const OnboardingContext = createContext<OnboardingApi>(NOOP)

/** The onboarding state machine + actions. Safe to call without a provider. */
export function useOnboarding(): OnboardingApi {
  return useContext(OnboardingContext)
}

/**
 * Owns the welcome → tour → checklist flow and persists progress per user. The
 * welcome dialog auto-opens the first time a user sees the app and never again
 * (unless they replay it from Help).
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { email } = useAuth()
  const [phase, setPhase] = useState<Phase>('idle')
  const [tourStep, setTourStep] = useState(0)
  const [record, setRecord] = useState<OnboardingRecord>(() => readRecord(email))
  const emailRef = useRef(email)

  // (Re)load the per-user record on mount and whenever the signed-in user
  // changes, auto-opening the welcome the first time that user is seen.
  useEffect(() => {
    const r = readRecord(email)
    emailRef.current = email
    setRecord(r)
    setTourStep(0)
    setPhase(r.welcomeSeen ? 'idle' : 'welcome')
  }, [email])

  const persist = useCallback((patch: Partial<OnboardingRecord>) => {
    setRecord((prev) => {
      const next = { ...prev, ...patch }
      const e = emailRef.current
      if (e) {
        try {
          localStorage.setItem(keyFor(e), JSON.stringify(next))
        } catch {
          /* storage unavailable — non-fatal */
        }
      }
      return next
    })
  }, [])

  const dismissWelcome = useCallback(() => {
    setPhase('idle')
    persist({ welcomeSeen: true })
    track(EVENTS.onboardingDismissed, { context: 'welcome' })
  }, [persist])

  const startTour = useCallback(() => {
    setTourStep(0)
    setPhase('tour')
    persist({ welcomeSeen: true })
    track(EVENTS.onboardingStarted)
  }, [persist])

  const endTour = useCallback(() => {
    setPhase('idle')
    persist({ welcomeSeen: true, tourDone: true })
    track(EVENTS.onboardingCompleted)
  }, [persist])

  const nextTourStep = useCallback(() => {
    setTourStep((s) => Math.min(s + 1, TOUR_STEP_COUNT - 1))
  }, [])

  const prevTourStep = useCallback(() => {
    setTourStep((s) => Math.max(s - 1, 0))
  }, [])

  const dismissChecklist = useCallback(() => {
    persist({ checklistDismissed: true })
  }, [persist])

  // Explicit replay from Help: re-open the welcome and bring the checklist back,
  // but keep `welcomeSeen` true so it still won't auto-open on the next visit.
  const replay = useCallback(() => {
    setTourStep(0)
    setPhase('welcome')
    persist({ welcomeSeen: true, tourDone: false, checklistDismissed: false })
    track(EVENTS.tourReplayed)
  }, [persist])

  const value: OnboardingApi = {
    phase,
    tourStep,
    totalTourSteps: TOUR_STEP_COUNT,
    checklistVisible: !record.checklistDismissed,
    startTour,
    nextTourStep,
    prevTourStep,
    endTour,
    dismissWelcome,
    dismissChecklist,
    replay,
  }

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
}
