import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../components/ui'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { useMediaQuery } from '../lib/useMediaQuery'
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
// Rough card height (eyebrow, title, one sentence, the buttons), used only to keep a side-placed card on screen.
const TIP_EST_HEIGHT = 210

/** The tour's buttons: 36px, 44px for a finger on a phone. */
const TOUR_BUTTON = 'h-9 rounded-[10px]! max-[699.98px]:h-11'

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
 * On a phone the card docks to the foot of the screen, just above the tab bar (`--tabbar-h`, safe
 * area included) and within the page's 12px gutter, instead of floating over the tiles.
 */
const DOCKED: CSSProperties = {
  position: 'fixed',
  left: 'max(12px, env(safe-area-inset-left))',
  right: 'max(12px, env(safe-area-inset-right))',
  bottom: 'max(calc(var(--tabbar-h) + 12px), calc(env(safe-area-inset-bottom) + 12px))',
}

/**
 * A coach-mark tour: dims the page, spotlights the current step's target with a
 * cut-out, and anchors an explanatory dialog next to it. Steps whose target is
 * missing or off-screen show as a centred card, so the tour works in any state.
 *
 * The card (restyle PR 19): the dialogs' surface and shadow, an eyebrow "Step n of 9", a short title
 * and one sentence, the quiet "Skip tour" at its left and the quiet Back beside the one primary,
 * Next (Finish on the last step). On a phone (below 700px) it docks above the tab bar, and a
 * target it would cover, or one scrolled off the screen, is scrolled into view.
 */
export function SpotlightTour() {
  const { tourStep, totalTourSteps, nextTourStep, prevTourStep, endTour } = useOnboarding()
  const { budgetCurrency } = useAuth()
  const steps = useMemo(() => buildTourSteps(currencyNoun(budgetCurrency)), [budgetCurrency])
  const step = steps[tourStep]
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [box, setBox] = useState<Box | null>(null)
  const docked = useMediaQuery('(max-width: 699.98px)')

  useDialogA11y(dialogRef, endTour)
  // The tour opens with nothing focused (the welcome that started it has closed), so the hook above
  // has nothing to give focus back to: on the way out it goes to the main content, not <body>.
  useEffect(
    () => () => {
      if (!document.activeElement || document.activeElement === document.body) document.getElementById('main-content')?.focus()
    },
    [],
  )

  const measure = useCallback(() => {
    if (!step.selector) {
      setBox(null)
      return
    }
    // A step may have one anchor per layout (the sidebar link on desktop, the tab or More on
    // phones): spotlight the first one that is actually on screen.
    for (const el of document.querySelectorAll(step.selector)) {
      const r = el.getBoundingClientRect()
      if (onScreen(r)) {
        setBox({ top: r.top, left: r.left, width: r.width, height: r.height })
        return
      }
    }
    setBox(null)
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

  // Keep the spotlit element in sight: one laid out but scrolled off the screen, or (docked) sitting
  // under the card, is scrolled to the middle of the screen. The scroll listener above re-measures.
  useEffect(() => {
    if (!step.selector) return
    const shown = Array.from(document.querySelectorAll<HTMLElement>(step.selector)).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    const target = shown.find((el) => onScreen(el.getBoundingClientRect())) ?? shown[0]
    if (!target) return
    const r = target.getBoundingClientRect()
    const card = docked ? dialogRef.current?.getBoundingClientRect() : undefined
    const cardTop = card?.top ?? window.innerHeight
    const cardBottom = card?.bottom ?? window.innerHeight
    // Any overlap with the card counts, a target wholly under it included; the tab bar sits below it.
    const covered = r.bottom > cardTop - PAD && r.top < cardBottom
    if (onScreen(r) && !covered) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  }, [step.selector, docked])

  // Announce each step to screen readers by moving focus to its heading.
  useEffect(() => {
    headingRef.current?.focus()
  }, [tourStep])

  const isLast = tourStep === totalTourSteps - 1
  const onNext = () => (isLast ? endTour() : nextTourStep())

  const highlight: Box | null = box
    ? { top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 }
    : null

  const tipStyle = docked ? DOCKED : tooltipStyle(box)

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Catches clicks so the dimmed page behind stays inert during the tour. */}
      <div className="absolute inset-0" aria-hidden="true" />

      {highlight ? (
        // The cut-out: a 2px gold ring (the frame's gold marker) and the scrim around it, both drawn by
        // the one box-shadow (an inline shadow would hide a ring utility's own).
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[18px] ring-2 transition-all duration-200"
          style={{ ...highlight, boxShadow: '0 0 0 2px var(--onb-ring), 0 0 0 9999px var(--onb-scrim)' }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-[var(--onb-scrim)]" />
      )}

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="zb-tour-title"
        aria-describedby="zb-tour-body"
        data-docked={docked ? '' : undefined}
        className="onb-card rounded-2xl border border-slate-200/80 p-5 text-sm shadow-[var(--shadow-frame-lg)] max-[699.98px]:px-[18px] max-[699.98px]:pt-4 max-[699.98px]:pb-3.5"
        style={tipStyle}
      >
        <p className="text-xs font-semibold tracking-[0.05em] text-slate-500 uppercase">
          Step {tourStep + 1} of {totalTourSteps}
        </p>
        <h2
          ref={headingRef}
          tabIndex={-1}
          id="zb-tour-title"
          className="mt-1.5 text-base leading-snug font-bold tracking-[-0.01em] text-slate-900 focus:outline-none"
        >
          {step.title}
        </h2>
        <p id="zb-tour-body" className="mt-1 text-sm leading-normal text-slate-500">
          {step.body}
        </p>

        <div className="mt-4 flex items-center gap-2 max-[699.98px]:mt-3.5">
          <Button
            variant="ghost"
            onClick={endTour}
            className={`${TOUR_BUTTON} -ml-2.5 px-2.5! text-slate-500! dark:hover:bg-foreground/7`}
          >
            Skip tour
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {tourStep > 0 && (
              <Button variant="ghost" onClick={prevTourStep} className={`${TOUR_BUTTON} px-3.5! text-slate-500! dark:hover:bg-foreground/7`}>
                Back
              </Button>
            )}
            <Button
              onClick={onNext}
              className={`${TOUR_BUTTON} min-w-[84px] px-4! shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] dark:bg-primary dark:hover:bg-brand-600`}
            >
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
