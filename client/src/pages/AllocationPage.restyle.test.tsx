import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, AllocationProfileDto, AllocationResultDto, HouseholdMemberDto, MemberAllocationDto } from '../types'

// The Allocation page's restyle (PR 10): the KPI row, the warnings and notes as short strips (the
// full sentence behind an (i), the action at the right), the Steps and Savings cards, the "+ Link
// account" picker (a menu, a bottom sheet on a phone) and the two dialogs in the mock-ups' frame
// (focus, Escape, the phone sheet). The figures and the API calls are the catalog tests' business.

const { monthState } = vi.hoisted(() => ({
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AllocationPage } from './AllocationPage'
import { profile as sharedProfile } from '../test/fixtures/allocation'
import { findAllocateButton, findSteps, hintText, openAllocate, savingsRow, stepRow, strip, tileValue } from '../test/allocationPage'

const W = { timeout: 5000 }

const joint: AccountDto = { id: 'accJoint', name: 'Joint', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 }
const robinSavings: AccountDto = { id: 'accRobin', name: 'Robin Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 1 }
const spare: AccountDto = { id: 'accSpare', name: 'Spare Savings', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 2 }
const alexPot: AccountDto = { id: 'accC', name: 'Alex Pot', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 1000, displayOrder: 3 }

const profile = (over: Partial<AllocationProfileDto> = {}) =>
  sharedProfile({ sourceAccountId: 'accJoint', rules: sharedProfile().rules.map((r) => ({ ...r, fixedAmountPerMember: 0 })), ...over })

function mkPreview(opts: { pool?: number; env?: number; jars?: number; pocketEach?: number; members: MemberAllocationDto[] }): AllocationResultDto {
  const { pool = 5000, env = 2000, jars = 500, pocketEach = 0, members } = opts
  const pocketTotal = pocketEach * members.length
  const savingsTotal = pool - env - jars - pocketTotal
  const per = (amount: number) => members.map((m) => ({ memberId: m.memberId, name: m.name, amount }))
  return {
    pool,
    envelopesTotal: env,
    jarsTotal: jars,
    transfersCreated: 0,
    steps: [
      { type: 0, total: env, perMember: per(env / members.length) },
      { type: 1, total: jars, perMember: per(jars / members.length) },
      { type: 2, total: pocketTotal, perMember: per(pocketEach) },
      { type: 3, total: savingsTotal, perMember: members.map((m) => ({ memberId: m.memberId, name: m.name, amount: m.residual })) },
    ],
    members,
  }
}

const alex = (over: Partial<MemberAllocationDto> = {}): MemberAllocationDto => ({
  memberId: 'm1', name: 'Alex', netIncome: 3000, residual: 1250, savingsBalance: 1000, savingsAccountId: 'accC', ...over,
})
const robin = (over: Partial<MemberAllocationDto> = {}): MemberAllocationDto => ({
  memberId: 'm2', name: 'Robin', netIncome: 2000, residual: 1250, savingsBalance: 0, savingsAccountId: null, ...over,
})

/** A budget for July with income `income` and spending `spent` (the reconciliation's other half). */
function budget(income: number, spent: number) {
  return {
    id: 'b', key: '2026-07', year: 2026, month: 7, baseCurrency: 'EUR', totalIncome: income, totalPlanned: spent, remainingToBudget: income - spent, isBalanced: false,
    categories: [
      { id: 'inc', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: income, totalActual: 0,
        items: [{ id: 'pay', name: 'Pay', displayOrder: 0, plannedAmount: income, actualAmount: 0, remaining: income }] },
      { id: 'liv', name: 'Living', kind: 'Expense', displayOrder: 1, totalPlanned: spent, totalActual: 0,
        items: [{ id: 'rent', name: 'Rent', displayOrder: 0, plannedAmount: spent, actualAmount: 0, remaining: spent }] },
    ],
  }
}

let profileData: AllocationProfileDto | null = null
let accountsData: AccountDto[] = []
let previewData: AllocationResultDto = mkPreview({ members: [alex(), robin()] })
let budgetData: unknown = null
let membersData: HouseholdMemberDto[] = []
let meRole: number | null = null

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/auth/me' && meRole !== null) return Promise.resolve({ data: { role: meRole } })
    if (url === '/allocation/profile') return Promise.resolve({ data: profileData })
    if (url === '/accounts') return Promise.resolve({ data: accountsData })
    if (url === '/budget/2026/7') return budgetData ? Promise.resolve({ data: budgetData }) : Promise.reject({ response: { status: 404 } })
    if (url === '/members') return Promise.resolve({ data: membersData })
    if (url.startsWith('/allocation/preview/')) return Promise.resolve({ data: previewData })
    return Promise.resolve({ data: [] })
  })
}

/** Makes the page's media queries answer as on a given screen (jsdom has no matchMedia). */
function screenMatching(...queries: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}
const asPhone = () => screenMatching('(max-width: 699.98px)')
const asDesktop = () => screenMatching('(min-width: 900px)')

const renderPage = () => renderWithProviders(<AllocationPage />)

describe('AllocationPage restyle (PR 10)', () => {
  beforeEach(() => {
    resetApiMocks()
    localStorage.clear()
    meRole = null
    profileData = profile()
    accountsData = [joint, alexPot, robinSavings, spare]
    previewData = mkPreview({ members: [alex(), robin()] })
    // A budget whose income is the pool and whose spending leaves the savings to assign: quiet.
    budgetData = budget(5000, 2500)
    membersData = [
      { id: 'm1', name: 'Alex', netMonthlyIncome: 3000, personalSavingsAccountId: 'accC', displayOrder: 0, isArchived: false, incomeSharePct: 0.6 },
      { id: 'm2', name: 'Robin', netMonthlyIncome: 2000, personalSavingsAccountId: null, displayOrder: 1, isArchived: false, incomeSharePct: 0.4 },
    ]
    setupGet()
  })
  afterEach(() => vi.unstubAllGlobals())

  // ---- The KPI row and the cards ---------------------------------------------

  it('shows the KPI row: Income to allocate with its (i), Shared spending and To savings', async () => {
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    expect(screen.getByLabelText('Income to allocate: €5,000.00')).toBeInTheDocument()
    expect(await hintText(user, 'About income to allocate')).toBe(
      'July’s income lines from the budget, pooled. A line not assigned to a person is shared equally.',
    )
    expect(tileValue('Shared spending')).toBe(2500)
    expect(tileValue('To savings')).toBe(2500)
  })

  it('draws the Steps card: one income bar, a row per step, the remainder going to the people', async () => {
    const user = userEvent.setup()
    previewData = mkPreview({ pocketEach: 50, members: [alex({ residual: 1200 }), robin({ residual: 1200 })] })
    renderPage()
    await findSteps('July')

    const steps = screen.getByRole('region', { name: 'Steps' })
    // The bar says the same as the rows, in words.
    expect(within(steps).getByRole('img', { name: /^July’s income: €2,000\.00 cover shared costs, €500\.00 fund the jars, €100\.00 pocket money, €2,400\.00 split remainder to savings$/ })).toBeInTheDocument()
    expect(stepRow('July', 'Pocket money')).toHaveTextContent('· €50.00 each')
    expect(within(stepRow('July', 'Split remainder to savings')).getByRole('img', { name: 'To Alex and Robin' })).toBeInTheDocument()
    // One (i) on the title says what each step is, in one short paragraph (the mock's). Each
    // person's savings share is the Savings card's, so it isn't repeated here.
    const about = await hintText(user, 'About the steps')
    expect(about).toBe(
      'Shared costs are July’s spending lines (€1,000.00 each), jars this month’s contributions (€250.00 each). Pocket money is set in Settings. What’s left goes to savings, leaning toward whoever’s savings are lowest.',
    )
    // An admin's Settings button sits on the card.
    expect(within(steps).getByRole('button', { name: 'Allocation settings' })).toHaveTextContent('Settings')
  })

  it('draws the Savings card: a row per person with where their savings go', async () => {
    renderPage()
    await findSteps('July')

    expect(screen.getByRole('region', { name: 'Savings' })).toBeInTheDocument()
    expect(within(savingsRow('Alex')).getByText('Alex Pot')).toBeInTheDocument()
    expect(within(savingsRow('Alex')).getByText('€1,250.00')).toBeInTheDocument()
    // No account: where the share stays, in the warning tone, and the fix beside it.
    expect(within(savingsRow('Robin')).getByText('Stays in Joint')).toBeInTheDocument()
    expect(within(savingsRow('Robin')).getByRole('button', { name: 'Link account for Robin’s savings' })).toHaveTextContent('Link account')
  })

  it('falls back to "Savings account" when the linked account is not in the account list', async () => {
    accountsData = [joint]
    renderPage()
    await findSteps('July')
    expect(within(savingsRow('Alex')).getByText('Savings account')).toBeInTheDocument()
  })

  // ---- The strips ---------------------------------------------------------------

  it('no source: a short warning strip, today’s sentence behind its (i), and Settings as its action', async () => {
    profileData = profile({ sourceAccountId: null })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    const s = strip('no-source')!
    expect(s).toHaveAttribute('data-tone', 'warn')
    expect(s).not.toHaveAttribute('role')
    expect(s).toHaveTextContent('No account to pay from')
    expect(await hintText(user, 'About the account to pay from', s)).toBe(
      'Set the account to pay shared costs from in Settings before you can allocate July.',
    )
    // The strip's action has its own name: "Allocation settings" stays the card's button alone.
    expect(screen.getAllByRole('button', { name: 'Allocation settings' })).toHaveLength(1)
    await user.click(within(s).getByRole('button', { name: 'Settings: choose the account to pay from' }))
    expect(await screen.findByRole('dialog', { name: 'Allocation settings' }, W)).toBeInTheDocument()
  })

  it('no source for a Limited user: the strip has no action', async () => {
    meRole = 2
    profileData = profile({ sourceAccountId: null })
    renderPage()
    await findSteps('July')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    await waitFor(() => expect(within(strip('no-source')!).queryByRole('button', { name: /^Settings/ })).not.toBeInTheDocument())
  })

  it('pocket money and savings not in the budget: a warning strip that adds pocket money', async () => {
    previewData = mkPreview({ pocketEach: 50, members: [alex({ residual: 1200 }), robin({ residual: 1200 })] })
    budgetData = budget(5000, 2500)
    mockPost.mockResolvedValue({ data: budget(5000, 2600) })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    const s = strip('unbudgeted')!
    expect(s).toHaveTextContent('Pocket money and savings aren’t budgeted')
    expect(await hintText(user, 'About the budget and the allocation', s)).toBe(
      '€2,500.00 of your income is already promised by the allocation (pocket money, personal savings) but isn’t in your budget — the budget will keep showing it as “still to assign”.',
    )
    await user.click(within(s).getByRole('button', { name: "Add pocket money to July's budget" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/allocation/pocket-lines/2026/7', {}))
    // The "added" line is a status strip, in the ok tone.
    await waitFor(() => expect(strip('synced')).not.toBeNull(), W)
    const done = strip('synced')!
    // The live region is the strip's line (an (i) beside it would be announced again on opening).
    expect(within(done).getByRole('status')).toHaveTextContent('Pocket money added to July’s budget.')
    expect(done).toHaveAttribute('data-tone', 'ok')
    expect(done).toHaveTextContent('Pocket money added to July’s budget.')
  })

  it('keeps today’s live-region roles: warnings have none, the equal split is a note', async () => {
    previewData = {
      ...mkPreview({ members: [alex(), robin()] }),
      incomeFromBudget: true,
      unattributedIncome: 350,
      equalSplitNote: 'Nobody has income this month, so the by-income split was shared equally instead.',
    }
    budgetData = budget(3000, 3000) // a pool that doesn't match the budget, and savings it can't hold
    renderPage()
    await findSteps('July')

    for (const id of ['unattributed', 'disagree', 'mismatch']) {
      expect(strip(id), id).not.toBeNull()
      expect(strip(id), id).not.toHaveAttribute('role')
    }
    expect(strip('unattributed')).toHaveAttribute('data-tone', 'warn')
    expect(strip('mismatch')).toHaveAttribute('data-tone', 'soft')
    expect(strip('equal-split')).toHaveAttribute('role', 'note')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // Each strip's (i) is named for what it explains.
    for (const name of ['About unassigned income', 'About the equal split', 'About the budget and the allocation', 'About the income here']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('the (i) of a strip closes on Escape and leaves the page as it was', async () => {
    profileData = profile({ sourceAccountId: null })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    const about = within(strip('no-source')!).getByRole('button', { name: 'About the account to pay from' })
    act(() => about.focus())
    expect(await screen.findByRole('tooltip', {}, W)).toHaveTextContent(/Set the account to pay shared costs from/)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(about).toHaveFocus()
  })

  // ---- "+ Link account" ---------------------------------------------------------

  it('Link account (wide screen): a menu named for the person, closed by Escape back to the chip; a pick links that account', async () => {
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    const chip = screen.getByRole('button', { name: 'Link account for Robin’s savings' })
    await user.click(chip)
    const menu = await screen.findByRole('menu', { name: 'Savings account for Robin' }, W)
    expect(within(menu).getAllByRole('menuitem').map((el) => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
      'Use “Robin Savings”',
      'Spare Savings — Savings',
      'Alex Pot — Savings',
      'Joint — Current',
    ])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(chip).toHaveFocus()
    expect(mockPut).not.toHaveBeenCalled()

    // From the keyboard: Enter opens it, the arrows move, Enter picks.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu', { name: 'Savings account for Robin' }, W)
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/members/m2', {
        name: 'Robin',
        netMonthlyIncome: 2000,
        personalSavingsAccountId: 'accSpare',
        version: null,
      }),
    )
  })

  it('Link account on a phone: a bottom sheet titled for the person', async () => {
    asPhone()
    mockPut.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    await user.click(screen.getByRole('button', { name: 'Link account for Robin’s savings' }))
    const sheet = await screen.findByRole('dialog', { name: 'Savings account for Robin' }, W)
    expect(within(sheet).getByRole('button', { name: 'Use “Robin Savings”' })).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Spare Savings — Savings' }))
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/members/m2', expect.objectContaining({ personalSavingsAccountId: 'accSpare' })),
    )
  })

  it('read-only: the person’s row has no Link account chip, and the page has no Settings or Allocate', async () => {
    meRole = 3
    renderPage()
    await findSteps('July')
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/auth/me'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link account for Robin’s savings' })).not.toBeInTheDocument())
    expect(within(savingsRow('Robin')).getByText('Stays in Joint')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allocation settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allocate July' })).not.toBeInTheDocument()
  })

  // ---- The Allocate dialog --------------------------------------------------------

  it('the Allocate dialog: named by its title, focus on its Close, the (i) closes alone on Escape, then Escape closes it back to Allocate', async () => {
    previewData = mkPreview({ members: [alex(), robin({ savingsAccountId: 'accRobin' })] })
    const user = userEvent.setup()
    renderPage()

    const allocate = await findAllocateButton('July')
    await user.click(allocate)
    const dialog = await screen.findByRole('dialog', { name: 'Record July’s transfers' }, W)
    // Focus opens on the close control, not on the title's (i).
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    // Who moves what, from where to where.
    const lines = within(within(dialog).getByRole('list', { name: 'Transfers' })).getAllByRole('listitem')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent(/Alex\s*Joint to Alex Pot\s*€1,250\.00$/)
    expect(lines[1]).toHaveTextContent(/Robin\s*Joint to Robin Savings\s*€1,250\.00$/)

    // The title's (i): open by focus, closed by Escape without closing the dialog.
    const about = within(dialog).getByRole('button', { name: 'About recording the transfers' })
    act(() => about.focus())
    expect(await screen.findByRole('tooltip', {}, W)).toHaveTextContent(
      'The suggested amounts become recorded transfers only once you’ve moved the money at the bank. Each transfer is recorded as departed from Joint on the date you set and stays in transit until you confirm its receipt on the Transactions page.',
    )
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(dialog).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(allocate).toHaveFocus()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('the Allocate dialog’s date: the pill opens the field, Enter closes it back to the pill with the new date', async () => {
    mockPost.mockResolvedValue({ data: mkPreview({ members: [alex(), robin()] }) })
    const user = userEvent.setup()
    renderPage()
    const dialog = within(await openAllocate(user, 'July'))

    const pill = dialog.getByRole('button', { name: 'Sent today: the date the money left Joint' })
    expect(pill).toHaveTextContent('Sent today')
    act(() => pill.focus())
    await user.keyboard('{Enter}')
    const field = dialog.getByLabelText('Allocation departure date')
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, '2026-07-02')
    await user.keyboard('{Enter}')
    const back = dialog.getByRole('button', { name: /^Sent .*2.*: the date the money left Joint$/ })
    expect(back).toHaveFocus()
    expect(back).not.toHaveTextContent('today')

    // The checkbox is named by its words; Space ticks it.
    const done = dialog.getByRole('checkbox', { name: 'I’ve completed these transfers' })
    act(() => done.focus())
    await user.keyboard(' ')
    expect(done).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Record transfers' }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/allocation/commit/2026/7', { departedOn: '2026-07-02', receivedOn: null, confirmedCompleted: true }),
    )
  })

  it('a stranded share: the dialog asks "Allocate without Robin?" and lists Robin as staying in Joint', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openAllocate(user, 'July')
    expect(dialog).toHaveAccessibleName('Allocate without Robin?')
    const lines = within(within(dialog).getByRole('list', { name: 'Transfers' })).getAllByRole('listitem')
    // The transfers first, then the share that stays.
    expect(lines[0]).toHaveTextContent('Joint to Alex Pot')
    expect(lines[1]).toHaveTextContent('Stays in Joint')
    expect(await hintText(user, 'About Robin’s share', lines[1])).toMatch(
      /€1,250\.00 will stay in Joint because Robin has no savings account linked\. You can link one on the person’s row and re-run/,
    )
  })

  it('the Allocate dialog on a phone: a bottom sheet whose grab handle is its one Close, with the actions outside the scrolling middle', async () => {
    asPhone()
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    // The Allocate pill sits under the KPI row (not in the top bar).
    const allocate = await findAllocateButton('July')
    expect(screen.getAllByRole('button', { name: 'Allocate July' })).toHaveLength(1)
    await user.click(allocate)
    const dialog = await screen.findByRole('dialog', { name: 'Allocate without Robin?' }, W)
    const close = within(dialog).getAllByRole('button', { name: 'Close' })
    expect(close).toHaveLength(1)
    expect(close[0]).toHaveFocus()
    expect(close[0]).not.toHaveTextContent(/./) // the grab handle: no ✕
    const middle = dialog.querySelector('.sheet-dlg-body')!
    expect(within(middle as HTMLElement).getByRole('list', { name: 'Transfers' })).toBeInTheDocument()
    expect(middle.contains(within(dialog).getByRole('button', { name: 'Record transfers' }))).toBe(false)
    expect(middle.contains(within(dialog).getByRole('checkbox', { name: 'I’ve completed these transfers' }))).toBe(false)

    await user.click(close[0])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(allocate).toHaveFocus()
  })

  it('on a wide screen Allocate sits in the top bar, once', async () => {
    asDesktop()
    renderPage()
    await findSteps('July')
    expect(screen.getAllByRole('button', { name: 'Allocate July' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Allocate July' })).toHaveTextContent(/^Allocate$/)
  })

  // ---- The settings dialog ---------------------------------------------------------

  it('the settings dialog: focus on Close, Escape discards the edits and returns focus to Settings', async () => {
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')

    const settings = screen.getByRole('button', { name: 'Allocation settings' })
    await user.click(settings)
    const dialog = await screen.findByRole('dialog', { name: 'Allocation settings' }, W)
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    // The fields, by their names; "Pocket money (each)" is a real label.
    expect(within(dialog).getByLabelText('Pocket money (each)')).toBe(within(dialog).getByLabelText('Pocket money per member'))
    expect(within(dialog).getByLabelText('Source account')).toHaveValue('accJoint')
    await user.type(within(dialog).getByLabelText('Pocket money per member'), '75')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(settings).toHaveFocus()
    await user.click(settings)
    expect(within(await screen.findByRole('dialog', {}, W)).getByLabelText('Pocket money per member')).toHaveValue('0')
    expect(mockPut).not.toHaveBeenCalled()
  })

  // ---- Review fixes (restyle PR 10) ----------------------------------------------------

  it('after Add pocket money, with the savings still not budgeted, the strip says how much is missing and never contradicts the "added" line', async () => {
    previewData = mkPreview({ pocketEach: 50, members: [alex({ residual: 1200 }), robin({ residual: 1200 })] })
    budgetData = budget(5000, 2500)
    // The answer: the month with a flagged "Pocket Money" group (100) now in the budget.
    const synced = budget(5000, 2500)
    synced.categories.push({
      id: 'pm', name: 'Pocket Money', kind: 'Expense', displayOrder: 2, totalPlanned: 100, totalActual: 0, excludeFromAllocation: true,
      items: [{ id: 'pm1', name: 'Alex', displayOrder: 0, plannedAmount: 50, actualAmount: 0, remaining: 50 },
        { id: 'pm2', name: 'Robin', displayOrder: 1, plannedAmount: 50, actualAmount: 0, remaining: 50 }],
    } as (typeof synced.categories)[number])
    mockPost.mockResolvedValue({ data: synced })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')
    expect(strip('unbudgeted')).toHaveTextContent('Pocket money and savings aren’t budgeted')

    await user.click(screen.getByRole('button', { name: "Add pocket money to July's budget" }))
    await waitFor(() => expect(strip('synced')).not.toBeNull(), W)
    const s = strip('unbudgeted')!
    // Only the €2,400.00 of savings is missing now: the line carries today's figure, not a claim
    // about pocket money.
    expect(s).toHaveTextContent('€2,400.00 promised but not budgeted')
    expect(s).not.toHaveTextContent(/Pocket money/)
    expect(await hintText(user, 'About the budget and the allocation', s)).toMatch(/^€2,400\.00 of your income is already promised by the allocation/)
  })

  it('the Steps (i) follows the saved splits: by income it names each person’s part; a Balance lean of 0 is an even split', async () => {
    profileData = profile({
      balanceLeanPercent: 0,
      rules: profile().rules.map((r) => (r.type === 0 || r.type === 1 ? { ...r, split: 1 } : r.type === 3 ? { ...r, split: 2 } : r)),
    })
    const preview = mkPreview({ members: [alex(), robin()] })
    preview.steps[0].perMember = [{ memberId: 'm1', name: 'Alex', amount: 1200 }, { memberId: 'm2', name: 'Robin', amount: 800 }]
    previewData = preview
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')
    expect(await hintText(user, 'About the steps')).toBe(
      'Shared costs are July’s spending lines, split by income (Alex €1,200.00, Robin €800.00), jars this month’s contributions (€250.00 each). Pocket money is set in Settings. What’s left goes to savings, split equally.',
    )
  })

  it('the last step shows at most three circles: past three people, two avatars and "+N"; its name lists everyone', async () => {
    const sam = robin({ memberId: 'm3', name: 'Sam', residual: 500 })
    const kim = robin({ memberId: 'm4', name: 'Kim', residual: 500 })
    previewData = mkPreview({ members: [alex({ residual: 750 }), robin({ residual: 750 }), sam, kim] })
    renderPage()
    await findSteps('July')
    const stack = within(stepRow('July', 'Split remainder to savings')).getByRole('img', { name: 'To Alex, Robin, Sam and Kim' })
    expect(stack.children).toHaveLength(3)
    expect(stack).toHaveTextContent(/^AR\+2$/)
    // The amount is still in the row for assistive tech (and the journeys).
    expect(stepRow('July', 'Split remainder to savings')).toHaveTextContent('€2,500.00')
  })

  it('pocket money keeps its whole name: "€X each" follows it, its dot hidden from assistive tech', async () => {
    previewData = mkPreview({ pocketEach: 50, members: [alex(), robin()] })
    renderPage()
    await findSteps('July')
    const row = stepRow('July', 'Pocket money')
    const name = within(row).getByText('Pocket money', { exact: true })
    // The name truncates only on its own line: the detail wraps under it rather than squeezing it.
    expect(name.parentElement).toHaveClass('flex-wrap')
    const each = within(row).getByText(/€50\.00 each/)
    expect(each.querySelector('[aria-hidden]')).toHaveTextContent('·')
  })

  it('the one-click suggestion shows the account’s own type icon, not a tick', async () => {
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')
    await user.click(screen.getByRole('button', { name: 'Link account for Robin’s savings' }))
    const menu = await screen.findByRole('menu', { name: 'Savings account for Robin' }, W)
    const use = within(menu).getByRole('menuitem', { name: 'Use “Robin Savings”' })
    const spareIcon = within(menu).getByRole('menuitem', { name: 'Spare Savings — Savings' }).querySelector('svg')!
    expect(use.querySelector('svg')).not.toHaveClass('lucide-check')
    // The same glyph a savings account's own row has.
    expect(use.querySelector('svg')!.getAttribute('class')).toBe(spareIcon.getAttribute('class'))
  })

  it('unassigned income: the action says it goes to the Dashboard, by its words and its name', async () => {
    previewData = { ...mkPreview({ members: [alex(), robin()] }), unattributedIncome: 350 }
    renderPage()
    await findSteps('July')
    const action = within(strip('unattributed')!).getByRole('button', { name: 'Assign income lines on the Dashboard' })
    expect(action).toHaveTextContent('Assign on the Dashboard')
  })

  it('Record transfers with the box unticked: the message is brought into view and the box is marked invalid', async () => {
    const scrolled: Element[] = []
    const had = 'scrollIntoView' in Element.prototype
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      const user = userEvent.setup()
      renderPage()
      const dialog = within(await openAllocate(user, 'July'))
      const box = dialog.getByRole('checkbox', { name: 'I’ve completed these transfers' })
      expect(box).not.toHaveAttribute('aria-invalid')
      await user.click(dialog.getByRole('button', { name: 'Record transfers' }))
      const alert = dialog.getByRole('alert')
      expect(alert).toHaveTextContent('Confirm that you’ve completed these transfers before recording them.')
      expect(scrolled.some((el) => el.contains(alert))).toBe(true)
      expect(box).toHaveAttribute('aria-invalid', 'true')
      await user.click(box)
      expect(box).not.toHaveAttribute('aria-invalid')
      expect(mockPost).not.toHaveBeenCalled()
    } finally {
      if (!had) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('two people’s jars in the Allocate dialog: each (i) is named for whose share it is', async () => {
    previewData = mkPreview({ members: [alex(), robin({ savingsAccountId: 'accRobin' })] })
    const ledger = (accountId: string, accountName: string, jarId: string) => ({
      accountId, accountName, currency: 'EUR', asOf: '2026-07-01', accountBalance: 1000, unallocated: 100, positiveAllocations: 900,
      hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false,
      jars: [{ jarId, name: `Holiday ${jarId}`, balance: 100, isArchived: false }],
    })
    const base = mockGet.getMockImplementation()!
    mockGet.mockImplementation((url: string) =>
      url === '/jars/ledger' ? Promise.resolve({ data: [ledger('accC', 'Alex Pot', 'j1'), ledger('accRobin', 'Robin Savings', 'j2')] }) : base(url),
    )
    const user = userEvent.setup()
    renderPage()
    const dialog = within(await openAllocate(user, 'July'))
    await dialog.findByRole('group', { name: 'Put into jars in Robin Savings' }, W)
    expect(dialog.getByRole('button', { name: 'About putting Alex’s share into jars' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'About putting Robin’s share into jars' })).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'About putting it into jars' })).not.toBeInTheDocument()
  })

  it('saving the settings opened from the no-source strip moves focus to Allocate, not the page', async () => {
    profileData = profile({ sourceAccountId: null })
    mockPut.mockResolvedValue({ data: profile() })
    const user = userEvent.setup()
    renderPage()
    await findSteps('July')
    await user.click(screen.getByRole('button', { name: 'Settings: choose the account to pay from' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Allocation settings' }, W))
    await user.selectOptions(dialog.getByLabelText('Source account'), 'accJoint')
    await user.click(dialog.getByRole('button', { name: 'Save allocation settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), W)
    // The strip (and its button) went with the missing source; the next step takes focus.
    expect(strip('no-source')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Allocate July' })).toHaveFocus())
  })

  it('the sheet dialogs’ hints are placed against the screen, so the scrolling middle can’t cut them off', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = within(await openAllocate(user, 'July'))
    await user.hover(dialog.getByRole('button', { name: 'About Robin’s share' }))
    expect((await screen.findByRole('tooltip', {}, W)).parentElement).toHaveClass('fixed')
    await user.unhover(dialog.getByRole('button', { name: 'About Robin’s share' }))
    await user.hover(dialog.getByRole('button', { name: 'About recording the transfers' }))
    expect((await screen.findByRole('tooltip', {}, W)).parentElement).toHaveClass('fixed')
  })
})
