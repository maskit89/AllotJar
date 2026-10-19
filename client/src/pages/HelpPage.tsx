import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowLeftRight,
  ArrowUpRight,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  Landmark,
  Lightbulb,
  ReceiptText,
  RotateCcw,
  Settings2,
  Users,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { GlassJar } from '../components/GlassJar'
import { InfoHint } from '../components/InfoHint'
import { JarNavIcon } from '../components/icons'
import { SwitchTrack } from '../components/ThemeToggle'
import { CARD_TITLE, DASH_CARD, TITLE_HINT } from '../components/budget/card'
import { NEUTRAL, TxTile } from '../components/transactions/TxParts'
import { useOnboarding } from '../onboarding/OnboardingContext'
import { EVENTS, track } from '../analytics'
import { useAnalytics } from '../analytics/AnalyticsProvider'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'

/*
 * The Help page (restyle PR 13, the approved "polished Warm" mock-up): nothing on it is a figure,
 * so the green hero holds the one idea everything hangs on (zero-based budgeting) in the KPI row's
 * place and height, the rest of that idea behind its (i). Under it, the Dashboard's two columns:
 * the topics on the left, one card of rows that open in place to their full text, with the two
 * quiet ways to more help in its header (replaying the welcome tour, the complete user guide);
 * and, only while the household is offered analytics (the `analytics` feature flag, which ships
 * off), the Privacy card on the right, its one row the consent switch. A phone reads them in the
 * same order: hero, topics, privacy. While that choice is still open the frame's consent banner
 * sits fixed over the foot of the screen: the page keeps its end, and any control focused from
 * the keyboard, clear of it (see BANNER_PAD).
 */

const GUIDE_URL = 'https://github.com/maskit89/AllotJar/blob/main/docs/USER_GUIDE.md'

/** A quiet link in a card header (the Dashboard's "Manage"): 14px 600 brand green, a 44px target. */
const LINK =
  "relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-sm font-semibold whitespace-nowrap text-brand-700 transition after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"

/*
 * The frame's consent banner (ConsentBanner: the analytics flag on, no choice stored yet) is fixed
 * over the foot of the screen and taller than the phone tab bar, which is all the frame reserves.
 * The banner publishes its height as --consent-h (0 while it is not shown); the room it takes
 * beyond the tab bar's pads the page's end, so the Privacy card (last in flow below the two
 * columns) ends above it, and is the scroll margin of every control here, so one focused from the
 * keyboard scrolls clear of it (WCAG 2.4.11, Focus Not Obscured).
 */
const BANNER_PAD = 'pb-[max(0px,calc(var(--consent-h,0px)_-_var(--tabbar-h)))]'
const BANNER_SCROLL = 'scroll-mb-[max(0px,calc(var(--consent-h,0px)_-_var(--tabbar-h)))]'

/** The app's words inside a topic's text. */
function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-slate-900">{children}</strong>
}

/** The topics, in the mock-up's order: a name, an icon and one fact per line. */
const TOPICS: { key: string; name: string; icon: ReactNode; lines: ReactNode[] }[] = [
  {
    key: 'months-appearance',
    name: 'Months & appearance',
    icon: <CalendarDays strokeWidth={1.8} />,
    lines: [
      <>
        The <B>month picker</B> at the top of the Dashboard, Transactions, People and Allocation: use the ‹ › arrows to
        plan any month, and those screens follow along.
      </>,
      <>
        <B>Dark mode</B> is a switch in your account menu, and the button at the top right on a computer.
      </>,
    ],
  },
  {
    key: 'transactions',
    name: 'Transactions',
    icon: <ArrowLeftRight strokeWidth={1.8} />,
    lines: [
      <>
        Log spending and assign each one to a budget line: that’s what fills <B>Spent</B>.
      </>,
      'Unassigned ones are flagged.',
      'Split one receipt across several lines.',
      'Repeat payees categorise themselves.',
    ],
  },
  {
    key: 'bills-due-dates',
    name: 'Bills & due dates',
    // A deliberate step from the mock-up, which draws lucide's `receipt` (a "$" inside): the app's
    // receipts are ReceiptText everywhere (TxRow, SpendingCard), and a dollar reads oddly in a
    // euro household.
    icon: <ReceiptText strokeWidth={1.8} />,
    lines: [
      <>
        Give a line a <B>Bill due day</B>, and AllotJar tracks what’s due or overdue.
      </>,
      // The app marks the month on screen (DashboardPage's paid toggle), which need not be the current one.
      <>
        <B>Mark paid</B> ticks it off for the month you’re viewing.
      </>,
      'Both are in the line’s ⋯ (on a phone, tap the line).',
    ],
  },
  {
    key: 'accounts',
    name: 'Accounts',
    icon: <Landmark strokeWidth={1.8} />,
    lines: [
      'Track where your money sits: set an opening balance and tag transactions to an account.',
      'Its balance is worked out as opening + income − expenses.',
    ],
  },
  {
    key: 'saving-with-jars',
    name: 'Saving with jars',
    icon: <JarNavIcon strokeWidth={1.8} />,
    lines: [
      'For big or irregular costs: car, holiday, Christmas.',
      'Give a jar a target and a date, and AllotJar works out what to set aside each month and shows it filling up.',
      // Adding a jar puts its contribution line in the Savings group itself (USER_GUIDE "Saving with jars").
      <>
        Its monthly contribution becomes a line in your <B>Savings</B> group, whose balance rolls over month to month.
      </>,
    ],
  },
  {
    key: 'reports',
    name: 'Reports',
    icon: <ChartColumn strokeWidth={1.8} />,
    lines: [
      'Income vs spending over recent months.',
      'A category breakdown for any month.',
      'An annual overview of what you earned, spent and saved.',
    ],
  },
  {
    key: 'people-allocation',
    name: 'People & allocation',
    icon: <Users strokeWidth={1.8} />,
    lines: [
      'Add the people you share money with.',
      'Pool everyone’s income, cover the shared costs, and split what’s left into each person’s savings, previewed before anything moves.',
      'On your own, it stays out of the way until you add someone.',
    ],
  },
  {
    key: 'your-account',
    name: 'Your account',
    icon: <Settings2 strokeWidth={1.8} />,
    lines: [
      <>
        The menu under your name (bottom of the sidebar; on a phone, your initials at the top) opens{' '}
        <B>Account settings</B>: your display name, currency and number format, and changing your password.
      </>,
      // Households are switched in that menu (AccountMenu), not on the Account settings page.
      'Belong to more than one household? The same menu switches between them.',
    ],
  },
  {
    key: 'good-to-know',
    name: 'Good to know',
    icon: <Lightbulb strokeWidth={1.8} />,
    lines: [
      'Edits happen in place: Enter saves, Escape cancels.',
      'Deleting a line or account never deletes its transactions.',
      'Amounts accept both “12.50” and “12,50”; every figure is exact to the cent.',
    ],
  },
]

/**
 * One topic: a row (icon | name | chevron) that opens in place to its facts. The row is a button
 * in an h3 (`aria-expanded`, `aria-controls`); the panel is kept in the DOM and hidden with the
 * `hidden` attribute while closed, as the app's other expanding rows. It is not a `region`: the
 * nine topics open independently, and nine more landmarks would crowd a screen reader's list
 * (the ARIA accordion pattern draws the line at about six).
 */
function Topic({ id, name, icon, lines }: { id: string; name: string; icon: ReactNode; lines: ReactNode[] }) {
  const [open, setOpen] = useState(false)
  const buttonId = `${id}-q`
  const panelId = `${id}-a`
  return (
    <div>
      <h3 className="text-sm">
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          // The focus ring inside the row (the `!`: the app's unlayered :focus-visible rule would
          // otherwise beat this layered utility), so it never crosses the hairlines between rows.
          className={`group grid min-h-14 w-full grid-cols-[30px_minmax(0,1fr)_20px] items-center gap-x-3 rounded-[10px] py-3 text-left focus-visible:outline-offset-[-2px]! min-[700px]:gap-x-3.5 ${BANNER_SCROLL}`}
        >
          <TxTile color={NEUTRAL}>{icon}</TxTile>
          <span className="truncate font-semibold text-slate-900 underline-offset-[3px] decoration-border group-hover:underline">
            {name}
          </span>
          <ChevronDown
            aria-hidden
            strokeWidth={1.8}
            className={`size-[18px] justify-self-end transition-transform duration-150 group-hover:text-slate-500 ${
              open ? 'rotate-180 text-slate-500' : 'text-slate-400'
            }`}
          />
        </button>
      </h3>
      <div
        id={panelId}
        hidden={!open}
        className="pr-1 pb-4 pl-[42px] min-[700px]:pr-[34px] min-[700px]:pb-[18px] min-[700px]:pl-11"
      >
        <ul className="flex max-w-[560px] flex-col gap-2.5 min-[700px]:gap-2">
          {lines.map((line, i) => (
            <li
              key={i}
              className="relative pl-4 text-sm leading-[1.55] text-slate-500 before:absolute before:top-[0.62em] before:left-0 before:size-1.5 before:rounded-full before:bg-brand-600 before:content-[''] dark:before:bg-brand-200"
            >
              {line}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * The hero's jar: decoration, in the tile's bottom-right corner. Its glass is white on the green;
 * the money inside keeps the app's emerald (the approved shots show the mock-up's jar in its
 * emerald token: the mock's source names a paler mint for it, but its jar never read that).
 */
const JAR_STYLE = {
  '--glass': 'rgb(255 255 255 / 0.16)',
  '--jar-hl': 'rgb(255 255 255 / 0.55)',
  '--jar-hl2': 'rgb(255 255 255 / 0.28)',
} as CSSProperties

export function HelpPage() {
  const { replay } = useOnboarding()
  const { available, consent, accept, decline } = useAnalytics()
  const { budgetCurrency } = useAuth()
  const noun = currencyNoun(budgetCurrency)
  const id = useId()
  const topicsHeading = `${id}-topics`
  const privacyHeading = `${id}-privacy`
  const switchName = `${id}-ga`
  const switchSub = `${id}-ga-sub`
  const granted = consent === 'granted'

  return (
    <AppShell active="help" title="Help & guide">
      {/* The one idea, in the KPI row's place and height. Named, so it is a region (not a heading:
          the page's only h1 is the top bar's). The jar's lid is the page's only gold. */}
      <KpiRow tiles={0}>
        <KpiTile
          hero
          phrase
          aria-label="Zero-based budgeting"
          label="Zero-based budgeting"
          hint={
            <>
              Allot all your income until <strong>Remaining to budget</strong> reaches zero: assign it across spending
              lines, savings and jars before the month begins. <strong>Spent</strong> fills in automatically from
              your transactions, so there’s nothing to total by hand.
            </>
          }
          value={`Give every ${noun} a job`}
          extra={
            <span aria-hidden className="pointer-events-none absolute right-5 bottom-4 @min-[640px]:right-8 @min-[640px]:bottom-5" style={JAR_STYLE}>
              {/* 64 x 84 at 72% full, as the mock draws it (56 x 74 on a phone). */}
              <GlassJar pct={72} hue="emerald" width={64} className="@max-[640px]:h-[74px] @max-[640px]:w-14" />
            </span>
          }
          className="min-h-[112px] @max-[640px]:p-[18px] [&>p+p]:max-w-[calc(100%_-_76px)]"
        />
      </KpiRow>

      <div className="@container">
        <div className={`grid gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] @min-[940px]:items-start ${BANNER_PAD}`}>
          <section
            aria-labelledby={topicsHeading}
            className={`${DASH_CARD} ${available ? '@min-[940px]:col-start-1 @min-[940px]:row-start-1' : '@min-[940px]:col-span-2'}`}
          >
            <div className="mb-1.5 flex min-h-8 items-center justify-between gap-3">
              <h2 id={topicsHeading} className={CARD_TITLE}>
                Topics
              </h2>
              <div className="-mr-1.5 flex items-center gap-1 min-[700px]:gap-2">
                {/* A real button: the welcome dialog returns focus to it when closed. Its name follows
                    its visible text: "Replay tour" on a phone, where the header is narrow. */}
                <button type="button" onClick={replay} className={LINK}>
                  <RotateCcw aria-hidden strokeWidth={1.8} className="size-[15px]" />
                  <span>
                    Replay <span className="max-[699.98px]:hidden">welcome</span> tour
                  </span>
                </button>
                <a
                  href={GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Complete user guide (opens in a new tab)"
                  onClick={() => track(EVENTS.helpGuideOpened)}
                  className={LINK}
                >
                  User guide
                  <ArrowUpRight aria-hidden strokeWidth={1.8} className="size-3.5" />
                </a>
              </div>
            </div>
            <div className="divide-y divide-line">
              {TOPICS.map((t) => (
                <Topic key={t.key} id={`${id}-${t.key}`} name={t.name} icon={t.icon} lines={t.lines} />
              ))}
            </div>
          </section>

          {available && (
            <section
              aria-labelledby={privacyHeading}
              className={`${DASH_CARD} @min-[940px]:sticky @min-[940px]:top-[92px] @min-[940px]:col-start-2 @min-[940px]:row-start-1`}
            >
              <div className="mb-1 flex min-h-8 items-center gap-1.5">
                <h2 id={privacyHeading} className={CARD_TITLE}>
                  Privacy
                </h2>
                {/* Placed against the screen: on a phone this card is the last thing on the page, so
                    the popover opens above the icon when the tab bar leaves no room below it. */}
                <InfoHint label="About privacy" buttonClassName={`${TITLE_HINT} ${BANNER_SCROLL}`} fixed>
                  We use Google Analytics to understand how AllotJar is used, so we can improve it. We never send your
                  name, email, account or category names, or any amounts: only anonymous page views and feature-usage
                  events. You can change this at any time.
                </InfoHint>
              </div>
              {/* The row is the switch (as the account menu's Dark mode row): on while consent is
                  granted; off while declined, and off with "Not chosen yet" while undecided. */}
              <button
                type="button"
                role="switch"
                aria-checked={granted}
                aria-labelledby={switchName}
                aria-describedby={consent === null ? switchSub : undefined}
                onClick={granted ? decline : accept}
                className={`flex min-h-14 w-full items-center gap-3.5 rounded-[10px] text-left text-sm ${BANNER_SCROLL}`}
              >
                <TxTile color={NEUTRAL}>
                  <ChartColumn strokeWidth={1.8} />
                </TxTile>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span id={switchName} className="font-semibold text-slate-900">
                    Google Analytics
                  </span>
                  {consent === null && (
                    <span id={switchSub} className="text-[13px] text-slate-500">
                      Not chosen yet
                    </span>
                  )}
                </span>
                <SwitchTrack on={granted} />
              </button>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  )
}
