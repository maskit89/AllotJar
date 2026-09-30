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

/**
 * The guided walkthrough. Each page-step spotlights its sidebar nav item, so the
 * tour stays on one screen and points at "this menu item → does this". Anchors
 * gracefully centre when missing/off-screen (mobile top bar, a section turned off
 * by a feature flag, or no budget yet), so the tour works in any app state.
 *
 * A builder rather than a constant so the zero-based step can speak the user's
 * currency ("give every euro a job"); `noun` is the singular money-noun from
 * currencyNoun(). Step count is invariant to the noun — see TOUR_STEP_COUNT.
 */
export function buildTourSteps(noun: string): TourStep[] {
  return [
  {
    id: 'nav',
    selector: '[data-tour="sidebar"]',
    title: 'Find your way around',
    body: (
      <>
        Every section lives in this sidebar — your monthly <strong>Dashboard</strong>, the{' '}
        <strong>Transactions</strong> register, <strong>Accounts</strong>, savings{' '}
        <strong>Jars</strong>, <strong>Reports</strong> and <strong>People</strong>. The chip at the
        bottom is where <strong>account settings</strong>, switching household and{' '}
        <strong>signing out</strong> live.
      </>
    ),
  },
  {
    id: 'month',
    selector: '[data-tour="topbar"]',
    title: 'Pick the month you’re planning',
    body: (
      <>
        Use the <strong>‹ ›</strong> arrows to move between months — every screen follows the month you
        pick. The <strong>light/dark</strong> toggle sits on the right.
      </>
    ),
  },
  {
    id: 'goal',
    selector: '[data-tour="remaining-banner"]',
    title: `Give every ${noun} a job`,
    body: (
      <>
        This is the heart of zero-based budgeting: assign <strong>all</strong> of your income across
        spending lines, savings and jars until <strong>Remaining to Budget</strong> reaches{' '}
        <strong>zero</strong> and the banner turns green. <strong>Spent</strong> fills in
        automatically from the transactions you log — there’s nothing to tally by hand.
      </>
    ),
  },
  {
    id: 'transactions',
    selector: '[data-tour="nav-transactions"]',
    title: 'Track what you actually spend',
    body: (
      <>
        Log spending in <strong>Transactions</strong> and assign each one to a budget line — that’s what
        fills the <strong>Spent</strong> column. You can <strong>split</strong> one receipt across
        several lines, and repeat payees categorise themselves over time.
      </>
    ),
  },
  {
    id: 'accounts',
    selector: '[data-tour="nav-accounts"]',
    title: 'Know where your money sits',
    body: (
      <>
        <strong>Accounts</strong> tracks your current account, savings, cash or card. Give each an
        opening balance and tag transactions to it — the balance is worked out for you as
        <em> opening + income − expenses</em>.
      </>
    ),
  },
  {
    id: 'jars',
    selector: '[data-tour="nav-jars"]',
    title: 'Save up with jars',
    body: (
      <>
        <strong>Jars</strong> are for big or irregular costs — car, holiday, Christmas. Give a jar a
        target and a date and we’ll work out what to set aside each month, then watch it fill up. Budget
        that monthly amount in your <strong>Savings</strong> group on the Dashboard.
      </>
    ),
  },
  {
    id: 'reports',
    selector: '[data-tour="nav-reports"]',
    title: 'See the bigger picture',
    body: (
      <>
        <strong>Reports</strong> show income versus spending across recent months, where the money went
        by category, and an annual overview of what you earned, spent and saved.
      </>
    ),
  },
  {
    id: 'people',
    selector: '[data-tour="nav-people"]',
    title: 'Sharing money with someone?',
    body: (
      <>
        Add the people you share money with under <strong>People</strong>. Once you’re sharing, an{' '}
        <strong>Allocation</strong> tool appears that pools everyone’s income, covers the shared costs,
        and splits what’s left into each person’s savings — all previewed before anything moves.
      </>
    ),
  },
  {
    id: 'done',
    title: "You're all set",
    body: (
      <>
        We’ve pinned a <strong>Getting started</strong> checklist in the corner to walk you through your
        first month, step by step. You can replay this tour anytime from <strong>Help</strong>. Happy
        budgeting! 🎉
      </>
    ),
  },
  ]
}

/** The number of tour steps — invariant to the currency noun, so it's safe to precompute. */
export const TOUR_STEP_COUNT = buildTourSteps('unit').length
