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

/** Copy for the desktop frame only (900px and up); hidden, and so not read, on phones. */
const desktopOnly = (copy: ReactNode) => <span className="max-[899.98px]:hidden">{copy}</span>

/** Copy for the phone frame only (below 900px). */
const phoneOnly = (copy: ReactNode) => <span className="min-[900px]:hidden">{copy}</span>

/**
 * The guided walkthrough. Each page-step spotlights its nav item (the sidebar link on desktop;
 * on phones its tab, or More for the pages that live in the More sheet), so the tour stays on
 * one screen and points at "this menu item → does this". Anchors gracefully centre when
 * missing/off-screen (a section turned off by a feature flag, a page without the month
 * switcher, or no budget yet), so the tour works in any app state. Copy that differs between
 * the desktop and phone frames shows only in its own layout (desktopOnly / phoneOnly).
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
        {desktopOnly(
          <>
            Every section lives in this sidebar — your monthly <strong>Dashboard</strong>, the{' '}
            <strong>Transactions</strong> register, <strong>Accounts</strong>, savings{' '}
            <strong>Jars</strong>, <strong>Reports</strong> and <strong>People</strong>. The account button at
            the bottom is where <strong>account settings</strong>, switching household, dark mode and{' '}
            <strong>signing out</strong> live.
          </>,
        )}
        {phoneOnly(
          <>
            Your monthly <strong>Dashboard</strong>, the <strong>Transactions</strong> register, savings{' '}
            <strong>Jars</strong> and <strong>Reports</strong> sit in this bar; <strong>More</strong> holds{' '}
            <strong>Accounts</strong>, <strong>People</strong> and the rest. The round account button (your
            initials) at the top is where <strong>account settings</strong>, switching household, dark mode and{' '}
            <strong>signing out</strong> live.
          </>,
        )}
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
        On month-based screens like the <strong>Dashboard</strong>, use the <strong>‹ ›</strong> arrows at the
        top to move between months — they all follow the month you pick. <strong>Dark mode</strong> is in
        your account menu.
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
    selector: '[data-tour="nav-transactions"], [data-tour-more~="transactions"]',
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
    selector: '[data-tour="nav-accounts"], [data-tour-more~="accounts"]',
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
    selector: '[data-tour="nav-jars"], [data-tour-more~="jars"]',
    title: 'Save up with jars',
    body: (
      <>
        <strong>Jars</strong> save up for a yearly bill, a holiday or a rainy-day pot. We work out what to
        set aside each month.
      </>
    ),
  },
  {
    id: 'reports',
    selector: '[data-tour="nav-reports"], [data-tour-more~="reports"]',
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
    selector: '[data-tour="nav-people"], [data-tour-more~="people"]',
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
