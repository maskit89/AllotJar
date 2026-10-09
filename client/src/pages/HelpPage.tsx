import type { ReactNode } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, Card, PageHeader } from '../components/ui'
import { useOnboarding } from '../onboarding/OnboardingContext'
import { EVENTS, track } from '../analytics'
import { useAnalytics } from '../analytics/AnalyticsProvider'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { hueColor, hueForIndex, hueTint } from '../lib/categoryColors'

const GUIDE_URL = 'https://github.com/maskit89/AllotJar/blob/main/docs/USER_GUIDE.md'

/** A topic card — a hue-tinted icon tile, a title, and a short explanation. */
function HelpCard({
  hueIndex,
  title,
  children,
  className = '',
}: {
  hueIndex: number
  title: string
  children: ReactNode
  className?: string
}) {
  const hue = hueForIndex(hueIndex)
  return (
    <Card as="section" className={`p-5 ${className}`}>
      <div
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl"
        style={{ background: hueTint(hue) }}
        aria-hidden
      >
        <span className="h-4 w-4 rounded-md" style={{ background: hueColor(hue) }} />
      </div>
      <h2 className="text-[15px] font-bold tracking-[-0.01em] text-slate-900">{title}</h2>
      <div className="mt-1 space-y-1.5 text-sm leading-relaxed text-slate-600">{children}</div>
    </Card>
  )
}

export function HelpPage() {
  const { replay } = useOnboarding()
  const { available, consent, accept, decline } = useAnalytics()
  const { budgetCurrency } = useAuth()
  const noun = currencyNoun(budgetCurrency)
  return (
    <AppShell active="help" title="Help & guide">
      <PageHeader
        subtitle="How each part of AllotJar works."
        actions={
          <Button variant="secondary" size="sm" onClick={replay}>
            Replay welcome tour
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <HelpCard hueIndex={0} title="Zero-based budgeting">
          <p>
            Give every {noun} a job until <strong>Remaining to budget</strong> reaches{' '}
            <strong>zero</strong> — assign all your income across spending lines, savings and jars before the
            month begins. <strong>Spent</strong> fills in automatically from your transactions, so there's
            nothing to total by hand.
          </p>
        </HelpCard>

        <HelpCard hueIndex={1} title="Months & appearance">
          <p>
            The <strong>month picker</strong> at the top of the Dashboard, Transactions, People and Allocation —
            use the ‹ › arrows to plan any month, and those screens follow along. <strong>Dark mode</strong> is a
            switch in your account menu, and the button at the top right on a computer.
          </p>
        </HelpCard>

        <HelpCard hueIndex={2} title="Transactions">
          <p>
            Log spending and assign each one to a budget line — that's what fills the <strong>Spent</strong>{' '}
            column. Unassigned items are flagged, you can split one receipt across several lines, and repeat
            payees categorise themselves.
          </p>
        </HelpCard>

        <HelpCard hueIndex={3} title="Bills & due dates">
          <p>
            Flag a line as a bill with a due day and AllotJar tracks what's due or overdue, with a Paid
            checkbox for the current month.
          </p>
        </HelpCard>

        <HelpCard hueIndex={4} title="Accounts">
          <p>
            Track where your money sits: set an opening balance and tag transactions to an account, and its
            balance is derived as opening + income − expenses.
          </p>
        </HelpCard>

        <HelpCard hueIndex={0} title="Saving with jars">
          <p>
            Jars are for big or irregular costs — car, holiday, Christmas. Give a jar a target and a date and
            we work out what to set aside each month and show it filling up. Budget that monthly amount in your{' '}
            <strong>Savings</strong> group, whose balance rolls over month to month.
          </p>
        </HelpCard>

        <HelpCard hueIndex={1} title="Reports">
          <p>
            See income vs spending over recent months, a category breakdown for any month, and an annual
            overview of what you earned, spent and saved.
          </p>
        </HelpCard>

        <HelpCard hueIndex={2} title="People & allocation">
          <p>
            Add the people you share money with, then pool everyone's income, cover the shared costs, and split
            what's left into each person's savings — previewed before anything moves. On your own, it stays out
            of the way until you add someone.
          </p>
        </HelpCard>

        <HelpCard hueIndex={3} title="Your account">
          <p>
            Open the menu under your name (bottom of the sidebar; on a phone, your initials at the top) for{' '}
            <strong>Account settings</strong> — your
            display name, currency and number format, and changing your password. If you belong to
            more than one household, switch between them there too.
          </p>
        </HelpCard>

        <HelpCard hueIndex={4} title="Good to know">
          <ul className="ml-4 list-disc space-y-1">
            <li>Inline editing everywhere: click, type, Enter to save, Escape to cancel.</li>
            <li>Deleting a line or account never deletes its transactions.</li>
            <li>Amounts accept both “12.50” and “12,50”; every figure is exact to the cent.</li>
            <li>
              For the full manual, see the{' '}
              <a
                href={GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => track(EVENTS.helpGuideOpened)}
                className="font-medium text-brand-600 hover:underline dark:text-emerald-400"
              >
                complete user guide
              </a>
              .
            </li>
          </ul>
        </HelpCard>

        {available && (
          <HelpCard hueIndex={3} title="Privacy & analytics" className="sm:col-span-2">
            <p>
              We use <strong>Google Analytics</strong> to understand how AllotJar is used so we can improve it.
              We never send your name, email, account or category names, or any amounts — only anonymous page
              views and feature-usage events.
            </p>
            <p>
              Status:{' '}
              <strong>
                {consent === 'granted'
                  ? 'Analytics is on'
                  : consent === 'denied'
                    ? 'Analytics is off'
                    : 'Not chosen yet'}
              </strong>
              . You can change this at any time.
            </p>
            <div className="pt-1">
              {consent === 'granted' ? (
                <Button variant="secondary" size="sm" onClick={decline}>
                  Turn off analytics
                </Button>
              ) : (
                <Button size="sm" onClick={accept}>
                  Turn on analytics
                </Button>
              )}
            </div>
          </HelpCard>
        )}
      </div>
    </AppShell>
  )
}
