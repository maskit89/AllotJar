import { useRef, type ReactNode } from 'react'
import { Button } from '../components/ui'
import { CheckIcon, CloseIcon } from '../components/icons'
import { JarLogo } from '../components/Jar'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { useOnboarding } from './OnboardingContext'
import { useDialogA11y } from './useDialogA11y'

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
      <span>{children}</span>
    </li>
  )
}

/** The first-run welcome. Auto-opens once; offers the tour or a clean skip. */
export function WelcomeDialog() {
  const { startTour, dismissWelcome } = useOnboarding()
  const { preferredCurrency } = useAuth()
  const ref = useRef<HTMLDivElement>(null)
  useDialogA11y(ref, dismissWelcome)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60" aria-hidden="true" onClick={dismissWelcome} />

      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="zb-welcome-title"
        aria-describedby="zb-welcome-body"
        className="relative w-full max-w-md rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card sm:p-7"
      >
        <button
          type="button"
          onClick={dismissWelcome}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        <JarLogo lg />

        <h2 id="zb-welcome-title" className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
          Welcome to AllotJar
        </h2>
        <p id="zb-welcome-body" className="mt-2 text-sm leading-relaxed text-slate-600">
          AllotJar is a <strong>zero-based</strong> budget — every month you give{' '}
          <strong>every {currencyNoun(preferredCurrency)} a job</strong> before you spend it. Setting up
          your first month takes a few minutes. Want a quick 60-second tour to see how it fits together?
        </p>

        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          <Bullet>Plan a month and assign your income</Bullet>
          <Bullet>Track real spending against each line</Bullet>
          <Bullet>Save toward goals with jars</Bullet>
        </ul>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={dismissWelcome}>
            Skip for now
          </Button>
          <Button onClick={startTour}>Take the tour</Button>
        </div>
      </div>
    </div>
  )
}
