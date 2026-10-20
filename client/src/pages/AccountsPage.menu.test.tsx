import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, AccountReconciliationDto } from '../types'

// The restyled Accounts page (restyle PR 6): each card's actions sit behind a ⋯ (a menu on wider
// screens, a bottom sheet titled with the account's name on a phone) whose note says what the card
// leaves out; the inline editor takes the focus and gives it back to the ⋯; the jar bar says what
// the account's jars hold of it; the page's Add account sits in the top bar on a desktop.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

import { mockDelete, mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { accountAction, accountCard, accountItems, accountNote } from '../test/rowMenu'
import { me } from '../test/fixtures/me'
import { setMoneyFormat } from '../lib/money'
import { EVENTS, track } from '../analytics'
import { AccountsPage } from './AccountsPage'

function acct(over: Partial<AccountDto> = {}): AccountDto {
  return { id: 'a1', name: 'Everyday', type: 0, currency: 'EUR', openingBalance: 100, openingDate: '2026-01-01', currentBalance: 250, displayOrder: 0, ...over }
}

function recon(over: Partial<AccountReconciliationDto> = {}): AccountReconciliationDto {
  return { accountId: 'a1', accountName: 'Everyday', currentBalance: 250, backedJarsTotal: 100, backedJarCount: 1, float: 150, ...over }
}

function mockLoads(s: { accounts?: AccountDto[]; reconciliation?: AccountReconciliationDto[]; role?: number } = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') return Promise.resolve({ data: s.accounts ?? [] })
    if (url === '/accounts/reconciliation') return Promise.resolve({ data: s.reconciliation ?? [] })
    if (url === '/auth/me') return Promise.resolve({ data: s.role === undefined ? {} : me({ role: s.role }) })
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

const renderPage = () => renderWithProviders(<AccountsPage />)

// An account nobody holds, one only you hold and keep private, one you hold and share, and one a
// jar uses (so it stays shared).
const everyday = () => acct()
const pocket = () => acct({ id: 'p1', name: 'Pocket', type: 2, isPrivate: true, canChangeSharing: true, holders: [{ memberId: 'm1', name: 'Chris' }] })
const savings = () => acct({ id: 's1', name: 'Savings', type: 1, isPrivate: false, canChangeSharing: true, holders: [{ memberId: 'm1', name: 'Chris' }] })
// The server's reason for P55, word for word (AccountSharing.HoldsJarReason).
const HOLIDAY_REASON =
  "'Holiday fund' holds the jar 'Holiday'. Jars are part of the household budget, so the account behind one stays visible to everyone (rule 33)."
const holiday = () =>
  acct({
    id: 'h1', name: 'Holiday fund', type: 1, isPrivate: false, canChangeSharing: true, holders: [{ memberId: 'm1', name: 'Chris' }],
    sharingBlockedReason: HOLIDAY_REASON,
  })

describe('AccountsPage — the account ⋯ menu, its phone sheet, the editor\'s focus and the jar bar', () => {
  beforeEach(() => {
    setMoneyFormat('comma-dot')
    resetApiMocks()
    vi.mocked(track).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('each account\'s ⋯ offers Edit, the holder\'s sharing choice, then Delete in red after a divider', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [everyday(), pocket(), savings(), holiday()] })
    const user = userEvent.setup()
    renderPage()

    const names = async (account: string) => (await accountItems(user, account)).map((i) => i.name)
    expect(await names('Everyday')).toEqual(['Edit Everyday', 'Delete Everyday'])
    expect(await names('Pocket')).toEqual(['Edit Pocket', 'Share with household: Pocket', 'Delete Pocket'])
    expect(await names('Savings')).toEqual(['Edit Savings', 'Make private: Savings', 'Delete Savings'])
    // A jar uses it: it stays shared, so there is no Make private (P55).
    expect(await names('Holiday fund')).toEqual(['Edit Holiday fund', 'Delete Holiday fund'])

    // The items read short; their accessible names say which account. Delete sits after a
    // divider, in the warning colour.
    await user.click(screen.getByRole('button', { name: 'Savings: more actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Edit', 'Make private', 'Delete'])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Delete Savings' }).className).toMatch(/text-bad/)
    await user.keyboard('{Escape}')
  })

  it('the ⋯\'s note says the type, who holds it, the opening, what the jars hold and who sees it, none of which the card shows in words', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        acct({ holders: [{ memberId: 'm1', name: 'Chris' }, { memberId: 'm2', name: 'Sam' }] }),
        pocket(),
        holiday(),
      ],
      reconciliation: [recon()],
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Everyday: more actions' }, { timeout: 5000 }))
    const menu = await screen.findByRole('menu')
    // One fact a line, each line apart in what a screen reader reads.
    expect(menu).toHaveAccessibleDescription(/^Current · joint · EUR Held by Chris and Sam Opening €100\.00 on .*2026 €100\.00 in jars$/)
    await user.keyboard('{Escape}')
    const card = within(accountCard('Everyday'))
    expect(card.queryByText(/Opening/)).not.toBeInTheDocument()
    // The bar draws what the jars hold; the exact sum is the note's.
    expect(card.queryByText(/€100\.00/)).not.toBeInTheDocument()
    expect(card.queryByText(/joint/i)).not.toBeInTheDocument()
    // The holders are on the card, for assistive tech in words.
    expect(card.getByText('Held by Chris and Sam')).toBeInTheDocument()

    const note = await accountNote(user, 'Pocket')
    expect(note).toHaveLength(4)
    expect(note[0]).toBe('Cash · EUR')
    expect(note[1]).toBe('Held by Chris')
    expect(note[2]).toMatch(/^Opening €100\.00 on .*2026$/)
    expect(note[3]).toBe('Only you can see this account.')
    // P55: a jar uses it, so it stays visible to the household: the server's reason says which jar
    // and why, in one line (no second sentence saying the same).
    const holidayNote = await accountNote(user, 'Holiday fund')
    expect(holidayNote.slice(3)).toEqual([HOLIDAY_REASON])
    expect(holidayNote.filter((line) => /visible/i.test(line))).toHaveLength(1)
  })

  it('works from the keyboard: Enter opens the ⋯, arrows move, Escape closes and gives focus back to the ⋯', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [savings()] })
    const user = userEvent.setup()
    renderPage()

    const trigger = await screen.findByRole('button', { name: 'Savings: more actions' }, { timeout: 5000 })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Edit Savings' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Make private: Savings' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Delete Savings' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()

    // Delete opens the confirmation; Cancel gives focus back to the ⋯.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Savings: more actions' })).toHaveFocus())
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('the editor takes the focus on its name, keeps its field labels, and gives focus back to the ⋯ on Escape, Cancel and Save', { timeout: 20000 }, async () => {
    mockLoads({ accounts: [everyday(), savings()] })
    mockPut.mockResolvedValue({ data: savings() })
    const user = userEvent.setup()
    renderPage()

    const trigger = () => screen.getByRole('button', { name: 'Savings: more actions' })

    // Escape.
    await accountAction(user, 'Savings', 'Edit Savings')
    await waitFor(() => expect(screen.getByLabelText('Name for Savings')).toHaveFocus())
    const card = within(screen.getByRole('article', { name: 'Savings' }))
    for (const label of ['Name', 'Type', 'Opening balance', 'Opening date', 'Bank details']) {
      expect(card.getByText(label)).toBeInTheDocument()
    }
    // While it is open the card shows no ⋯ of its own.
    expect(screen.queryByRole('button', { name: 'Savings: more actions' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Name for Savings')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger()).toHaveFocus())
    expect(mockPut).not.toHaveBeenCalled()

    // Cancel.
    await accountAction(user, 'Savings', 'Edit Savings')
    await user.click(await screen.findByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(trigger()).toHaveFocus())
    expect(mockPut).not.toHaveBeenCalled()

    // Save.
    await accountAction(user, 'Savings', 'Edit Savings')
    await user.click(await screen.findByRole('button', { name: 'Save Savings' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/s1', expect.objectContaining({ name: 'Savings' })))
    await waitFor(() => expect(screen.queryByLabelText('Name for Savings')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger()).toHaveFocus())
  })

  it('a sharing choice from the ⋯ applies at once and leaves the focus on the ⋯', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [savings()] })
    mockPut.mockResolvedValue({ data: { ...savings(), isPrivate: true } })
    const user = userEvent.setup()
    renderPage()

    await accountAction(user, 'Savings', 'Make private: Savings')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/s1/sharing', { isPrivate: true }))
    expect(await within(accountCard('Savings')).findByText('Private')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Savings: more actions' })).toHaveFocus())
    expect((await accountItems(user, 'Savings')).map((i) => i.name)).toContain('Share with household: Savings')
  })

  it('once an account is deleted, focus moves to the next card\'s ⋯ (or the one before), else to Add account', { timeout: 20000 }, async () => {
    mockLoads({ accounts: [everyday(), savings(), acct({ id: 'c1', name: 'Cash', type: 2 })] })
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    const confirm = async (name: string) =>
      user.click(within(await screen.findByRole('dialog', { name: `Delete ${name}?` }, { timeout: 5000 })).getByRole('button', { name: 'Delete account' }))

    // The middle card: the card that takes its place gets the focus, not the page.
    await accountAction(user, 'Savings', 'Delete Savings')
    await confirm('Savings')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Savings' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cash: more actions' })).toHaveFocus())

    // The last card: the one before it.
    await accountAction(user, 'Cash', 'Delete Cash')
    await confirm('Cash')
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/accounts/c1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Everyday: more actions' })).toHaveFocus(), { timeout: 5000 })

    // The only card: the empty page's Add account.
    await accountAction(user, 'Everyday', 'Delete Everyday')
    await confirm('Everyday')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add account' })).toHaveFocus(), { timeout: 5000 })
    expect(screen.getByText('No accounts yet')).toBeInTheDocument()
  })

  it('on a phone, the ⋯ opens a sheet titled with the account\'s name, its note under the title; Edit opens the editor and gives focus back', { timeout: 20000 }, async () => {
    asPhone()
    mockLoads({ accounts: [everyday(), savings()] })
    const user = userEvent.setup()
    renderPage()

    const trigger = () => screen.getByRole('button', { name: 'Savings: more actions' })
    await user.click(await screen.findByRole('button', { name: 'Savings: more actions' }, { timeout: 5000 }))
    const sheet = await screen.findByRole('dialog', { name: 'Savings' }, { timeout: 5000 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(sheet).toHaveAccessibleDescription(/^Savings · EUR Held by Chris Opening €100\.00 on .*2026$/)
    const buttons = within(sheet)
      .getAllByRole('button')
      .filter((b) => b.textContent)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(buttons).toEqual(['Edit Savings', 'Make private: Savings', 'Delete Savings'])
    expect(within(sheet).getByRole('button', { name: 'Delete Savings' }).className).toMatch(/text-bad/)

    // Escape closes the sheet and gives focus back to the ⋯.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger()).toHaveFocus())

    // Edit from the sheet opens the editor in the row, focused on the name; Cancel gives focus back.
    await user.click(trigger())
    await user.click(within(await screen.findByRole('dialog', { name: 'Savings' })).getByRole('button', { name: 'Edit Savings' }))
    await waitFor(() => expect(screen.getByLabelText('Name for Savings')).toHaveFocus(), { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(trigger()).toHaveFocus(), { timeout: 5000 })

    // On a phone Add account sits under the KPIs, not in the top bar.
    const header = screen.getByRole('heading', { level: 1, name: 'Accounts' }).closest('header')!
    expect(within(header).queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add account' })).toHaveLength(1)
  })

  it('on a desktop Add account sits in the top bar', { timeout: 15000 }, async () => {
    asDesktop()
    mockLoads({ accounts: [everyday()] })
    renderPage()

    const header = (await screen.findByRole('heading', { level: 1, name: 'Accounts' }, { timeout: 5000 })).closest('header')!
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Add account' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Add account' })).toHaveLength(1)
  })

  it('the jar bar draws what the jars hold of the balance; the caption counts them and says what is not in jars, or the shortfall in red', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        everyday(),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, currentBalance: 700 }),
        acct({ id: 'l1', name: 'Legacy', currentBalance: null, openingDate: null, openingDateMissing: true }),
        acct({ id: 'n1', name: 'No jars', currentBalance: 50 }),
      ],
      reconciliation: [
        recon(),
        recon({ accountId: 'r1', accountName: 'Rainy Day', currentBalance: 700, backedJarsTotal: 1200, backedJarCount: 3, float: -500 }),
        recon({ accountId: 'l1', accountName: 'Legacy', currentBalance: 0, backedJarsTotal: 40, backedJarCount: 2, float: null }),
        recon({ accountId: 'n1', accountName: 'No jars', currentBalance: 50, backedJarsTotal: 0, backedJarCount: 0, float: 50 }),
      ],
    })
    const user = userEvent.setup()
    renderPage()

    await screen.findAllByTestId('account-jars', {}, { timeout: 5000 })
    const split = (name: string) => within(accountCard(name)).getByTestId('account-jars')
    const fill = (name: string) => split(name).firstElementChild!.firstElementChild as HTMLElement

    // Everyday: 100 of 250 in a jar, 150 not.
    expect(fill('Everyday').style.width).toBe('40%')
    expect(fill('Everyday').className).not.toContain('bg-bad')
    expect(within(split('Everyday')).getByText('1 jar')).toBeInTheDocument()
    const free = within(split('Everyday')).getByText('€150.00 not in jars')
    expect(free.parentElement!.className).not.toContain('text-bad')
    fireEvent.focus(within(split('Everyday')).getByRole('button', { name: 'About the money not in jars in Everyday' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Money in this account that no jar holds. Move money can put it in a jar.')
    fireEvent.blur(within(split('Everyday')).getByRole('button', { name: 'About the money not in jars in Everyday' }))

    // Rainy Day: the jars hold 500 more than it has (rule 70): a full red bar and the shortfall.
    expect(fill('Rainy Day').style.width).toBe('100%')
    expect(fill('Rainy Day').className).toContain('bg-bad')
    expect(within(split('Rainy Day')).getByText('3 jars')).toBeInTheDocument()
    expect(within(split('Rainy Day')).getByText('€500.00 over').parentElement!.className).toContain('text-bad')
    await user.hover(within(split('Rainy Day')).getByRole('button', { name: 'About the shortfall in Rainy Day' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Your jars hold more than this account has. Move money out of a jar to cover it.')
    await user.unhover(within(split('Rainy Day')).getByRole('button', { name: 'About the shortfall in Rainy Day' }))

    // No balance yet: the jars are counted, with no bar and nothing worked out from the balance.
    expect(within(split('Legacy')).getByText('2 jars')).toBeInTheDocument()
    expect(split('Legacy').querySelector('[aria-hidden].rounded-full')).toBeNull()
    expect(within(split('Legacy')).queryByText(/not in jars|over/)).not.toBeInTheDocument()

    // No jars: no bar at all.
    expect(within(accountCard('No jars')).queryByTestId('account-jars')).not.toBeInTheDocument()

    // The tiles: what the counted accounts' jars hold (100 + 1,200; Legacy, with no balance, is
    // left out as the total leaves it out), and the rest of their money (150 − 500 + 50).
    expect(screen.getByLabelText('Total balance: €1,000.00')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'In jars' })).toHaveTextContent('€1,300.00')
    expect(screen.getByRole('group', { name: 'Not in jars' })).toHaveTextContent('-€300.00')
    expect(within(screen.getByRole('group', { name: 'Not in jars' })).getByText('-€300.00').className).toContain('text-bad')
  })

  it('waits for the reconciliation under Loading…, then shows the KPI row and the jar lines at once, from its first answer', { timeout: 15000 }, async () => {
    // The first answer comes after the accounts; the re-read the loaded accounts start never
    // answers: the first answer is the one shown, and nothing shows before it.
    let answer: (v: { data: AccountReconciliationDto[] }) => void = () => {}
    let reconCalls = 0
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [everyday()] })
      if (url === '/accounts/reconciliation') {
        reconCalls += 1
        return reconCalls === 1 ? new Promise((resolve) => (answer = resolve)) : new Promise(() => {})
      }
      return Promise.resolve({ data: [] })
    })
    renderPage()

    await waitFor(() => expect(reconCalls).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Everyday' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Total balance:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your accounts' })).not.toBeInTheDocument()

    answer({ data: [recon()] })
    expect(await within(await screen.findByRole('article', { name: 'Everyday' }, { timeout: 5000 })).findByText('€150.00 not in jars')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'In jars' })).toHaveTextContent('€100.00')
    expect(screen.getByLabelText('Total balance: €250.00')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('a failed reconciliation still lets the page show, with no jar figures', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [everyday()] })
      if (url === '/accounts/reconciliation') return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: [] })
    })
    renderPage()

    await screen.findByRole('article', { name: 'Everyday' }, { timeout: 5000 })
    expect(screen.getByLabelText('Total balance: €250.00')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'In jars' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-jars')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names each account in a heading under "Your accounts", and tells same-named ⋯ apart by type and balance', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [acct({ id: 'j1', name: 'Joint' }), acct({ id: 'j2', name: 'Joint', type: 1, currentBalance: 900 })] })
    renderPage()

    await screen.findByRole('heading', { level: 2, name: 'Your accounts' }, { timeout: 5000 })
    expect(screen.getAllByRole('heading', { level: 3, name: 'Joint' })).toHaveLength(2)
    // Each ⋯ is described by its card's type tile (named by the type) and balance.
    const describedBy = (el: HTMLElement) =>
      (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => {
        const target = document.getElementById(id)
        return target?.getAttribute('aria-label') ?? target?.textContent
      })
    const [first, second] = screen.getAllByRole('button', { name: 'Joint: more actions' })
    expect(describedBy(first)).toEqual(['Current', '€250.00'])
    expect(describedBy(second)).toEqual(['Savings', '€900.00'])
  })

  it('the hero explains what it counts behind its (i), with what is left out under the number', { timeout: 15000 }, async () => {
    mockLoads({
      accounts: [
        everyday(),
        acct({ id: 'v1', name: 'Visa', type: 3, currentBalance: -75 }),
        acct({ id: 'uk', name: 'UK', currency: 'GBP', currentBalance: 10 }),
        acct({ id: 'r1', name: 'Rainy Day', type: 1, currentBalance: 40, pendingReceiptCount: 2, requiresReview: true }),
      ],
    })
    renderPage()

    expect(await screen.findByLabelText('Total balance: €215.00', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('€290.00 available')).toBeInTheDocument()
    expect(screen.getByText('1 account in another currency is not counted.')).toBeInTheDocument()
    expect(screen.getByText('2 transfer receipts pending review.')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About total balance' }))
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/^Your accounts in EUR added up\./)
    // Each receipt count is said once on the card too, never the type.
    expect(within(accountCard('Rainy Day')).getByText('2 receipts pending review')).toBeInTheDocument()
    expect(within(accountCard('Visa')).queryByText('Credit card')).not.toBeInTheDocument()
  })

  it('on a phone an account with no balance says so with no (i) of its own: the reason is in its sheet', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads({ accounts: [acct({ id: 'l1', name: 'Legacy', currentBalance: null, openingDate: null, openingDateMissing: true })] })
    const user = userEvent.setup()
    renderPage()

    const card = within(await screen.findByRole('article', { name: 'Legacy' }, { timeout: 5000 }))
    expect(card.getByText('Not available')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Why Legacy has no balance' })).not.toBeInTheDocument()
    await user.click(card.getByRole('button', { name: 'Legacy: more actions' }))
    const sheet = await screen.findByRole('dialog', { name: 'Legacy' }, { timeout: 5000 })
    expect(sheet).toHaveAccessibleDescription(/^Current · EUR Opening €100\.00 Set an opening date to calculate the balance\.$/)
  })

  it('a read-only login reads the ⋯\'s note behind an (i), with no ⋯ and no Add account', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [everyday()], role: 3 })
    const user = userEvent.setup()
    renderPage()

    const about = await screen.findByRole('button', { name: 'About Everyday' }, { timeout: 5000 })
    await user.hover(about)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toMatch(/^Current · EUR Opening €100\.00 on .*2026$/)
    expect(screen.queryByRole('button', { name: 'Everyday: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument()
  })

  it('a Limited holder still makes their own account private from its ⋯, and nothing else', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [everyday(), savings()], role: 2 })
    mockPut.mockResolvedValue({ data: { ...savings(), isPrivate: true } })
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('article', { name: 'Savings' }, { timeout: 5000 })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Everyday: more actions' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'About Everyday' })).toBeInTheDocument()
    expect(await accountItems(user, 'Savings')).toEqual([{ name: 'Make private: Savings', disabled: false }])
    await accountAction(user, 'Savings', 'Make private: Savings')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/accounts/s1/sharing', { isPrivate: true }))
  })

  it('reports an added account (with its type) and an edited one', { timeout: 15000 }, async () => {
    mockLoads({ accounts: [everyday()] })
    mockPost.mockResolvedValue({ data: acct({ id: 'w1', name: 'Wallet', type: 2 }) })
    mockPut.mockResolvedValue({ data: everyday() })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Add account' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Account name'), 'Wallet')
    await user.selectOptions(dialog.getByLabelText('Account type'), '2')
    await user.click(dialog.getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.accountCreated, { kind: 'Cash' }))

    await accountAction(user, 'Everyday', 'Edit Everyday')
    await user.click(screen.getByRole('button', { name: 'Save Everyday' }))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.accountEdited))
  })
})
