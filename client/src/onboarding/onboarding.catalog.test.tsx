// Catalog-driven Onboarding tests (docs/testing/cases/05-onboarding.md, prefix ONBD).
// Converts the high-value P1 (plus a few cheap P2/P3) cases whose Automated field is No/Partial
// and whose behaviour is observable in a jsdom component render: the exact welcome copy branches
// (owner vs joined member), the three skip paths (Close X, backdrop, Escape) + focus restore,
// linear Back/Next tour navigation, Skip-tour / Escape ending the tour, the missing-anchor
// centred-card fallback, the getting-started checklist's auto-detected progress (0/5, 1/5 with the
// PR #172 zero-income guard, 2/5 sample-start, 5/5 all-done), live up-tick / down-tick on route
// refresh (no stuck high-water mark), collapse-vs-dismiss, owner-only visibility, replay from Help,
// currency-noun threading, and malformed/partial persistence records degrading to defaults.
//
// New file — does NOT touch onboarding/Onboarding.test.tsx. Conventions (the shared api mock,
// MemoryRouter + AuthProvider + OnboardingProvider, jest-dom matchers, per-test GET fixtures)
// mirror the existing onboarding + page catalog tests.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { BudgetCategoryDto, BudgetItemDto, BudgetMonthDto, BudgetMonthSummaryDto, HouseholdSummary } from '../types'

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    // Belt-and-braces: keep AuthProvider's on-focus revalidation inert under test so a dispatched
    // focus/route change never triggers a real /auth/refresh network call.
    isAccessTokenExpired: () => false,
  }),
)

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { OnboardingProvider, useOnboarding } from './OnboardingContext'
import { Onboarding } from './Onboarding'

// --- DTO builders -----------------------------------------------------------
function bItem(over: Partial<BudgetItemDto> = {}): BudgetItemDto {
  return {
    id: 'i1', name: 'Line', displayOrder: 0, plannedAmount: 0, actualAmount: 0,
    remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false, ...over,
  }
}
function bCat(over: Partial<BudgetCategoryDto> = {}): BudgetCategoryDto {
  return { id: 'c1', name: 'Group', kind: 'Expense', displayOrder: 0, totalPlanned: 0, totalActual: 0, items: [], ...over }
}
function bMonth(over: Partial<BudgetMonthDto> = {}): BudgetMonthDto {
  return {
    id: 'm1', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR',
    totalIncome: 0, totalPlanned: 0, remainingToBudget: 0, isBalanced: false, categories: [], ...over,
  }
}
function summary(over: Partial<BudgetMonthSummaryDto> = {}): BudgetMonthSummaryDto {
  return { year: 2026, month: 7, key: '2026-07', ...over }
}
function household(over: Partial<HouseholdSummary> = {}): HouseholdSummary {
  return { ownerId: 'own', label: 'Home', role: 0, isActive: true, isOwn: true, ...over }
}

// A month with income > 0 that is exactly balanced (remaining === 0).
const BALANCED_MONTH = bMonth({
  totalIncome: 3000, totalPlanned: 3000, remainingToBudget: 0, isBalanced: true,
  categories: [
    bCat({ id: 'inc', name: 'Income', kind: 'Income', items: [bItem({ id: 'pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
    bCat({ id: 'hou', name: 'Housing', kind: 'Expense', items: [bItem({ id: 'rent', name: 'Rent', plannedAmount: 3000 })] }),
  ],
})
// The PR #170 sample seed: income 3,000 over 2,200 planned, deliberately leaving 800 to assign.
const SAMPLE_MONTH = bMonth({
  totalIncome: 3000, totalPlanned: 2200, remainingToBudget: 800,
  categories: [
    bCat({ id: 'inc', name: 'Income', kind: 'Income', items: [bItem({ id: 'pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
    bCat({ id: 'hou', name: 'Housing', kind: 'Expense', items: [bItem({ id: 'rent', name: 'Rent', plannedAmount: 2200 })] }),
  ],
})
// Income group present but nothing earned or planned: totalIncome 0, remaining 0 (PR #172 guard case).
const ZERO_INCOME_MONTH = bMonth({
  categories: [bCat({ id: 'inc', name: 'Income', kind: 'Income', items: [bItem({ id: 'pay', name: 'Take-home Pay', plannedAmount: 0 })] })],
})

// --- GET fixtures the mock reads (reset each test) --------------------------
let monthsData: BudgetMonthSummaryDto[] = []
let currentMonth: BudgetMonthDto | null = null // null → the current-month GET rejects 404
let transactionsData: unknown[] = []
let jarsData: unknown[] = []
// The signed-in login as /auth/me answers: its email keys the onboarding record (D2: nothing about
// who is signed in is read from localStorage). null → /auth/me rejects.
const ME = { userId: 'u-me', email: 'me@test.app', role: 0 }
let meData: Record<string, unknown> | null = ME

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months') return Promise.resolve({ data: monthsData })
    if (url === '/transactions') return Promise.resolve({ data: transactionsData })
    if (url === '/jars') return Promise.resolve({ data: jarsData })
    if (url === '/auth/me') {
      return meData ? Promise.resolve({ data: meData }) : Promise.reject({ response: { status: 401 } })
    }
    if (url.startsWith('/budget/')) {
      // /budget/{year}/{month} — the checklist's current-month probe.
      return currentMonth ? Promise.resolve({ data: currentMonth }) : Promise.reject({ response: { status: 404 } })
    }
    return Promise.resolve({ data: {} })
  })
}

function renderOnboarding(extra?: ReactNode) {
  return renderWithProviders(
    <OnboardingProvider>
      {extra}
      <Onboarding />
    </OnboardingProvider>,
  )
}

// Mirrors HelpPage's real wiring: a button bound to useOnboarding().replay().
function ReplayTrigger() {
  const { replay } = useOnboarding()
  return (
    <button type="button" onClick={replay}>
      Replay welcome tour
    </button>
  )
}

const KEY = 'zbb.onboarding:u-me'

/** Opens an (i) (focus shows its popover, as a keyboard user reaches it) and returns the popover. */
async function openHint(scope: HTMLElement, label: string) {
  act(() => within(scope).getByRole('button', { name: label }).focus())
  return screen.findByRole('tooltip')
}
const readRecord = () => JSON.parse(localStorage.getItem(KEY) || '{}')

describe('Onboarding — catalog (ONBD)', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
    mockPut.mockResolvedValue({ data: {} })
    mockDelete.mockResolvedValue({ data: {} })
    monthsData = []
    currentMonth = null
    transactionsData = []
    jarsData = []
    meData = ME
    setupGet()
  })

  // ONBD-001 — the welcome auto-opens with the exact OWNER copy, bullets, controls, dialog role,
  // and nothing persisted until an action is taken. Restyle PR 19: one sentence (the budget currency's noun, as
  // the landing page), and the three bullets behind the title's (i) in two sentences.
  it('ONBD-001: welcome auto-opens with owner copy, bullets, controls and nothing persisted yet', { timeout: 15000 }, async () => {
    renderOnboarding()

    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('heading', { name: 'Welcome to AllotJar' })).toBeInTheDocument()

    // Owner body branch speaks the default euro noun; the joined branch is absent. The line describes the dialog.
    const line = within(dialog).getByText('A budget that gives every euro a job.')
    expect(dialog).toHaveAttribute('aria-describedby', line.id)
    expect(screen.queryByText(/joined a shared household budget/)).not.toBeInTheDocument()

    // The three owner bullets, behind the (i).
    const about = await openHint(dialog, 'About AllotJar')
    expect(about).toHaveTextContent('Plan a month and assign your income')
    expect(about).toHaveTextContent(/track real spending against each line/i)
    expect(about).toHaveTextContent('Save toward goals with jars')

    // Controls: secondary skip, primary tour, and the top-right close.
    expect(within(dialog).getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Take the tour' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()

    // Nothing is written until the user acts on it.
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  // ONBD-005 — an invite-created user viewing a joined household gets the member copy + bullets.
  it('ONBD-005: invite-created user sees the joined-member welcome copy and bullets', { timeout: 15000 }, async () => {
    meData = { userId: 'u-me', email: 'me@test.app', role: 0, ownerId: 'inviter', preferredCurrency: 'EUR', numberFormat: 'comma-dot',
      households: [household({ ownerId: 'inviter', label: 'Shared', isActive: true, isOwn: false })] }

    renderOnboarding()

    // The joined branch appears once /auth/me resolves the (non-own) active household.
    await screen.findByText(/joined a shared household budget/, {}, { timeout: 5000 })
    expect(screen.getByRole('heading', { name: 'Welcome to AllotJar' })).toBeInTheDocument()
    // Member bullets replace the owner set, behind the (i).
    const about = await openHint(screen.getByRole('dialog'), 'About AllotJar')
    expect(about).toHaveTextContent(/See the month.s plan and where money goes/)
    expect(about).toHaveTextContent(/record spending as it happens/i)
    expect(about).toHaveTextContent('Watch jars fill toward shared goals')
    // The owner-only bullet is gone.
    expect(about).not.toHaveTextContent('Plan a month and assign your income')
  })

  // ONBD-003 — Close X, backdrop click and Escape each behave like "Skip for now": dialog closes,
  // checklist appears, welcomeSeen persists true while tourDone stays false.
  it('ONBD-003: Close X, backdrop click and Escape each skip the welcome and reveal the checklist', { timeout: 15000 }, async () => {
    const dismissals: Array<(dialog: HTMLElement) => void> = [
      (dialog) => fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })),
      (dialog) => fireEvent.click(dialog.previousElementSibling as Element), // the dimmed backdrop
      (dialog) => fireEvent.keyDown(dialog, { key: 'Escape' }),
    ]

    for (const dismiss of dismissals) {
      const { unmount } = renderOnboarding()
      const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
      dismiss(dialog)

      expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument()
      const rec = readRecord()
      expect(rec.welcomeSeen).toBe(true)
      expect(rec.tourDone).toBe(false)

      unmount()
      localStorage.removeItem(KEY)
    }
  })

  // ONBD-003 (focus restore) — closing the welcome returns focus to the element focused before it
  // opened (useDialogA11y restore). Driven via the Help "Replay welcome tour" entry so a real
  // pre-focus element exists.
  it('ONBD-003: closing the welcome restores focus to the triggering control', { timeout: 15000 }, async () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true }))
    renderOnboarding(<ReplayTrigger />)

    const trigger = screen.getByRole('button', { name: 'Replay welcome tour' })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(document.activeElement).toBe(trigger), { timeout: 5000 })
  })

  // ONBD-008 — tour navigation is linear and clamped: no Back on step 1, Back from step 2, Finish
  // (not Next) on the last step, with a "Step n of 9" counter.
  it('ONBD-008: Back/Next tour navigation is linear and clamped; Back hidden on step 1', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }, { timeout: 5000 }))

    // Step 1: no Back, Next + Skip present, counter reads 9 total.
    expect(await screen.findByRole('heading', { name: 'Find your way around' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeInTheDocument()

    // Next → step 2, Back now available; Back → step 1 renders identically (no Back again).
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: /Pick the month/ }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 9')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Find your way around' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()

    // Advance to the last step: the primary becomes Finish and there is no Next past it.
    let guard = 20
    while (screen.queryByRole('button', { name: 'Next' }) && guard-- > 0) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }
    expect(await screen.findByRole('heading', { name: /You're all set/ }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Step 9 of 9')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
  })

  // ONBD-009 — "Skip tour" mid-way ends the tour, reveals the checklist and marks tourDone true
  // (there is deliberately no resume-at-step-N state).
  it('ONBD-009: Skip tour ends the tour cleanly and persists tourDone', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }, { timeout: 5000 }))
    // Step forward a few steps first — skipping from mid-way, not step 1.
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))

    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
    const rec = readRecord()
    expect(rec.welcomeSeen).toBe(true)
    expect(rec.tourDone).toBe(true)
  })

  // ONBD-010 — Escape ends the tour from any step, identical to Skip tour.
  it('ONBD-010: Escape ends the tour and persists tourDone', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }, { timeout: 5000 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
    expect(readRecord().tourDone).toBe(true)
  })

  // ONBD-011 — a step whose anchor is missing/off-screen degrades to a centred card (no spotlight
  // ring); a present, on-screen anchor spotlights with a ring cut-out. The tour stays 9 steps.
  it('ONBD-011: missing anchor falls back to a centred card; a present anchor spotlights', { timeout: 15000 }, async () => {
    const { container } = renderOnboarding(<div data-tour="sidebar">Sidebar</div>)
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }, { timeout: 5000 }))
    await screen.findByRole('heading', { name: 'Find your way around' }, { timeout: 5000 })

    // In jsdom the anchor's rect is all-zeros → off-screen → centred card, no spotlight ring.
    expect(container.querySelector('.ring-2')).toBeNull()

    // Give the anchor a real on-screen rect and force a re-measure (resize) → the ring appears.
    const anchor = document.querySelector('[data-tour="sidebar"]') as HTMLElement
    anchor.getBoundingClientRect = () =>
      ({ top: 80, left: 40, width: 200, height: 300, bottom: 380, right: 240, x: 40, y: 80, toJSON() {} }) as DOMRect
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(container.querySelector('.ring-2')).not.toBeNull(), { timeout: 5000 })

    // Still the same single tour dialog — the step count never changed.
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument()
  })

  // ONBD-014 — the initial checklist for an empty account: 0 of 5, exact steps/hints/links, a
  // 0-valued progressbar, both header buttons, and nothing ticked. Restyle PR 19: the hints that sat
  // under every row are one (i) on the title.
  it('ONBD-014: empty-account checklist renders 0 of 5 with exact steps, hints, links and progressbar', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })

    expect(within(region).getByText('Getting started')).toBeInTheDocument()
    expect(within(region).getByText('0 of 5 done')).toBeInTheDocument()

    const bar = within(region).getByRole('progressbar', { name: 'Onboarding progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '5')

    // Step labels, verbatim; the hints behind the (i).
    expect(within(region).getByText('Create your first month')).toBeInTheDocument()
    expect(within(region).getByText('Plan your income')).toBeInTheDocument()
    expect(within(region).getByText('Add a jar')).toBeInTheDocument()
    expect(within(region).getByText('Give every euro a job')).toBeInTheDocument()
    expect(within(region).getByText('Log your first transaction')).toBeInTheDocument()
    const about = await openHint(region, 'About getting started')
    expect(about).toHaveTextContent(/Start a month blank or from a template/)
    expect(about).toHaveTextContent(/add your income and a jar/)
    expect(about).toHaveTextContent(/assign it all until Remaining to budget reads zero/)
    expect(about).toHaveTextContent(/log your spending/)

    // Links: month/income/balance → "/", jar → "/jars", transaction → "/transactions".
    expect(within(region).getByText('Create your first month').closest('a')).toHaveAttribute('href', '/')
    expect(within(region).getByText('Add a jar').closest('a')).toHaveAttribute('href', '/jars')
    expect(within(region).getByText('Log your first transaction').closest('a')).toHaveAttribute('href', '/transactions')

    // Header controls + all steps unticked ("To do:" x5, no "Done:", each row named as to do).
    expect(within(region).getByRole('button', { name: 'Collapse getting started' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Dismiss getting started' })).toBeInTheDocument()
    expect(within(region).getAllByText('To do:')).toHaveLength(5)
    expect(within(region).queryByText('Done:')).not.toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Give every euro a job' })).toBeInTheDocument()
  })

  // ONBD-016 — PR #172 guard: a zero-income month with remaining exactly 0 must NOT tick "Give
  // every euro a job" (nor "Plan your income"); only "Create your first month" ticks → 1 of 5.
  it('ONBD-016: a zero-income month never ticks "Give every euro a job" (1 of 5)', { timeout: 15000 }, async () => {
    monthsData = [summary()]
    currentMonth = ZERO_INCOME_MONTH
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })

    await within(region).findByText('1 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '1')
    // Month created ✓, but income + balance stay unticked despite remaining === 0.
    expect(within(region).getByRole('link', { name: 'Done: Create your first month' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Plan your income' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Give every euro a job' })).toBeInTheDocument()
  })

  // ONBD-029 — the opted-in sample start pre-ticks exactly 2 of 5: month ✓, income ✓, balance ✗
  // (remaining 800 ≠ 0), transaction ✗.
  it('ONBD-029: sample-budget start pre-ticks exactly 2 of 5', { timeout: 15000 }, async () => {
    monthsData = [summary()]
    currentMonth = SAMPLE_MONTH
    transactionsData = []
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })

    await within(region).findByText('2 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '2')
    expect(within(region).getByRole('link', { name: 'Done: Create your first month' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'Done: Plan your income' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Give every euro a job' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Log your first transaction' })).toBeInTheDocument()
    expect(within(region).queryByText(/has a job\./)).not.toBeInTheDocument()
  })

  // ONBD-015 (end state) — a fully-built month reads 5 of 5 with every step ticked, a full
  // progressbar and the all-done line + a quiet "Dismiss" (restyle PR 19: no emoji).
  it('ONBD-015: a complete budget reads 5 of 5 with the all-done footer', { timeout: 15000 }, async () => {
    monthsData = [summary()]
    currentMonth = BALANCED_MONTH
    transactionsData = [{ id: 't1' }]
    jarsData = [{ id: 'j1' }]
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })

    await within(region).findByText('5 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '5')
    expect(within(region).getAllByText('Done:')).toHaveLength(5)
    expect(within(region).getByText('Every euro has a job.')).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  // ONBD-019 — progress refreshes on route change: a step ticks up without a reload once the
  // underlying data lands (previous state kept until then).
  it('ONBD-019: progress ticks up on route-change refresh without a reload', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })
    await within(region).findByText('0 of 5 done', {}, { timeout: 5000 })

    // The user built the month in another tab; the next route change re-polls.
    monthsData = [summary()]
    currentMonth = BALANCED_MONTH
    transactionsData = [{ id: 't1' }]
    jarsData = [{ id: 'j1' }]
    fireEvent.click(within(region).getByText('Log your first transaction')) // Link → "/transactions" route change

    await within(region).findByText('5 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '5')
  })

  // ONBD-031 — the checklist is a pure live recompute, not a high-water mark: tearing the budget
  // back down un-ticks steps and removes the all-done footer, settling at 1 of 5 (the month still
  // exists), with the PR #172 guard keeping "Give every euro a job" un-ticked at zero income.
  it('ONBD-031: checklist down-ticks from 5/5 to 1/5 when data is removed (no stuck high-water mark)', { timeout: 15000 }, async () => {
    monthsData = [summary()]
    currentMonth = BALANCED_MONTH
    transactionsData = [{ id: 't1' }]
    jarsData = [{ id: 'j1' }]
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })
    await within(region).findByText('5 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByText('Every euro has a job.')).toBeInTheDocument()

    // Teardown: transactions gone and the month back to zero income (the month itself still exists).
    transactionsData = []
    jarsData = []
    currentMonth = ZERO_INCOME_MONTH
    fireEvent.click(within(region).getByText('Log your first transaction')) // route change → refresh

    await within(region).findByText('1 of 5 done', {}, { timeout: 5000 })
    expect(within(region).getByRole('progressbar', { name: 'Onboarding progress' })).toHaveAttribute('aria-valuenow', '1')
    expect(within(region).getByRole('link', { name: 'Done: Create your first month' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'To do: Give every euro a job' })).toBeInTheDocument()
    expect(within(region).queryByText(/has a job\./)).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  // ONBD-018 — Collapse is session-only (component-local), not the persisted Dismiss: the panel
  // collapses to a pill and expands back, without writing checklistDismissed.
  it('ONBD-018: collapse folds to a pill and expands back without persisting a dismiss', { timeout: 15000 }, async () => {
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })
    await within(region).findByText('0 of 5 done', {}, { timeout: 5000 })

    fireEvent.click(within(region).getByRole('button', { name: 'Collapse getting started' }))
    // Panel gone, replaced by a "Getting started" pill with a "0 of 5" chip (restyle PR 19).
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument(), { timeout: 5000 })
    const pill = screen.getByRole('button', { name: /Getting started/ })
    expect(pill).toHaveTextContent('0 of 5')
    // Collapse is NOT a dismiss — nothing persisted it.
    expect(readRecord().checklistDismissed).not.toBe(true)

    fireEvent.click(pill)
    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
  })

  // ONBD-021 — the checklist renders only for the user's OWN household: a joined (non-own) active
  // household suppresses it entirely (absent from the DOM), while an own household shows it.
  it('ONBD-021: checklist is hidden for a joined household and shown for the own one', { timeout: 15000 }, async () => {
    // Joined household → no checklist anywhere.
    meData = { userId: 'u-me', email: 'me@test.app', role: 0, ownerId: 'inviter', preferredCurrency: 'EUR', numberFormat: 'comma-dot',
      households: [household({ ownerId: 'inviter', label: 'Shared', isActive: true, isOwn: false })] }
    const joined = renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    await waitFor(
      () => expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    joined.unmount()
    localStorage.removeItem(KEY)

    // Own household → checklist present.
    meData = { userId: 'u-me', email: 'me@test.app', role: 0, ownerId: 'own', preferredCurrency: 'EUR', numberFormat: 'comma-dot',
      households: [household({ ownerId: 'own', label: 'Mine', isActive: true, isOwn: true })] }
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
  })

  // ONBD-027 — replay from Help re-opens the welcome, restores the checklist and resets the record
  // to {welcomeSeen:true, tourDone:false, checklistDismissed:false} WITHOUT re-arming auto-open on
  // the next mount.
  it('ONBD-027: replay re-runs the flow but never re-arms first-run auto-open', { timeout: 15000 }, async () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true }))
    const { unmount } = renderOnboarding(<ReplayTrigger />)
    // The record is the signed-in login's: wait for /auth/me to say who that is (D2).
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'), { timeout: 5000 })
    await act(async () => {})

    // Fully-onboarded + dismissed: nothing auto-opens.
    expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument()

    // Replay → welcome reopens and the record is reset (but welcomeSeen stays true).
    fireEvent.click(screen.getByRole('button', { name: 'Replay welcome tour' }))
    expect(await screen.findByRole('heading', { name: 'Welcome to AllotJar' }, { timeout: 5000 })).toBeInTheDocument()
    const rec = readRecord()
    expect(rec).toMatchObject({ welcomeSeen: true, tourDone: false, checklistDismissed: false })

    // Skipping brings the checklist back (dismissed was cleared by the replay).
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()

    // Re-mount (a reload): welcomeSeen is still true → nothing auto-opens.
    unmount()
    renderOnboarding(<ReplayTrigger />)
    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
  })

  // ONBD-004 — the currency noun threads through the welcome line, tour step 3, checklist step 3
  // and the all-done line (USD → "dollar").
  it('ONBD-004: the currency noun (USD → "dollar") threads through welcome, tour, checklist and all-done', { timeout: 15000 }, async () => {
    localStorage.setItem('zbb.currency', 'USD')
    meData = { ...ME, preferredCurrency: 'USD' }
    monthsData = [summary()]
    currentMonth = BALANCED_MONTH
    transactionsData = [{ id: 't1' }]
    jarsData = [{ id: 'j1' }]
    renderOnboarding()

    // The welcome line uses the dollar noun.
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(within(dialog).getByText('A budget that gives every dollar a job.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/euro/)).not.toBeInTheDocument()

    // Tour step 3 title uses the dollar noun.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take the tour' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    expect(await screen.findByRole('heading', { name: 'Give every dollar a job' }, { timeout: 5000 })).toBeInTheDocument()

    // End the tour → checklist step 3 label + all-done line both use the dollar noun.
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })
    expect(within(region).getByText('Give every dollar a job')).toBeInTheDocument()
    expect(await within(region).findByText('Every dollar has a job.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // ONBD-004 (fallback) — an unknown/blank preferred currency falls back to the neutral "unit"
  // noun — no crash, no empty string — in the welcome line and on tour step 3.
  it('ONBD-004: an unknown currency falls back to the "unit" noun', { timeout: 15000 }, async () => {
    localStorage.setItem('zbb.currency', 'XYZ')
    meData = { ...ME, preferredCurrency: 'XYZ' }
    renderOnboarding()
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(within(dialog).getByText('A budget that gives every unit a job.')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take the tour' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }, { timeout: 5000 }))
    expect(await screen.findByRole('heading', { name: 'Give every unit a job' }, { timeout: 5000 })).toBeInTheDocument()
  })

  // ONBD-025 (A) — an unparseable onboarding record is swallowed and defaults apply (welcome opens).
  it('ONBD-025: a malformed persistence record degrades to defaults and auto-opens the welcome', { timeout: 15000 }, async () => {
    localStorage.setItem(KEY, 'not-json{{{')
    renderOnboarding()
    expect(await screen.findByRole('heading', { name: 'Welcome to AllotJar' }, { timeout: 5000 })).toBeInTheDocument()
  })

  // ONBD-025 (B) — a partial record merges with defaults: welcomeSeen:true keeps the welcome closed
  // while the missing checklistDismissed defaults false, so the checklist shows.
  it('ONBD-025: a partial persistence record merges with defaults (welcome closed, checklist shown)', { timeout: 15000 }, async () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, welcomeSeen: true }))
    renderOnboarding()
    expect(await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument()
  })

  // ONBD-022 — checklist polling failures are silent and safe: every probe rejecting still renders
  // the panel at 0 of 5 with no crash or error UI.
  it('ONBD-022: checklist polling failures render 0 of 5 without crashing', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: ME })
      return Promise.reject({ response: { status: 500 } }) // months / current-month / transactions all fail
    })
    renderOnboarding()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }, { timeout: 5000 }))
    const region = await screen.findByRole('region', { name: 'Getting started' }, { timeout: 5000 })
    expect(within(region).getByText('0 of 5 done')).toBeInTheDocument()
  })
})
