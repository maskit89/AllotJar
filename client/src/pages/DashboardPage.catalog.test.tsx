import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetMonthDto, BudgetTemplateDto, JarDto } from '../types'

// Same api-control pattern as DashboardPage.test.tsx: vi.hoisted so the mock
// factory can reference the fns, importOriginal spread so other api.ts exports
// keep working under the mock.
const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { DashboardPage } from './DashboardPage'
import { AuthProvider } from '../auth/AuthContext'
import { MonthProvider } from '../features/MonthContext'
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format,
// independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

// --- Fixtures ---------------------------------------------------------------
// The page recomputes every total from `categories` (budgetModel selectors), so
// the DTO-level totals/isBalanced are cosmetic here — only the category tree drives
// the render. Each builder returns a fresh object so tests never share mutable state.

type Item = {
  id: string
  name: string
  displayOrder: number
  plannedAmount: number
  actualAmount: number
  remaining: number
  savingsId?: string
  savingsAvailable?: number
  dueDay?: number
  isPaid?: boolean
}

function monthShell(over: Partial<BudgetMonthDto>): BudgetMonthDto {
  return {
    id: 'm1',
    key: '2026-07',
    year: 2026,
    month: 7,
    baseCurrency: 'EUR',
    totalIncome: 0,
    totalPlanned: 0,
    remainingToBudget: 0,
    isBalanced: false,
    categories: [],
    ...over,
  }
}

// JUL26 canonical fixture: Income 3,000 (Take-home Pay 2,600 received of 2,600
// planned + Freelance 400), Housing (Rent 1,100 bill day 1, Utilities 180 bill
// day 20), Food (Groceries 400/250, Restaurants 90 planned/120 spent = overspent),
// Savings (Holiday 150 planned, 0 spent, 450 rolled-over available).
// Allotted = 1,920 · Income = 3,000 · Remaining = 1,080.
function jul26(): BudgetMonthDto {
  return monthShell({
    categories: [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 3000, totalActual: 2600,
        items: [
          { id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 2600, actualAmount: 2600, remaining: 0 },
          { id: 'i-free', name: 'Freelance', displayOrder: 1, plannedAmount: 400, actualAmount: 0, remaining: 400 },
        ] as Item[],
      },
      {
        id: 'c-housing', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 1280, totalActual: 0,
        items: [
          { id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 0, remaining: 1100, dueDay: 1, isPaid: false },
          { id: 'i-util', name: 'Utilities', displayOrder: 1, plannedAmount: 180, actualAmount: 0, remaining: 180, dueDay: 20, isPaid: false },
        ] as Item[],
      },
      {
        id: 'c-food', name: 'Food', kind: 'Expense', displayOrder: 1, totalPlanned: 490, totalActual: 370,
        items: [
          { id: 'i-groc', name: 'Groceries', displayOrder: 0, plannedAmount: 400, actualAmount: 250, remaining: 150 },
          { id: 'i-rest', name: 'Restaurants', displayOrder: 1, plannedAmount: 90, actualAmount: 120, remaining: -30 },
        ] as Item[],
      },
      {
        id: 'c-sav', name: 'Savings', kind: 'Savings', displayOrder: 0, totalPlanned: 150, totalActual: 0,
        items: [
          { id: 'i-holiday', name: 'Holiday', displayOrder: 0, plannedAmount: 150, actualAmount: 0, remaining: 150, savingsId: 'jar-holiday', savingsAvailable: 450 },
        ] as Item[],
      },
    ],
  })
}

// A balanced month: income 3,000 planned entirely against one expense line → remaining 0.
function balancedMonth(baseCurrency = 'EUR'): BudgetMonthDto {
  return monthShell({
    baseCurrency,
    categories: [
      {
        id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 3000, totalActual: 3000,
        items: [{ id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 3000, remaining: 0 }] as Item[],
      },
      {
        id: 'c-housing', name: 'Housing', kind: 'Expense', displayOrder: 0, totalPlanned: 3000, totalActual: 0,
        items: [{ id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 3000, actualAmount: 0, remaining: 3000 }] as Item[],
      },
    ],
  })
}

// A truly empty month: an Income group with no lines, nothing planned. Remaining €0
// but nothing budgeted — the plan-your-income prompt, never the balanced badge.
function emptyMonth(baseCurrency = 'EUR'): BudgetMonthDto {
  return monthShell({
    baseCurrency,
    categories: [{ id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0, items: [] }],
  })
}

// Income 0 but with a planned expense line — over-budgeted, NOT the empty prompt.
function income0Planned(): BudgetMonthDto {
  return monthShell({
    categories: [
      { id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0, items: [] },
      {
        id: 'c-bills', name: 'Bills', kind: 'Expense', displayOrder: 0, totalPlanned: 500, totalActual: 0,
        items: [{ id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 500, actualAmount: 0, remaining: 500 }] as Item[],
      },
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
    if (/^\/budget\/\d+\/\d+$/.test(url)) {
      return month ? Promise.resolve({ data: month }) : Promise.reject({ response: { status: 404 } })
    }
    // /auth/me and anything else: a benign object (no numeric role ⇒ role stays Owner ⇒ canWrite).
    return Promise.resolve({ data: {} })
  })
}

function renderPage(today?: Date) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MonthProvider>
          {today ? <DashboardPage today={today} /> : <DashboardPage />}
        </MonthProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

// a precedes b in document order
function precedes(a: Element, b: Element) {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('DashboardPage — hero footnote states (PR #172) & render', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56
  })

  it('DASH-001: renders the sections in the canonical top-to-bottom order', { timeout: 15000 }, async () => {
    mockLoads({
      month: jul26(),
      jars: [
        { id: 'jar-holiday', name: 'Holiday', kind: 0, targetAmount: 1200, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 450, plannedThisMonth: 150, contributedThisMonth: 0, remainingThisMonth: 150, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, status: 'OnTrack' },
      ],
    })

    renderPage()

    // Hero landmark
    const eyebrow = await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    const hero = eyebrow.closest('section')!
    const billsStrip = await screen.findByText(/📅 Bills:/, {}, { timeout: 5000 })
    const jarsShelf = screen.getByRole('heading', { name: 'Your jars' })
    const incomeCard = screen.getByRole('heading', { name: 'Income', level: 2 })
    const everyday = screen.getByRole('heading', { name: 'Everyday spending' })
    const savings = screen.getByLabelText('Rename group Savings') // savings group name (editable input for Owner)
    const addGroup = screen.getByRole('button', { name: 'Add a group' })

    expect(precedes(hero, billsStrip)).toBe(true)
    expect(precedes(billsStrip, jarsShelf)).toBe(true)
    expect(precedes(jarsShelf, incomeCard)).toBe(true)
    expect(precedes(incomeCard, everyday)).toBe(true)
    expect(precedes(everyday, savings)).toBe(true)
    expect(precedes(savings, addGroup)).toBe(true)

    // Housing renders before Food inside the single Everyday spending card.
    expect(precedes(screen.getByLabelText('Rename group Housing'), screen.getByLabelText('Rename group Food'))).toBe(true)

    // The one visually-hidden page heading, and no error strip.
    expect(screen.getByRole('heading', { level: 1, name: 'Budget' })).toBeInTheDocument()
    expect(screen.queryByText(/Could not load your budget/)).not.toBeInTheDocument()
  })

  it('DASH-014: under-allotted month shows the neutral "still to assign" pill and the two tiles', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    const eyebrow = await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    const hero = eyebrow.closest('section')!

    // Gold amount + its accessible name.
    expect(hero.querySelector('[aria-label="Remaining to budget: €1,080.00"]')).toBeTruthy()
    // Income = 3,000 (income planned); Allotted = 1,920 (expense + savings planned, income excluded).
    expect(within(hero).getByText('Allotted').closest('div')!.textContent).toContain('€1,920.00')
    expect(within(hero).getByText('Income').closest('div')!.textContent).toContain('€3,000.00')

    // Neutral footnote pill — not rose, not the gold badge.
    const pill = screen.getByText('€1,080.00 still to assign')
    expect(pill.className).toContain('bg-black')
    expect(pill.className).not.toContain('rose')
    expect(screen.queryByText(/has a job/)).not.toBeInTheDocument()
  })

  it('DASH-015: a balanced month shows the gold "Every euro has a job" badge, not a pill', { timeout: 15000 }, async () => {
    mockLoads({ month: balancedMonth() })
    renderPage()

    expect(await screen.findByText('Every euro has a job', {}, { timeout: 5000 })).toBeInTheDocument()
    const eyebrow = screen.getByText('Remaining to budget')
    const hero = eyebrow.closest('section')!
    expect(hero.querySelector('[aria-label="Remaining to budget: €0.00"]')).toBeTruthy()
    expect(screen.queryByText(/still to assign/)).not.toBeInTheDocument()
    expect(screen.queryByText(/over-budgeted/)).not.toBeInTheDocument()
  })

  it('DASH-017: income 0 with planned > 0 shows the rose over-budget pill, not the income prompt', { timeout: 15000 }, async () => {
    mockLoads({ month: income0Planned() })
    renderPage()

    const footnote = await screen.findByText('€500.00 over-budgeted — trim a line', {}, { timeout: 5000 })
    expect(footnote.className).toContain('rose')
    // NOT the empty-month prompt and NOT the balanced badge.
    expect(screen.queryByText(/Plan your income/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has a job/)).not.toBeInTheDocument()

    const hero = screen.getByText('Remaining to budget').closest('section')!
    expect(hero.querySelector('[aria-label="Remaining to budget: -€500.00"]')).toBeTruthy()
    expect(within(hero).getByText('Income').closest('div')!.textContent).toContain('€0.00')
    expect(within(hero).getByText('Allotted').closest('div')!.textContent).toContain('€500.00')
  })

  it('DASH-018: an over-budgeted month shows the rose pill with the positive overrun', { timeout: 15000 }, async () => {
    // Bump Rent 1,100 → 2,300: allotted 3,120 vs income 3,000 → remaining −120.
    const m = jul26()
    m.categories[1].items[0].plannedAmount = 2300
    mockLoads({ month: m })
    renderPage()

    const footnote = await screen.findByText('€120.00 over-budgeted — trim a line', {}, { timeout: 5000 })
    expect(footnote.className).toContain('rose')
    const hero = screen.getByText('Remaining to budget').closest('section')!
    // The gold amount reads negative even though the footnote reads positive.
    expect(hero.querySelector('[aria-label="Remaining to budget: -€120.00"]')).toBeTruthy()
    expect(screen.queryByText(/still to assign/)).not.toBeInTheDocument()
  })

  it('DASH-016: an empty month prompts for income and never celebrates', { timeout: 15000 }, async () => {
    // (Complements the existing coverage by asserting the pill is neutral, not rose.)
    mockLoads({ month: emptyMonth() })
    renderPage()

    const prompt = await screen.findByText('Plan your income, then give every euro a job', {}, { timeout: 5000 })
    expect(prompt.className).toContain('bg-black')
    expect(prompt.className).not.toContain('rose')
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
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot')
  })

  it('DASH-031: the income header shows transaction-derived received of planned, read-only', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    // Header: "Income" + "€2,600.00 of €3,000.00" (received 2,600, planned 3,000).
    const header = (await screen.findByRole('heading', { name: 'Income', level: 2 })).parentElement!
    expect(header.textContent).toContain('€2,600.00')
    expect(header.textContent).toContain('of €3,000.00')

    // Row subtext is the derived received figure, with no edit affordance.
    expect(screen.getByText('€2,600.00 received')).toBeInTheDocument()
    expect(screen.getByText('€0.00 received')).toBeInTheDocument()
    expect(screen.queryByLabelText('Received for Take-home Pay')).not.toBeInTheDocument()
  })

  it('DASH-050: overspent and zero-planned lines render rose with a clamped, never-NaN bar', { timeout: 15000 }, async () => {
    const m = jul26()
    // Zero-planned line with spend: bar must be 0%, remaining rose "-€15.00".
    m.categories[2].items.push({ id: 'i-coffee', name: 'Coffee', displayOrder: 2, plannedAmount: 0, actualAmount: 15, remaining: -15 })
    const { container } = (mockLoads({ month: m }), renderPage())

    // Restaurants: planned 90, spent 120 → "-€30.00" in rose, over "€120.00 of €90.00".
    const overRemaining = await screen.findByText('-€30.00', {}, { timeout: 5000 })
    expect(overRemaining.className).toContain('rose')
    const restaurantsPlanned = screen.getByLabelText('Planned amount for Restaurants')
    expect(restaurantsPlanned).toHaveTextContent('€90.00')
    expect(restaurantsPlanned.closest('div')!.textContent).toContain('€120.00 of €90.00')

    // Zero-planned Coffee line → rose "-€15.00 left".
    expect(screen.getByText('-€15.00').className).toContain('rose')

    // Every progress-bar fill is a finite percentage clamped to [0, 100] — no NaN, no overflow.
    const fills = Array.from(container.querySelectorAll<HTMLElement>('div[style*="width"]'))
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
    fireEvent.click(await screen.findByLabelText('Planned amount for Holiday', {}, { timeout: 5000 }))
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
    await waitFor(() => expect(within(hero).getByText('Allotted').closest('div')!.textContent).toContain('€2,070.00'), { timeout: 5000 })
    expect(hero.querySelector('[aria-label="Remaining to budget: €930.00"]')).toBeTruthy()
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-holiday', { plannedAmount: 300 }), { timeout: 5000 })
  })
})

describe('DashboardPage — planned-amount parsing in-row (parseMinor seam)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot')
  })

  it('DASH-039: a comma-decimal edit commits the parsed amount (12,50 → 12.5)', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    mockPut.mockResolvedValue({ data: {} })
    renderPage()

    fireEvent.click(await screen.findByLabelText('Planned amount for Groceries', {}, { timeout: 5000 }))
    const input = (await screen.findByLabelText('Planned amount for Groceries', {}, { timeout: 5000 })) as HTMLInputElement
    await waitFor(
      () => {
        fireEvent.change(input, { target: { value: '12,50' } })
        expect(input).toHaveValue('12,50')
      },
      { timeout: 5000 },
    )
    fireEvent.blur(input)

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/budget/items/i-groc', { plannedAmount: 12.5 }), { timeout: 5000 })
  })

  it('DASH-040: a rejected input reverts silently — no request, no error, no flicker', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    mockPut.mockResolvedValue({ data: {} })
    renderPage()

    fireEvent.click(await screen.findByLabelText('Planned amount for Groceries', {}, { timeout: 5000 }))
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
      () => expect(screen.getByLabelText('Planned amount for Groceries')).toHaveTextContent('€400.00'),
      { timeout: 5000 },
    )
    expect(mockPut).not.toHaveBeenCalled()
    expect(screen.queryByText(/reverted/)).not.toBeInTheDocument()
  })
})

describe('DashboardPage — bills strip summary & tones', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot')
  })

  const TODAY = new Date(2026, 6, 15) // 2026-07-15, matching the fixture month

  it('DASH-023: unpaid, nothing overdue → amber "0/2 paid · 1 due soon" and left-to-pay sum', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0].dueDay = 25 // Rent day 25 → upcoming (diff 10)
    m.categories[1].items[1].dueDay = 20 // Utilities day 20 → due soon (diff 5)
    mockLoads({ month: m })
    renderPage(TODAY)

    const strip = (await screen.findByText('€1,280.00 left to pay', {}, { timeout: 5000 })).closest('div')!
    expect(strip.textContent).toContain('📅 Bills: 0/2 paid')
    expect(strip.textContent).toContain('· 1 due soon')
    expect(strip.textContent).not.toMatch(/overdue/)
    expect(strip.className).toContain('amber')
  })

  it('DASH-024: an overdue bill takes the rose tone and suppresses the due-soon count', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0].dueDay = 1 // Rent day 1 → overdue (diff −14)
    m.categories[1].items[1].dueDay = 20 // Utilities day 20 → due soon, but suppressed
    mockLoads({ month: m })
    renderPage(TODAY)

    const strip = (await screen.findByText('€1,280.00 left to pay', {}, { timeout: 5000 })).closest('div')!
    expect(strip.textContent).toContain('· 1 overdue')
    expect(strip.textContent).not.toMatch(/due soon/)
    expect(strip.className).toContain('rose')
  })

  it('DASH-025: all bills paid flips the strip to the emerald celebration', { timeout: 15000 }, async () => {
    const m = jul26()
    m.categories[1].items[0] = { ...m.categories[1].items[0], dueDay: 1, isPaid: true }
    m.categories[1].items[1] = { ...m.categories[1].items[1], dueDay: 20, isPaid: true }
    mockLoads({ month: m })
    renderPage(TODAY)

    const strip = (await screen.findByText('All bills paid 🎉', {}, { timeout: 5000 })).closest('div')!
    expect(strip.textContent).toContain('📅 Bills: 2/2 paid')
    expect(strip.className).toContain('emerald')
  })
})

describe('DashboardPage — reorder gating, templates & jars shelf', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    mockDelete.mockReset()
    setMoneyFormat('comma-dot')
  })

  it('DASH-045: the move ▲/▼ controls disable at the ends of the expense list', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() }) // expense order: Housing (first), Food (last)
    renderPage()

    expect(await screen.findByLabelText('Move Housing up', {}, { timeout: 5000 })).toBeDisabled()
    expect(screen.getByLabelText('Move Housing down')).toBeEnabled()
    expect(screen.getByLabelText('Move Food up')).toBeEnabled()
    expect(screen.getByLabelText('Move Food down')).toBeDisabled()
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
    const essentials = await screen.findByLabelText('Start from the Essentials template', {}, { timeout: 5000 })
    expect(essentials.textContent).toContain('Essentials')
    expect(essentials.textContent).toContain('A clean starting point covering the bills most households share.')
    expect(essentials.textContent).toContain('2 groups · 5 lines')

    const student = screen.getByLabelText('Start from the Student template')
    expect(student.textContent).toContain('1 groups · 1 lines')

    // A first-ever month (no strictly-earlier month) offers no Copy button.
    expect(screen.queryByRole('button', { name: /^Copy / })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a blank budget' })).toBeInTheDocument()
  })

  it('DASH-027: the jars shelf shows the saved total, per-jar goal % / monthly, and the funded chip', { timeout: 15000 }, async () => {
    const jars: JarDto[] = [
      { id: 'jar-holiday', name: 'Holiday', kind: 0, targetAmount: 1200, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 450, plannedThisMonth: 150, contributedThisMonth: 0, remainingThisMonth: 150, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, status: 'OnTrack' },
      { id: 'jar-ef', name: 'Emergency Fund', kind: 0, targetAmount: 500, targetDate: null, accrual: 0, monthlyContribution: null, includeDeadlineMonth: false, recurMonths: null, fundingAccountId: 'acc1', balanceAsOf: '2026-07-01', isArchived: false, currentBalance: 500, plannedThisMonth: 0, contributedThisMonth: 0, remainingThisMonth: 0, deadline: null, fundingCompletesOn: null, estimatedMonthsToTarget: null, shortfall: null, lastCycle: null, status: 'FullyFunded' },
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
    expect(notice.textContent).toContain('2 imported transactions await an exchange rate')
    expect(notice.textContent).toContain('totals exclude them')
  })

  it('renders no pending-FX notice when nothing is pending', { timeout: 15000 }, async () => {
    mockLoads({ month: jul26() })
    renderPage()

    await screen.findByText('Remaining to budget', {}, { timeout: 5000 })
    expect(screen.queryByText(/await(s)? an exchange rate/)).not.toBeInTheDocument()
  })
})
