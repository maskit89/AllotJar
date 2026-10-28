import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { BudgetMonthDto, BudgetTemplateDto, JarDto } from '../types'

// Same shared api mock as DashboardPage.test.tsx.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { menuItems } from '../test/rowMenu'
import userEvent from '@testing-library/user-event'
import { DashboardPage } from './DashboardPage'
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format,
// independent of test-execution order.
import { setMoneyFormat } from '../lib/money'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

// --- Fixtures ---------------------------------------------------------------
// The page recomputes every total from `categories` (budgetModel selectors), so
// the DTO-level totals/isBalanced are cosmetic here — only the category tree drives
// the render. Each builder returns a fresh object so tests never share mutable state.

// JUL26 canonical fixture: Income 3,000 (Take-home Pay 2,600 received of 2,600
// planned + Freelance 400), Housing (Rent 1,100 bill day 1, Utilities 180 bill
// day 20), Food (Groceries 400/250, Restaurants 90 planned/120 spent = overspent),
// Savings (Holiday 150 planned, 0 spent, 450 rolled-over available).
// Allotted = 1,920 · Income = 3,000 · Remaining = 1,080.
function jul26(): BudgetMonthDto {
  return budgetMonth({
    categories: [
      budgetCategory({
        id: 'inc', name: 'Income', kind: 'Income',
        items: [
          budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 2600, actualAmount: 2600 }),
          budgetItem({ id: 'i-free', name: 'Freelance', displayOrder: 1, plannedAmount: 400 }),
        ],
      }),
      budgetCategory({
        id: 'c-housing', name: 'Housing',
        items: [
          budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1100, dueDay: 1 }),
          budgetItem({ id: 'i-util', name: 'Utilities', displayOrder: 1, plannedAmount: 180, dueDay: 20 }),
        ],
      }),
      budgetCategory({
        id: 'c-food', name: 'Food', displayOrder: 1,
        items: [
          budgetItem({ id: 'i-groc', name: 'Groceries', plannedAmount: 400, actualAmount: 250 }),
          budgetItem({ id: 'i-rest', name: 'Restaurants', displayOrder: 1, plannedAmount: 90, actualAmount: 120 }),
        ],
      }),
      budgetCategory({
        id: 'c-sav', name: 'Savings', kind: 'Savings',
        items: [budgetItem({ id: 'i-holiday', name: 'Holiday', plannedAmount: 150, savingsId: 'jar-holiday', savingsAvailable: 450 })],
      }),
    ],
  })
}

// A balanced month: income 3,000 planned entirely against one expense line → remaining 0.
function balancedMonth(baseCurrency = 'EUR'): BudgetMonthDto {
  return budgetMonth({
    baseCurrency,
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000, actualAmount: 3000 })] }),
      budgetCategory({ id: 'c-housing', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 3000 })] }),
    ],
  })
}

// A truly empty month: an Income group with no lines, nothing planned. Remaining €0
// but nothing budgeted — the plan-your-income prompt, never the balanced badge.
function emptyMonth(baseCurrency = 'EUR'): BudgetMonthDto {
  return budgetMonth({
    baseCurrency,
    categories: [budgetCategory({ id: 'inc', name: 'Income', kind: 'Income' })],
  })
}

// Income 0 but with a planned expense line — over-budgeted, NOT the empty prompt.
function income0Planned(): BudgetMonthDto {
  return budgetMonth({
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income' }),
      budgetCategory({ id: 'c-bills', name: 'Bills', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 500 })] }),
    ],
  })
}

function mockLoads(opts: {
  month?: BudgetMonthDto | null
  jars?: JarDto[]
  templates?: BudgetTemplateDto[]
  months?: Array<{ year: number; month: number; key: string }>
}) {
  const { month = null, jars = [], templates = [], months = [] } = opts
  mockGet.mockImplementation((url: string) => {
    if (url === '/budget/months') return Promise.resolve({ data: months })
    if (url === '/budget/templates') return Promise.resolve({ data: templates })
    if (url === '/jars') return Promise.resolve({ data: jars })
    // The month's carry (rule 94): nothing besides its income to give a job.
    if (url.endsWith('/wrap-up')) return Promise.resolve({ data: { leftOver: 0, toAllot: 0 } })
    if (/^\/budget\/\d+\/\d+$/.test(url)) {
      return month ? Promise.resolve({ data: month }) : Promise.reject({ response: { status: 404 } })
    }
    // /auth/me and anything else: a benign object (no numeric role ⇒ role stays Owner ⇒ canWrite).
    return Promise.resolve({ data: {} })
  })
}

function renderPage(today?: Date) {
  return renderWithProviders(
    today ? <DashboardPage today={today} /> : <DashboardPage />,
    { month: true },
  )
}

// a precedes b in document order
function precedes(a: Element, b: Element) {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('DashboardPage — hero footnote states (PR #172) & render', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56
  })

  it('DASH-001: renders the sections in the canonical top-to-bottom order', { timeout: 15000 }, async () => {
    mockLoads({
      month: jul26(),
      jars: [
        { id: 'jar-holiday', name: 'Holiday', kind: 0, targetAmount: 1200, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, monthOnly: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 450, plannedThisMonth: 150, contributedThisMonth: 0, remainingThisMonth: 150, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, completedOn: null, canDelete: false, skippedThisMonth: false, status: 'OnTrack' },
      ],
    })

    renderPage()

    // The KPI row (the hero, then the Bills left tile), then the Jars card (first in the page, so
    // a phone reads it before the budget; on wide screens it stands in the right-hand column), then
    // the Budget card: its header (with "+ Group"), Income, the spending groups, the Savings group.
    const eyebrow = await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    const hero = eyebrow.closest('section')!
    const billsTile = await screen.findByRole('group', { name: 'Bills left' }, { timeout: 5000 })
    const jarsShelf = screen.getByRole('heading', { name: 'Jars' })
    const budget = screen.getByRole('heading', { name: 'Budget' })
    const addGroup = screen.getByRole('button', { name: 'Add a group' })
    const incomeGroup = screen.getByRole('heading', { name: 'Income', level: 3 })
    const housing = screen.getByLabelText('Rename group Housing')
    const savings = screen.getByLabelText('Rename group Savings') // savings group name (editable input for Owner)

    expect(precedes(hero, billsTile)).toBe(true)
    expect(precedes(billsTile, jarsShelf)).toBe(true)
    expect(precedes(jarsShelf, budget)).toBe(true)
    expect(precedes(budget, addGroup)).toBe(true)
    expect(precedes(addGroup, incomeGroup)).toBe(true)
    expect(precedes(incomeGroup, housing)).toBe(true)
    expect(precedes(housing, savings)).toBe(true)
    // One Budget card holds every group (the old "Everyday spending" card is gone).
    expect(screen.queryByRole('heading', { name: 'Everyday spending' })).not.toBeInTheDocument()
    const budgetCard = screen.getByRole('region', { name: 'Budget' })
    expect(budgetCard).toContainElement(incomeGroup)
    expect(budgetCard).toContainElement(savings)

    // Housing renders before Food inside the Budget card.
    expect(precedes(screen.getByLabelText('Rename group Housing'), screen.getByLabelText('Rename group Food'))).toBe(true)

    // The one visually-hidden page heading, and no error strip.
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.queryByText(/Could not load your budget/)).not.toBeInTheDocument()
  })

  it('DASH-014: under-allotted month shows the remaining amount, what is allotted and the Income tile', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    const eyebrow = await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    const hero = eyebrow.closest('section')!

    // Gold amount + its accessible name, once the month's carry has loaded (it reads "loading"
    // until then). The remaining amount is said once, by the hero number
    // (restyle PR 3: the "€X still to assign" pill only repeated it).
    expect(await within(hero).findByLabelText('Remaining to budget: €1,080.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/still to assign/)).not.toBeInTheDocument()
    // Allotted = 1,920 (expense + savings planned, income excluded), under the hero's bar;
    // Income = 3,000 (income planned) in its own tile.
    expect(within(hero).getByText('€1,920.00 allotted')).toBeInTheDocument()
    expect(within(hero).queryByText(/over-budgeted/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Income' })).getByText('€3,000.00')).toBeInTheDocument()
    // Not balanced: no gold badge.
    expect(screen.queryByText(/has a job/)).not.toBeInTheDocument()
  })

  it('DASH-015: a balanced month shows the gold "Every euro has a job" badge, not a pill', { timeout: 15000 }, async () => {
    mockLoads({ month: balancedMonth() })
    renderPage()

    expect(await screen.findByText('Every euro has a job', {}, { timeout: 5000 })).toBeInTheDocument()
    const eyebrow = screen.getByText('Remaining to budget')
    const hero = eyebrow.closest('section')!
    expect(await within(hero).findByLabelText('Remaining to budget: €0.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/still to assign/)).not.toBeInTheDocument()
    expect(screen.queryByText(/over-budgeted/)).not.toBeInTheDocument()
  })

  it('DASH-017: income 0 with planned > 0 shows the rose over-budget pill, not the income prompt', { timeout: 15000 }, async () => {
    mockLoads({ month: income0Planned() })
    renderPage()

    // The chip says what to do; the gold number above it says by how much (never twice).
    const footnote = await screen.findByText('Over-budgeted — trim a line', {}, { timeout: 5000 })
    expect(footnote).toHaveAttribute('data-tone', 'bad')
    expect(footnote.textContent).not.toContain('500')
    // NOT the empty-month prompt and NOT the balanced badge.
    expect(screen.queryByText(/Plan your income/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has a job/)).not.toBeInTheDocument()

    const hero = screen.getByText('Remaining to budget').closest('section')!
    expect(await within(hero).findByLabelText('Remaining to budget: -€500.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Income' })).getByText('€0.00')).toBeInTheDocument()
    expect(within(hero).getByText('€500.00 allotted')).toBeInTheDocument()
  })

  it('DASH-018: an over-budgeted month shows the rose pill with the positive overrun', { timeout: 15000 }, async () => {
    // Bump Rent 1,100 → 2,300: allotted 3,120 vs income 3,000 → remaining −120.
    const m = jul26()
    m.categories[1].items[0].plannedAmount = 2300
    mockLoads({ month: m })
    renderPage()

    const footnote = await screen.findByText('Over-budgeted — trim a line', {}, { timeout: 5000 })
    expect(footnote).toHaveAttribute('data-tone', 'bad')
    const hero = screen.getByText('Remaining to budget').closest('section')!
    // The overrun is the gold amount, negative; the chip does not repeat it.
    expect(await within(hero).findByLabelText('Remaining to budget: -€120.00', {}, { timeout: 5000 })).toHaveTextContent('-€120.00')
    expect(within(hero).queryByText(/120\.00 over/)).not.toBeInTheDocument()
    expect(screen.queryByText(/still to assign/)).not.toBeInTheDocument()
  })

  it('DASH-016: an empty month prompts for income and never celebrates', { timeout: 15000 }, async () => {
    // (Complements the existing coverage by asserting the pill is neutral, not rose.)
    mockLoads({ month: emptyMonth() })
    renderPage()

    const prompt = await screen.findByText('Plan your income, then give every euro a job', {}, { timeout: 5000 })
    // A plain line on the hero, not the bad chip.
    expect(prompt).not.toHaveAttribute('data-tone')
    expect(prompt.querySelector('[data-tone="bad"]')).toBeNull()
    expect(screen.queryByText(/over-budgeted/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has a job$/)).not.toBeInTheDocument()
  })

  it('DASH-021: the balanced badge speaks the currency noun (GBP → "pound")', { timeout: 15000 }, async () => {
    mockLoads({ month: balancedMonth('GBP') })
    renderPage()
    expect(await screen.findByText('Every pound has a job', {}, { timeout: 5000 })).toBeInTheDocument()
    // GBP renders with the £ symbol in the hero.
    const hero = screen.getByText('Remaining to budget').closest('section')!
    expect(hero.textContent).toContain('£0.00')
  })

  it('DASH-021: an empty JPY month prompts "every yen" and renders 0 fraction digits', { timeout: 15000 }, async () => {
    mockLoads({ month: emptyMonth('JPY') })
    renderPage()
    expect(await screen.findByText('Plan your income, then give every yen a job', {}, { timeout: 5000 })).toBeInTheDocument()
    const hero = screen.getByText('Remaining to budget').closest('section')!
    expect(hero.textContent).toContain('¥0')
    expect(hero.textContent).not.toContain('¥0.00')
  })

  it('DASH-021: a currency outside the noun map falls back to "unit"', { timeout: 15000 }, async () => {
    mockLoads({ month: emptyMonth('ISK') })
    renderPage()
    expect(
      await screen.findByText('Plan your income, then give every unit a job', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
  })
})

describe('DashboardPage — income card & spending lines', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot')
  })

  it('DASH-031: the income header shows transaction-derived received of planned, read-only', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    // The Income tile: planned 3,000 and, under it, the transaction-derived received 2,600
    // (restyle PR 3: the Income group header shows no total; the tile carries it).
    await screen.findByRole('heading', { name: 'Income', level: 3 }, { timeout: 5000 })
    const tile = screen.getByRole('group', { name: 'Income' })
    expect(within(tile).getByText('€3,000.00')).toBeInTheDocument()
    expect(within(tile).getByText('€2,600.00 received')).toBeInTheDocument()

    // Each line says whether its income arrived: received in full, or what came in so far; no
    // edit affordance for what was received.
    const pay = screen.getByDisplayValue('Take-home Pay').closest('.group') as HTMLElement
    expect(within(pay).getByText('Received')).toHaveAttribute('data-tone', 'ok')
    const freelance = screen.getByDisplayValue('Freelance').closest('.group') as HTMLElement
    expect(within(freelance).getByText('€0.00 in')).toBeInTheDocument()
    expect(screen.queryByLabelText('Received for Take-home Pay')).not.toBeInTheDocument()
  })

  // Rule 39: a refund nets off its line in the month it arrives; the line says how much, so a
  // spent figure below the purchases reads as a refund, not a mistake.
  it('says how much was refunded against an expense line (rule 39)', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[2].items[1] = { ...m.categories[2].items[1], actualAmount: 100, remaining: -10, refundedAmount: 20 }
    mockLoads({ month: m })
    renderPage()

    const planned = await screen.findByRole('button', { name: /^Planned amount for Restaurants:/ }, { timeout: 5000 })
    expect(planned.closest('.group')!.textContent).toContain('€100.00 of €90.00')
    expect(planned.closest('.group')!.textContent).toContain('€20.00 refunded')
    // A line with nothing refunded says nothing about refunds.
    const rent = screen.getByRole('button', { name: /^Planned amount for Rent:/ })
    expect(rent.closest('.group')!.textContent).not.toContain('refunded')
  })

  it('DASH-050: overspent and zero-planned lines render rose with a clamped, never-NaN bar', { timeout: 15000 }, async () => {
    const m = jul26()
    // Zero-planned line with spend: bar must be 0%, remaining rose "-€15.00".
    m.categories[2].items.push(budgetItem({ id: 'i-coffee', name: 'Coffee', displayOrder: 2, actualAmount: 15 }))
    const { container } = (mockLoads({ month: m }), renderPage())

    // Restaurants: planned 90, spent 120 → "€30.00 over" in the bad red, "€120.00 of €90.00".
    const overRemaining = await screen.findByText('€30.00 over', {}, { timeout: 5000 })
    expect(overRemaining.className).toContain('text-bad')
    const restaurantsPlanned = screen.getByRole('button', { name: /^Planned amount for Restaurants:/ })
    expect(restaurantsPlanned).toHaveTextContent('€90.00')
    expect(restaurantsPlanned.closest('.group')!.textContent).toContain('€120.00 of €90.00')

    // Zero-planned Coffee line → "€15.00 over" in the bad red.
    expect(screen.getByText('€15.00 over').className).toContain('text-bad')

    // Every progress-bar fill (the lines', the jars' and the hero's) is a finite percentage
    // clamped to [0, 100] — no NaN, no overflow.
    const fills = Array.from(container.querySelectorAll<HTMLElement>('[style*="width"]'))
    expect(fills.length).toBeGreaterThan(0)
    for (const f of fills) {
      const pct = parseFloat(f.style.width)
      expect(Number.isFinite(pct)).toBe(true)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
  })

  it('DASH-062: funding a savings goal raises Allotted and drops Remaining instantly', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    mockPut.mockResolvedValue({ data: {} })
    renderPage()

    // Holiday planned 150 → 300: Allotted 1,920 → 2,070, Remaining 1,080 → 930.
    fireEvent.click(await screen.findByRole('button', { name: /^Planned amount for Holiday:/ }, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Holiday', {}, { timeout: 5000 })) as HTMLInputElement
    await waitFor(
      () => {
        fireEvent.change(input, { target: { value: '300' } })
        expect(input).toHaveValue('300')
      },
      { timeout: 5000 },
    )
    fireEvent.blur(input)

    const hero = screen.getByText('Remaining to budget').closest('section')!
    await waitFor(() => expect(within(hero).getByText('€2,070.00 allotted')).toBeInTheDocument(), { timeout: 5000 })
    expect(await within(hero).findByLabelText('Remaining to budget: €930.00', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday', { plannedAmount: 300, version: null }), { timeout: 5000 })
  })
})

describe('DashboardPage — planned-amount parsing in-row (parseMinor seam)', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot')
  })

  it('DASH-039: a comma-decimal edit commits the parsed amount (12,50 → 12.5)', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    mockPut.mockResolvedValue({ data: {} })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Planned amount for Groceries:/ }, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Groceries', {}, { timeout: 5000 })) as HTMLInputElement
    await waitFor(
      () => {
        fireEvent.change(input, { target: { value: '12,50' } })
        expect(input).toHaveValue('12,50')
      },
      { timeout: 5000 },
    )
    fireEvent.blur(input)

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-groc', { plannedAmount: 12.5, version: null }), { timeout: 5000 })
  })

  it('DASH-040: a rejected input reverts silently — no request, no error, no flicker', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    mockPut.mockResolvedValue({ data: {} })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Planned amount for Groceries:/ }, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Groceries', {}, { timeout: 5000 })) as HTMLInputElement
    await waitFor(
      () => {
        fireEvent.change(input, { target: { value: 'abc' } })
        expect(input).toHaveValue('abc')
      },
      { timeout: 5000 },
    )
    fireEvent.blur(input)

    // Editor closes back to the formatted at-rest value; no PUT and no error strip.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /^Planned amount for Groceries:/ })).toHaveTextContent('€400.00'),
      { timeout: 5000 },
    )
    expect(mockPut).not.toHaveBeenCalled()
    expect(screen.queryByText(/reverted/)).not.toBeInTheDocument()
  })
})

describe('DashboardPage — bills strip summary & tones', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot')
  })

  const TODAY = new Date(2026, 6, 15) // 2026-07-15, matching the fixture month

  it('DASH-023: unpaid, nothing overdue → amber "0/2 paid · 1 due soon" and left-to-pay sum', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0].dueDay = 25 // Rent day 25 → upcoming (diff 10)
    m.categories[1].items[1].dueDay = 20 // Utilities day 20 → due soon (diff 5)
    mockLoads({ month: m })
    renderPage(TODAY)

    // The Bills left tile: what is left to pay, "0/2 paid", and a due-soon chip in the warn tone.
    const tile = await screen.findByRole('group', { name: 'Bills left' }, { timeout: 5000 })
    expect(within(tile).getByText('€1,280.00')).toBeInTheDocument()
    expect(tile.textContent).toContain('0/2 paid')
    expect(within(tile).getByText('1 due soon')).toHaveAttribute('data-tone', 'warn')
    expect(tile.textContent).not.toMatch(/overdue/)
    // Beside the chip the paid count is read out, not shown (the chip is the tile's one line).
    expect(within(tile).getByText('0/2 paid')).toHaveClass('sr-only')
  })

  it('DASH-023: with nothing overdue or due soon the paid count shows in place of a chip', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0].dueDay = 25 // Rent day 25 → upcoming (diff 10)
    m.categories[1].items[1].dueDay = 28 // Utilities day 28 → upcoming (diff 13)
    mockLoads({ month: m })
    renderPage(TODAY)

    const tile = await screen.findByRole('group', { name: 'Bills left' }, { timeout: 5000 })
    const count = within(tile).getByText('0/2 paid')
    expect(count).not.toHaveClass('sr-only')
    expect(count).not.toHaveAttribute('data-tone')
    expect(tile.textContent).not.toMatch(/overdue|due soon/)
  })

  it('DASH-024: an overdue bill takes the rose tone and suppresses the due-soon count', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0].dueDay = 1 // Rent day 1 → overdue (diff −14)
    m.categories[1].items[1].dueDay = 20 // Utilities day 20 → due soon, but suppressed
    mockLoads({ month: m })
    renderPage(TODAY)

    const tile = await screen.findByRole('group', { name: 'Bills left' }, { timeout: 5000 })
    expect(within(tile).getByText('€1,280.00')).toBeInTheDocument()
    expect(within(tile).getByText('1 overdue')).toHaveAttribute('data-tone', 'bad')
    expect(tile.textContent).not.toMatch(/due soon/)
    expect(within(tile).getByText('0/2 paid')).toHaveClass('sr-only')
  })

  it('DASH-025: all bills paid turns the Bills left tile to the ok tone', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0] = { ...m.categories[1].items[0], dueDay: 1, isPaid: true }
    m.categories[1].items[1] = { ...m.categories[1].items[1], dueDay: 20, isPaid: true }
    mockLoads({ month: m })
    renderPage(TODAY)

    const tile = await screen.findByRole('group', { name: 'Bills left' }, { timeout: 5000 })
    expect(within(tile).getByText('€0.00')).toBeInTheDocument()
    expect(within(tile).getByText('2/2 paid')).toHaveAttribute('data-tone', 'ok')
    expect(within(tile).getByText('2/2 paid')).not.toHaveClass('sr-only')
    expect(tile.textContent).not.toMatch(/overdue|due soon/)
  })
})

describe('DashboardPage — reorder gating, templates & jars shelf', () => {
  beforeEach(() => {
    resetApiMocks()
    setMoneyFormat('comma-dot')
  })

  it('DASH-045: the group menus\' Move up / Move down disable at the ends of the expense list', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() }) // expense order: Housing (first), Food (last)
    const user = userEvent.setup()
    renderPage()

    const housing = await menuItems(user, 'Housing group: more actions')
    expect(housing.find((i) => i.name === 'Move up')!.disabled).toBe(true)
    expect(housing.find((i) => i.name === 'Move down')!.disabled).toBe(false)
    await user.keyboard('{Escape}')
    const food = await menuItems(user, 'Food group: more actions')
    expect(food.find((i) => i.name === 'Move up')!.disabled).toBe(false)
    expect(food.find((i) => i.name === 'Move down')!.disabled).toBe(true)
  })

  it('DASH-009: the template grid maps each card to name / description / counts / aria-label', { timeout: 15000 }, async () => {
    const templates: BudgetTemplateDto[] = [
      {
        key: 'essentials', name: 'Essentials', description: 'A clean starting point covering the bills most households share.',
        groups: [
          { name: 'Income', kind: 'Income', lines: ['A', 'B'] },
          { name: 'Housing', kind: 'Expense', lines: ['A', 'B', 'C'] },
        ],
      },
      {
        key: 'student', name: 'Student', description: 'A lightweight budget for term-time living costs.',
        groups: [{ name: 'Income', kind: 'Income', lines: ['A'] }],
      },
    ]
    mockLoads({ month: null, templates }) // month 404 ⇒ the create/empty state

    renderPage()

    // Essentials card: aria-label, description, and the "{groups} groups · {lines} lines" formula (2 groups, 5 lines).
    const essentials = await screen.findByRole('button', { name: /^Start from the template: Essentials/ }, { timeout: 5000 })
    expect(essentials.textContent).toContain('Essentials')
    expect(essentials.textContent).toContain('A clean starting point covering the bills most households share.')
    expect(essentials.textContent).toContain('2 groups · 5 lines')

    const student = screen.getByRole('button', { name: /^Start from the template: Student/ })
    expect(student.textContent).toContain('1 groups · 1 lines')

    // A first-ever month (no strictly-earlier month) offers no Copy button.
    expect(screen.queryByRole('button', { name: /^Copy / })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a blank budget' })).toBeInTheDocument()
  })

  it('DASH-027: the jars shelf shows the saved total, per-jar goal % / monthly, and the funded chip', { timeout: 15000 }, async () => {
    const jars: JarDto[] = [
      { id: 'jar-holiday', name: 'Holiday', kind: 0, targetAmount: 1200, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, monthOnly: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 450, plannedThisMonth: 150, contributedThisMonth: 0, remainingThisMonth: 150, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, completedOn: null, canDelete: false, skippedThisMonth: false, status: 'OnTrack' },
      { id: 'jar-ef', name: 'Emergency Fund', kind: 0, targetAmount: 500, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, monthOnly: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 500, plannedThisMonth: 0, contributedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, completedOn: null, canDelete: false, skippedThisMonth: false, status: 'FullyFunded' },
    ]
    // A minimal income-only month keeps the shelf's €450 balance unambiguous.
    mockLoads({ month: emptyMonth(), jars })
    renderPage()

    // Header total = sum of currentBalance (450 + 500).
    expect(await screen.findByText('€950.00 saved', {}, { timeout: 5000 })).toBeInTheDocument()
    // Holiday: 450/1200 = 37.5% → rounds to 38; monthly set-aside chip.
    expect(screen.getByRole('img', { name: 'Holiday: 38% of goal' })).toBeInTheDocument()
    expect(screen.getByText('+€150.00/mo')).toBeInTheDocument()
    // Emergency Fund: the funded chip replaces the monthly figure (mutually exclusive).
    expect(screen.getByText('Funded')).toBeInTheDocument()
  })
})

describe('DashboardPage catalog — pending-FX honesty (re-review F5)', () => {
  // Rows awaiting an exchange rate are EXCLUDED from the actuals server-side; the month
  // must say so instead of presenting the incomplete totals as final.
  it('shows the pending-FX notice when the month reports pending rows', { timeout: 15000 }, async () => {
    mockLoads({ month: { ...jul26(), fxPendingCount: 2 } })
    renderPage()

    const notice = await screen.findByRole('status', {}, { timeout: 5000 })
    expect(notice.textContent).toContain('2 payments in another currency aren’t counted yet')
    expect(within(notice).getByRole('link', { name: 'Add € amounts' })).toHaveAttribute('href', '/transactions')
  })

  it('renders no pending-FX notice when nothing is pending', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    expect(screen.queryByText(/await(s)? an exchange rate/)).not.toBeInTheDocument()
    expect(screen.queryByText(/in another currency/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Add € amount/ })).not.toBeInTheDocument()
  })
})
