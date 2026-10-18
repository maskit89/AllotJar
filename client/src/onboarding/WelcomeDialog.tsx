import { Button } from '../components/ui'
import { BandShelf } from '../components/AuthFrame'
import { Modal } from '../components/Modal'
import { DIALOG_ACTIONS, DIALOG_CANCEL, DIALOG_PRIMARY } from '../components/settings/parts'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { useOnboarding } from './OnboardingContext'

/**
 * The first-run welcome. Auto-opens once; offers the tour or a clean skip.
 *
 * A sheet dialog (Modal `sheet`, restyle PR 19): a centred card on a wide screen, a bottom sheet on
 * a phone. Above the title, the green room with its shelf of glass jars (the sign-in band's
 * BandShelf); under it one sentence in the budget currency's noun, as the tour and the checklist
 * say it (only the public pages say "euro" always); what AllotJar does sits behind the title's (i). The footer has the
 * quiet "Skip for now" and the one primary "Take the tour". The ✕ (the grab handle on a phone), the
 * scrim and Escape skip it too.
 */
export function WelcomeDialog() {
  const { startTour, dismissWelcome } = useOnboarding()
  const { households, budgetCurrency } = useAuth()
  const noun = currencyNoun(budgetCurrency)

  // Someone who arrived via a household invite is looking at a budget that already exists —
  // greet them as a member joining it, not as an owner about to set one up.
  const activeHousehold = households.find((h) => h.isActive)
  const joined = activeHousehold ? !activeHousehold.isOwn : false

  return (
    <Modal
      sheet
      zIndex={60}
      title="Welcome to AllotJar"
      describedBy="zb-welcome-body"
      hint={
        joined
          ? 'See the month’s plan and where money goes, and record spending as it happens. Watch jars fill toward shared goals.'
          : 'Plan a month and assign your income, then track real spending against each line. Save toward goals with jars.'
      }
      hintLabel="About AllotJar"
      onClose={dismissWelcome}
      banner={
        <div className="onb-room" aria-hidden>
          <BandShelf />
        </div>
      }
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={dismissWelcome} className={DIALOG_CANCEL}>
            Skip for now
          </Button>
          <Button onClick={startTour} className={DIALOG_PRIMARY}>
            Take the tour
          </Button>
        </div>
      }
    >
      <p id="zb-welcome-body" className="-mt-1 text-sm leading-normal text-slate-500">
        {joined
          ? `You’ve joined a shared household budget that gives every ${noun} a job.`
          : `A budget that gives every ${noun} a job.`}
      </p>
    </Modal>
  )
}
