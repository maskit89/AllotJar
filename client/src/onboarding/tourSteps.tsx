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
  /** One sentence (restyle PR 19): what this part of the app is for. */
  body: ReactNode
}

/** Copy for the desktop frame only (900px and up); hidden, and so not read, on phones. */
const desktopOnly = (copy: ReactNode) => <span className="max-[899.98px]:hidden">{copy}</span>

/** Copy for the phone frame only (below 900px). */
const phoneOnly = (copy: ReactNode) => <span className="min-[900px]:hidden">{copy}</span>

/**
 * The guided walkthrough. The page-steps follow the menu's order (Accounts, Jars, Transactions,
 * Reports, People), the order a household sets up in. Each page-step spotlights its nav item (the sidebar link on desktop;
 * on phones its tab, or More for the pages that live in the More sheet), so the tour stays on
 * one screen and points at "this menu item → does this". Anchors gracefully centre when
 * missing/off-screen (a section turned off by a feature flag, a page without the month
 * switcher, or no budget yet), so the tour works in any app state. Copy that differs between
 * the desktop and phone frames shows only in its own layout (desktopOnly / phoneOnly).
 *
 * One short title and one sentence per step (restyle PR 19, the owner's "as little text as
 * possible"): the frame's words as the restyled pages use them ("Remaining to budget" is the
 * Dashboard's first KPI tile; the theme button sits in the top bar on desktop, Dark mode under
 * More on a phone), and no emoji.
 *
 * A builder rather than a constant so the zero-based step can speak the user's
 * currency ("give every euro a job"); `noun` is the singular money-noun from
 * currencyNoun(). Step count is invariant to the noun — see TOUR_STEP_COUNT.
 */
export function buildTourSteps(noun: string): TourStep[] {
  return [
    {
      id: 'nav',
      // The desktop sidebar, or on phones the bottom tab bar.
      selector: '[data-tour="sidebar"], [data-tabbar]',
      title: 'Find your way around',
      body: (
        <>
          {desktopOnly('Every page lives in this sidebar, with your account and household at its foot.')}
          {phoneOnly('Your main pages sit in this bar, and More holds Accounts, People and the rest.')}
        </>
      ),
    },
    {
      id: 'month',
      // The month switcher, on the month-based screens only (elsewhere the step centres).
      selector: '[data-tour="month"]',
      title: 'Pick the month you’re planning',
      body: (
        <>
          {desktopOnly('These arrows move every month-based page; the button beside them switches light and dark.')}
          {phoneOnly('These arrows move every month-based page; Dark mode is under More.')}
        </>
      ),
    },
    {
      id: 'goal',
      selector: '[data-tour="remaining-banner"]',
      title: `Give every ${noun} a job`,
      body: 'Assign all your income to lines and jars until Remaining to budget reads zero.',
    },
    {
      id: 'accounts',
      selector: '[data-tour="nav-accounts"], [data-tour-more~="accounts"]',
      title: 'Start with your accounts',
      body: 'Add each bank account, card and cash you use, with its balance.',
    },
    {
      id: 'jars',
      selector: '[data-tour="nav-jars"], [data-tour-more~="jars"]',
      title: 'Save up with jars',
      body: 'A jar sits in one of your accounts and saves for a bill, a holiday or a rainy day.',
    },
    {
      id: 'transactions',
      selector: '[data-tour="nav-transactions"], [data-tour-more~="transactions"]',
      title: 'Track what you spend',
      body: 'Log or import each payment in Transactions and give it a budget line.',
    },
    {
      id: 'reports',
      selector: '[data-tour="nav-reports"], [data-tour-more~="reports"]',
      title: 'See the bigger picture',
      body: 'Reports show income against spending, where the money went and what each jar paid.',
    },
    {
      id: 'people',
      selector: '[data-tour="nav-people"], [data-tour-more~="people"]',
      title: 'Sharing money with someone?',
      body: 'Add them under People, and Allocation splits what is left into each person’s savings.',
    },
    {
      id: 'done',
      title: "You're all set",
      body: 'Getting started walks you through your first month, and Help replays this tour.',
    },
  ]
}

/** The number of tour steps — invariant to the currency noun, so it's safe to precompute. */
export const TOUR_STEP_COUNT = buildTourSteps('unit').length
