import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { useOnboarding } from './OnboardingContext'
import { buildTourSteps } from './tourSteps'
import { useDialogA11y } from './useDialogA11y'

interface Box {
  top: number
  left: number
  width: number
  height: number
}

function onScreen(r: DOMRect): boolean {
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < window.innerHeight &&
    r.left < window.innerWidth
  )
}

const PAD = 8
const TIP_WIDTH = 340
const GAP = PAD + 12
// Rough tooltip height, used only to keep a side-placed card on screen.
const TIP_EST_HEIGHT = 280

/**
 * Place the tooltip on whichever side of the target has room — below or above
 * for short elements, to the side for tall ones (e.g. the full-height sidebar),
 * and dead-centre when there's no target or nowhere sensible to anchor.
 */
function tooltipStyle(box: Box | null): CSSProperties {
  const centered: CSSProperties = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    width: TIP_WIDTH,
    maxWidth: 'calc(100vw - 24px)',
    transform: 'translate(-50%, -50%)',
  }
  if (!box) return centered

  const vw = window.innerWidth
  const vh = window.innerHeight
  const base: CSSProperties = { position: 'fixed', width: TIP_WIDTH, maxWidth: 'calc(100vw - 24px)' }
  const clampX = (x: number) => Math.min(Math.max(x, 12), Math.max(12, vw - TIP_WIDTH - 12))
  const clampY = (y: number) => Math.min(Math.max(y, 12), Math.max(12, vh - TIP_EST_HEIGHT))

  if (vh - (box.top + box.height) >= 200) {
    return { ...base, top: box.top + box.height + GAP, left: clampX(box.left) }
  }
  if (box.top >= 200) {
    return { ...base, top: box.top - GAP, left: clampX(box.left), transform: 'translateY(-100%)' }
  }
  if (vw - (box.left + box.width) >= TIP_WIDTH + 24) {
    return { ...base, top: clampY(box.top), left: box.left + box.width + GAP }
  }
  if (box.left >= TIP_WIDTH + 24) {
    return { ...base, top: clampY(box.top), left: box.left - GAP, transform: 'translateX(-100%)' }
  }
  return centered
}

/**
 * A coach-mark tour: dims the page, spotlights the current step's target with a
 * cut-out, and anchors an explanatory dialog next to it. Steps whose target is
 * missing or off-screen show as a centred card, so the tour works in any state.
 */
export function SpotlightTour() {
  const { tourStep, totalTourSteps, nextTourStep, prevTourStep, endTour } = useOnboarding()
  const { budgetCurrency } = useAuth()
  const steps = useMemo(() => buildTourSteps(currencyNoun(budgetCurrency)), [budgetCurrency])
  const step = steps[tourStep]
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [box, setBox] = useState<Box | null>(null)

  useDialogA11y(dialogRef, endTour)

  const measure = useCallback(() => {
    if (!step.selector) {
      setBox(null)
      return
    }
    const el = document.querySelector(step.selector)
    if (!el) {
      setBox(null)
      return
    }
    const r = el.getBoundingClientRect()
    setBox(onScreen(r) ? { top: r.top, left: r.left, width: r.width, height: r.height } : null)
  }, [step.selector])

  useLayoutEffect(measure, [measure])

  useEffect(() => {
    const onChange = () => measure()
    window.addEventListener('resize', onChange)
    window.addEventListener('scroll', onChange, true)
    return () => {
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange, true)
    }
  }, [measure])

  // Announce each step to screen readers by moving focus to its heading.
  useEffect(() => {
    headingRef.current?.focus()
  }, [tourStep])

  const isLast = tourStep === totalTourSteps - 1
  const onNext = () => (isLast ? endTour() : nextTourStep())

  const highlight: Box | null = box
    ? { top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 }
    : null

  const tipStyle = tooltipStyle(box)

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Catches clicks so the dimmed page behind stays inert during the tour. */}
      <div className="absolute inset-0" aria-hidden="true" />

      {highlight ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl ring-2 ring-brand-400 transition-all duration-200"
          style={{ ...highlight, boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.6)' }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-slate-950/60" />
      )}

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="zb-tour-title"
        aria-describedby="zb-tour-body"
        className="rounded-2xl border border-slate-200/70 bg-surface p-5 shadow-card"
        style={tipStyle}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-200">
          Step {tourStep + 1} of {totalTourSteps}
        </p>
        <h2
          ref={headingRef}
          tabIndex={-1}
          id="zb-tour-title"
          className="mt-1 text-lg font-bold tracking-tight text-slate-900 focus:outline-none"
        >
          {step.title}
        </h2>
        <p id="zb-tour-body" className="mt-2 text-sm leading-relaxed text-slate-600">
          {step.body}
        </p>

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={endTour}
            className="text-sm font-medium text-slate-500 transition hover:text-slate-700"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {tourStep > 0 && (
              <Button variant="secondary" size="sm" onClick={prevTourStep}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={onNext}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex justify-center gap-1.5" aria-hidden="true">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 rounded-full transition-all ${
                i === tourStep ? 'w-5 bg-brand-600' : 'w-1.5 bg-slate-300'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
