import type { ReactNode } from 'react'

export interface TourStep {
  id: string
  /**
   * Optional CSS selector for the element to spotlight. When the element is
   * missing or off-screen (e.g. the sidebar is collapsed on mobile, or there's
   * no budget yet), the step gracefully falls back to a centred card.
   */
  selector?: string
  title: string
  body: ReactNode
}

/** The guided walkthrough — anchored to stable chrome so it works in any app state. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'nav',
    selector: '[data-tour="sidebar"]',
    title: 'Find your way around',
    body: (
      <>
        Everything lives in this sidebar — your monthly <strong>Dashboard</strong>, the{' '}
        <strong>Transactions</strong> register, <strong>Jars</strong> and{' '}
        <strong>Reports</strong>. You can always get back here.
      </>
    ),
  },
  {
    id: 'goal',
    selector: '[data-tour="remaining-banner"]',
    title: 'Give every euro a job',
    body: (
      <>
        This is the heart of zero-based budgeting: assign <strong>all</strong> of your income across
        spending lines and savings until <strong>Remaining to Budget</strong> reaches{' '}
        <strong>€0.00</strong>. When the banner turns green, every euro has a job.
      </>
    ),
  },
  {
    id: 'help',
    selector: '[data-tour="help"]',
    title: 'Help is always one click away',
    body: (
      <>
        Stuck? This <strong>?</strong> button opens the full guide — and you can{' '}
        <strong>replay this tour</strong> from there whenever you like.
      </>
    ),
  },
  {
    id: 'done',
    title: "You're all set",
    body: (
      <>
        We've pinned a <strong>Getting started</strong> checklist in the corner to walk you through your
        first month, step by step. Close it whenever you want. Happy budgeting! 🎉
      </>
    ),
  },
]
