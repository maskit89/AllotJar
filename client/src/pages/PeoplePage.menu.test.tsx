import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, HouseholdMemberDto, MemberArchivePreviewDto, MemberSpendingDto, MembershipDto } from '../types'

// The restyled People page (restyle PR 8): one card per person, its actions behind a ⋯ (a menu on
// wider screens, a bottom sheet titled with the name on a phone) whose note says who the person
// signs in as; the editor opens in the card, takes the focus and gives it back to the ⋯; the ring
// round the avatar fills to the person's share of the month's income, which the plate under it says
// in words; the sign-ins not linked to a person are rows with a ⋯ of their own.
const { monthState } = vi.hoisted(() => ({
  monthState: { year: 2026, month: 7, label: 'July 2026', goPrev: () => {}, goNext: () => {}, goToMonth: () => {} },
}))
vi.mock('../features/MonthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/MonthContext')>()),
  useMonth: () => monthState,
}))
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

import { mockDelete, mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { personAction, personCard, personItems, personNote, signInAction, signInItems } from '../test/rowMenu'
import { EVENTS, track } from '../analytics'
import { PeoplePage } from './PeoplePage'

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 3000, budgetIncome: 3000, hasBudget: true, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

function membership(over: Partial<MembershipDto> = {}): MembershipDto {
  return { id: 'mem1', email: 'alex@x.eu', displayName: 'Alex', role: 0, status: 0, memberId: 'm1', isOwner: true, isSelf: true, createdUtc: '2026-01-01', ...over }
}

let membersData: HouseholdMemberDto[] = []
let membershipsData: MembershipDto[] = []
let accountsData: AccountDto[] | null = []
let spendingData: MemberSpendingDto[] = []
let meData: Record<string, unknown> = {}
let archivePreviews: Record<string, MemberArchivePreviewDto> = {}

function setupGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/members?year=2026&month=7' || url === '/members') return Promise.resolve({ data: membersData })
    if (url === '/access/members') return Promise.resolve({ data: membershipsData })
    if (url === '/accounts') return accountsData ? Promise.resolve({ data: accountsData }) : Promise.reject(new Error('500'))
    if (url === '/members/spending/2026/7') return Promise.resolve({ data: spendingData })
    if (url.startsWith('/members/income/')) return Promise.reject(new Error('404'))
    if (url === '/auth/me') return Promise.resolve({ data: meData })
    const preview = /^\/members\/([^/]+)\/archive-preview$/.exec(url)
    if (preview && archivePreviews[preview[1]]) return Promise.resolve({ data: archivePreviews[preview[1]] })
    return Promise.resolve({ data: {} })
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

const renderPage = () => renderWithProviders(<PeoplePage />)

/**
 * What a browser does when the control holding the focus is disabled: the focus falls to the page.
 * (jsdom won't blur a disabled control, so the focus passes through a stand-in on its way out.)
 */
function dropFocus() {
  const stand = document.createElement('button')
  document.body.append(stand)
  stand.focus()
  stand.blur()
  stand.remove()
  expect(document.body).toHaveFocus()
}
const trigger = (name: string) => screen.getByRole('button', { name: `${name}: more actions` })

// Alex (you, the owner, linked), Sam (a pending invite, Admin) and Robin (no sign-in).
const alex = () => member({ id: 'm1', name: 'Alex', budgetIncome: 3000, incomeSharePct: 0.75 })
const sam = () => member({ id: 'm2', name: 'Sam', netMonthlyIncome: 1000, budgetIncome: 1000, incomeSharePct: 0.25, displayOrder: 1 })
const robin = () => member({ id: 'm3', name: 'Robin', netMonthlyIncome: 0, budgetIncome: 0, incomeSharePct: 0, displayOrder: 2 })
const samLogin = () => membership({ id: 'mem2', email: 'sam@x.eu', displayName: 'Sam', role: 1, status: 1, memberId: 'm2', isOwner: false, isSelf: false })

describe('PeoplePage — the person ⋯ menu, its phone sheet, the editor\'s focus, the share ring and the sign-in rows', () => {
  beforeEach(() => {
    resetApiMocks()
    vi.mocked(track).mockClear()
    mockPost.mockResolvedValue({ data: {} })
    mockPut.mockResolvedValue({ data: {} })
    mockDelete.mockResolvedValue({ data: {} })
    membersData = [alex(), sam(), robin()]
    membershipsData = [membership(), samLogin()]
    accountsData = []
    spendingData = []
    meData = {}
    archivePreviews = {}
    setupGet()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('each ⋯ offers, in order, This is me, Invite to sign in, Edit, then Archive after a divider, each named for the person', { timeout: 20000 }, async () => {
    // Your own sign-in isn't linked to anyone yet.
    membershipsData = [membership({ memberId: null }), samLogin()]
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    expect(await personItems(user, 'Alex')).toEqual(['This is me', 'Invite to sign in', 'Edit Alex', 'Archive Alex'])
    // What This is me does, in the ⋯'s note (it was the button's tooltip before the restyle).
    expect(await personNote(user, 'Alex')).toEqual(['“This is me” links your sign-in to Alex.'])
    // A pending invite: Send again instead of This is me and the invite.
    expect(await personItems(user, 'Sam')).toEqual(['Send the email to Sam again', 'Edit Sam', 'Archive Sam'])

    // The items read short; Archive sits after a divider and is not in the warning red (it can be undone).
    await user.click(trigger('Alex'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['This is me', 'Invite to sign in', 'Edit', 'Archive'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: 'Archive Alex' }).className).not.toMatch(/text-bad/)
    await user.keyboard('{Escape}')
  })

  it('once your sign-in is linked, This is me leaves every ⋯; This isn\'t me shows only where it was linked before', { timeout: 20000 }, async () => {
    membersData = [alex(), sam(), member({ id: 'm3', name: 'Robin', incomeSharePct: 0, displayOrder: 2, canReleaseMyLink: true })]
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Robin' }, { timeout: 5000 })

    expect(await personItems(user, 'Alex')).toEqual(['Edit Alex', 'Archive Alex'])
    expect(await personItems(user, 'Robin')).toEqual(["This isn't me", 'Invite to sign in', 'Edit Robin', 'Archive Robin'])
    // Why This isn't me matters, in one short line (it used to take two).
    expect(await personNote(user, 'Robin')).toEqual(['Your sign-in was linked to Robin before, which stops Robin making their accounts private.'])
    // The ⋯'s note says who a person signs in as; the card doesn't.
    expect(await personNote(user, 'Sam')).toEqual(['Signs in as sam@x.eu'])
    expect(within(personCard('Sam')).queryByText(/sam@x\.eu/)).not.toBeInTheDocument()
  })

  it('works from the keyboard: Enter opens the ⋯, arrows move, Escape closes and gives focus back to the ⋯', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()

    const dots = await screen.findByRole('button', { name: 'Sam: more actions' }, { timeout: 5000 })
    dots.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveAccessibleDescription('Signs in as sam@x.eu')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Send the email to Sam again' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Edit Sam' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Archive Sam' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(dots).toHaveFocus()

    // Edit from the keyboard opens the editor on the name.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Name for Sam')).toHaveFocus(), { timeout: 5000 })
  })

  it('the editor takes the focus on its name, keeps its labels, and gives focus back to the ⋯ on Escape, Cancel and Save', { timeout: 20000 }, async () => {
    accountsData = [{ id: 'a1', name: 'Joint', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 }]
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })

    // Escape.
    await personAction(user, 'Sam', 'Edit Sam')
    await waitFor(() => expect(screen.getByLabelText('Name for Sam')).toHaveFocus())
    const card = within(personCard('Sam'))
    for (const label of ['Name', 'Default income', 'Savings account']) expect(card.getByText(label)).toBeInTheDocument()
    expect(card.getByLabelText('Default income for Sam')).toHaveValue('1000')
    expect(card.getByLabelText('Savings account for Sam')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'About the default income' })).toBeInTheDocument()
    // The sign-in's email, its access level and Remove sit in the editor.
    expect(card.getByText('sam@x.eu')).toBeInTheDocument()
    expect(card.getByLabelText('Access level for Sam')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Remove sign-in for Sam' })).toBeInTheDocument()
    // While it is open the card shows no ⋯ of its own, nor its figures.
    expect(screen.queryByRole('button', { name: 'Sam: more actions' })).not.toBeInTheDocument()
    expect(card.queryByText('Saves to')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Name for Sam')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('Sam')).toHaveFocus())

    // Cancel.
    await personAction(user, 'Sam', 'Edit Sam')
    await user.click(await screen.findByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(trigger('Sam')).toHaveFocus())
    expect(mockPut).not.toHaveBeenCalled()

    // Save.
    await personAction(user, 'Sam', 'Edit Sam')
    await user.click(await screen.findByRole('button', { name: 'Save Sam' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/members/m2', expect.objectContaining({ name: 'Sam', netMonthlyIncome: 1000 })))
    await waitFor(() => expect(screen.queryByLabelText('Name for Sam')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('Sam')).toHaveFocus())
    expect(track).toHaveBeenCalledWith(EVENTS.memberEdited)
  })

  it('the editor\'s access level and Remove act at once; once the sign-in is removed, focus stays in the editor', { timeout: 20000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })

    await personAction(user, 'Sam', 'Edit Sam')
    await user.selectOptions(screen.getByLabelText('Access level for Sam'), 'Limited')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/access/members/mem2/role', { role: 2 }))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.memberRoleChanged, { kind: 'Limited' }))

    membershipsData = [membership()]
    await user.click(screen.getByRole('button', { name: 'Remove sign-in for Sam' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/access/members/mem2'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove sign-in for Sam' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText('Name for Sam')).toHaveFocus())
    expect(track).toHaveBeenCalledWith(EVENTS.memberRevoked)
  })

  it('the access level has a caption, and keeps the focus while it saves; a failed Save keeps it on Save', { timeout: 20000 }, async () => {
    let release: () => void = () => {}
    let fail: () => void = () => {}
    mockPut.mockImplementation((url: string) =>
      url.endsWith('/role')
        ? new Promise((resolve) => {
            release = () => resolve({ data: {} })
          })
        : new Promise((_, reject) => {
            fail = () => reject(Object.assign(new Error('500'), { isAxiosError: true, response: { status: 500, data: {} } }))
          }),
    )
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })

    await personAction(user, 'Sam', 'Edit Sam')
    const card = within(personCard('Sam'))
    // A caption for the eye, as the other fields have; the select keeps its full name.
    expect(card.getByText('Access level')).toHaveAttribute('aria-hidden')
    const select = card.getByLabelText('Access level for Sam')
    await user.selectOptions(select, 'Limited')
    await waitFor(() => expect(select).toBeDisabled())
    // A browser drops the focus from a control that is disabled while it holds it.
    dropFocus()
    release()
    await waitFor(() => expect(select).toBeEnabled())
    await waitFor(() => expect(select).toHaveFocus())

    // Save is disabled while it runs too: when the save fails, the focus is back on Save.
    const save = card.getByRole('button', { name: 'Save Sam' })
    await user.click(save)
    await waitFor(() => expect(save).toBeDisabled())
    dropFocus()
    fail()
    expect(await screen.findByText('Could not save that person.')).toBeInTheDocument()
    await waitFor(() => expect(save).toHaveFocus())
  })

  it('once a person is archived, focus moves to the next card\'s ⋯ (or the one before), else to Add person', { timeout: 20000 }, async () => {
    mockPut.mockImplementation((url: string) => {
      const m = /^\/members\/([^/]+)\/archive$/.exec(url)
      if (m) membersData = membersData.filter((p) => p.id !== m[1])
      return Promise.resolve({ data: {} })
    })
    membershipsData = []
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Robin' }, { timeout: 5000 })

    // The middle card: the card that takes its place gets the focus.
    await personAction(user, 'Sam', 'Archive Sam')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Sam' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger('Robin')).toHaveFocus())

    // The last card: the one before it.
    await personAction(user, 'Robin', 'Archive Robin')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Robin' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger('Alex')).toHaveFocus())

    // The only card: Add person.
    await personAction(user, 'Alex', 'Archive Alex')
    await waitFor(() => expect(screen.getByText('Budgeting on your own?')).toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add person' })).toHaveFocus())
  })

  it('the pocket-money question gives focus back to the ⋯ when nothing is archived, and on to the next card when it is', { timeout: 20000 }, async () => {
    archivePreviews = {
      m2: { id: 'm2', name: 'Sam', isArchived: false, thisMonth: { year: 2026, month: 7, planned: 100, paid: 0, remaining: 100, waitingForConvertedAmount: false }, futureMonths: [] },
    }
    mockPut.mockImplementation((url: string) => {
      if (url === '/members/m2/archive') membersData = [alex(), robin()]
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })

    await personAction(user, 'Sam', 'Archive Sam')
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Don’t archive' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('Sam')).toHaveFocus())
    expect(mockPut).not.toHaveBeenCalled()

    await personAction(user, 'Sam', 'Archive Sam')
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Keep this month’s pocket money and archive' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/members/m2/archive', { archived: true, pocketMoneyThisMonth: 0 }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Sam' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger('Robin')).toHaveFocus())
  })

  it('Invite to sign in opens the invite, which gives focus back to the ⋯ when it closes, and reports the invite', { timeout: 20000 }, async () => {
    mockPost.mockResolvedValue({ data: { membership: membership({ id: 'mem9', email: 'robin@x.eu', memberId: 'm3', isOwner: false, isSelf: false, status: 1 }) } })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Robin' }, { timeout: 5000 })

    await personAction(user, 'Robin', 'Invite to sign in')
    let dialog = within(await screen.findByRole('dialog', { name: 'Invite Robin to sign in' }, { timeout: 5000 }))
    await user.click(dialog.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('Robin')).toHaveFocus())

    await personAction(user, 'Robin', 'Invite to sign in')
    dialog = within(await screen.findByRole('dialog', { name: 'Invite Robin to sign in' }, { timeout: 5000 }))
    let answer: (v: unknown) => void = () => {}
    mockPost.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await user.type(dialog.getByLabelText('Invitee email'), 'robin@x.eu')
    await user.click(dialog.getByRole('button', { name: 'Send invite' }))
    // "Inviting…" is disabled while the invite runs, which drops the focus in a browser.
    expect(dialog.getByRole('button', { name: 'Inviting…' })).toBeDisabled()
    dropFocus()
    answer({ data: { membership: membership({ id: 'mem9', email: 'robin@x.eu', memberId: 'm3' }), emailSent: true } })
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.memberInvited, { method: 'link' }))
    expect(await dialog.findByRole('status')).toHaveTextContent('Invite sent')
    // The focus is back in the dialog, on its button, so Escape and Tab work again.
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Send invite' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('Robin')).toHaveFocus())
  })

  it('a read-only login reads a card\'s note behind an (i), with no ⋯ and no Add person; This isn\'t me leaves focus on the card', { timeout: 20000 }, async () => {
    meData = { role: 3 }
    membersData = [alex(), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.25, displayOrder: 1, canReleaseMyLink: true })]
    membershipsData = []
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('article', { name: 'Sam' }, { timeout: 5000 })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Alex: more actions' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
    const hint = within(personCard('Alex')).getByRole('button', { name: 'About Alex' })
    fireEvent.focus(hint)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('No sign-in')
    fireEvent.blur(hint)

    // Sam's ⋯ has only This isn't me; once said, the ⋯ goes and focus stays on Sam's card.
    expect(await personItems(user, 'Sam')).toEqual(["This isn't me"])
    membersData = [alex(), member({ id: 'm2', name: 'Sam', incomeSharePct: 0.25, displayOrder: 1 })]
    await personAction(user, 'Sam', "This isn't me")
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/access/people/m2/not-me'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sam: more actions' })).not.toBeInTheDocument())
    await waitFor(() => expect(within(personCard('Sam')).getByRole('button', { name: 'About Sam' })).toHaveFocus())
  })

  it('on a phone, the ⋯ opens a sheet titled with the name, its note under the title; Edit opens the editor and gives focus back', { timeout: 20000 }, async () => {
    asPhone()
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Sam: more actions' }, { timeout: 5000 }))
    const sheet = await screen.findByRole('dialog', { name: 'Sam' }, { timeout: 5000 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(sheet).toHaveAccessibleDescription('Signs in as sam@x.eu')
    const buttons = within(sheet)
      .getAllByRole('button')
      .filter((b) => b.textContent)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(buttons).toEqual(['Send the email to Sam again', 'Edit Sam', 'Archive Sam'])

    // Escape closes the sheet and gives focus back to the ⋯.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger('Sam')).toHaveFocus())

    // Edit from the sheet opens the editor in the card, focused on the name; Cancel gives focus back.
    await user.click(trigger('Sam'))
    await user.click(within(await screen.findByRole('dialog', { name: 'Sam' })).getByRole('button', { name: 'Edit Sam' }))
    await waitFor(() => expect(screen.getByLabelText('Name for Sam')).toHaveFocus(), { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(trigger('Sam')).toHaveFocus(), { timeout: 5000 })

    // On a phone Add person sits under the KPIs, not in the top bar.
    const header = screen.getByRole('heading', { level: 1, name: 'People' }).closest('header')!
    expect(within(header).queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add person' })).toHaveLength(1)
  })

  it('on a desktop Add person sits in the top bar, and adding a person is reported', { timeout: 15000 }, async () => {
    asDesktop()
    mockPost.mockResolvedValue({ data: member({ id: 'm9', name: 'Kim' }) })
    const user = userEvent.setup()
    renderPage()

    const header = (await screen.findByRole('heading', { level: 1, name: 'People' }, { timeout: 5000 })).closest('header')!
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Add person' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Add person' })).toHaveLength(1)

    await user.click(within(header).getByRole('button', { name: 'Add person' }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.type(dialog.getByLabelText('Person name'), 'Kim')
    await user.click(dialog.getByRole('button', { name: 'Add person' }))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.memberAdded))
  })

  it('the ring fills to the person\'s share, which the plate says in words with an (i)', { timeout: 15000 }, async () => {
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    const plate = (name: string) => within(personCard(name)).getByText(/^\d+%$/)
    expect(plate('Alex')).toHaveTextContent('75% of income')
    expect(plate('Sam')).toHaveTextContent('25% of income')
    expect(plate('Robin')).toHaveTextContent('0% of income')

    // The arc: a 360° ring with a 110° gap at the bottom (r 28): 250° of track, filled to the share.
    const c = 2 * Math.PI * 28
    const track = (c * 250) / 360
    const arc = (name: string) => personCard(name).querySelector('[data-testid="share-arc"]')
    expect(arc('Alex')).toHaveAttribute('stroke-dasharray', `${(track * 0.75).toFixed(1)} ${c.toFixed(1)}`)
    expect(arc('Sam')).toHaveAttribute('stroke-dasharray', `${(track * 0.25).toFixed(1)} ${c.toFixed(1)}`)
    // No share, no arc: only the track.
    expect(arc('Robin')).toBeNull()
    // The drawing is decoration; the plate says it.
    expect(personCard('Alex').querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    const hint = within(personCard('Alex')).getByRole('button', { name: 'About Alex’s share of income' })
    fireEvent.focus(hint)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Their part of this month’s income.')
    fireEvent.blur(hint)

    // A screen reader reaches the name first, then the share (the ring is first only on screen).
    const heading = within(personCard('Alex')).getByRole('heading', { level: 2, name: 'Alex' })
    expect(heading.compareDocumentPosition(plate('Alex')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(plate('Alex').closest('div')).toHaveClass('order-first')
  })

  it('a month with no budget has no income figures: no ring and no share, only the avatar in its place', { timeout: 15000 }, async () => {
    membersData = [
      member({ id: 'm1', name: 'Alex', budgetIncome: 0, incomeSharePct: 0, hasBudget: false }),
      member({ id: 'm2', name: 'Sam', budgetIncome: 0, incomeSharePct: 0, displayOrder: 1, hasBudget: false }),
    ]
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    expect(screen.getByText(/No budget for July 2026 yet/)).toBeInTheDocument()
    for (const name of ['Alex', 'Sam']) {
      const card = personCard(name)
      expect(within(card).queryByText(/^\d+%$/)).not.toBeInTheDocument()
      expect(within(card).queryByRole('button', { name: `About ${name}’s share of income` })).not.toBeInTheDocument()
      // No ring drawn (the ⋯'s own icon is the only drawing left).
      expect(card.querySelector('svg[viewBox="0 0 60 60"]')).toBeNull()
      expect(within(card).getByText(name[0])).toBeInTheDocument()
    }
  })

  it('a household that couldn\'t be read says so, and not that you budget on your own', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) =>
      url.startsWith('/members?') ? Promise.reject(new Error('500')) : Promise.resolve({ data: url === '/access/members' ? membershipsData : [] }),
    )
    renderPage()
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Could not load your household.')
    expect(screen.queryByText('Budgeting on your own?')).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add person' })).toBeEnabled()
  })

  it('with no people and no budget for the month, the empty state says so, with the way to start one', { timeout: 15000 }, async () => {
    membersData = []
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/members/income/')) return Promise.resolve({ data: { incomeFromBudget: true, hasBudget: false, fxPendingCount: 0, unattributedPlanned: 0, items: [] } })
      if (url === '/access/members') return Promise.resolve({ data: membershipsData })
      return Promise.resolve({ data: url.startsWith('/members') ? [] : url === '/auth/me' ? meData : [] })
    })
    renderPage()
    expect(await screen.findByText('Budgeting on your own?', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/No budget for July 2026 yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the Dashboard' })).toHaveAttribute('href', '/')
  })

  it('a card shows the month\'s income, what was spent and where the person saves, "None" in words when nowhere', { timeout: 15000 }, async () => {
    accountsData = [{ id: 'a1', name: 'Joint', type: 1, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0 }]
    membersData = [
      member({ id: 'm1', name: 'Alex', netMonthlyIncome: 2500, budgetIncome: 3000, incomeSharePct: 0.75, personalSavingsAccountId: 'a1' }),
      sam(),
    ]
    spendingData = [
      { memberId: 'm1', name: 'Alex', spent: 120.5, fxPendingCount: 0 },
      { memberId: 'm2', name: 'Sam', spent: 80, fxPendingCount: 1 },
    ]
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    const alexCard = within(personCard('Alex'))
    const stat = (card: typeof alexCard, label: string) => card.getByText(label).parentElement!
    expect(stat(alexCard, 'Income')).toHaveTextContent('Income€3,000.00default €2,500.00')
    expect(stat(alexCard, 'Spent')).toHaveTextContent('Spent€120.50')
    expect(stat(alexCard, 'Saves to')).toHaveTextContent('Saves toJoint')

    const samCard = within(personCard('Sam'))
    // The payment still waiting for its € amount: one short line, all of it on screen.
    expect(stat(samCard, 'Spent')).toHaveTextContent('Spent€80.00+1 needs € amount')
    expect(within(stat(samCard, 'Spent')).getByText('+1 needs € amount')).not.toHaveClass('sr-only')
    // Nowhere: a dash for the eye, "None" for a screen reader.
    const none = stat(samCard, 'Saves to')
    expect(within(none).getByText('—')).toHaveAttribute('aria-hidden')
    expect(within(none).getByText('None')).toHaveClass('sr-only')
  })

  it('an account the list couldn\'t load is "Unknown", not "None"', { timeout: 15000 }, async () => {
    accountsData = null
    membersData = [member({ personalSavingsAccountId: 'a1' }), member({ id: 'm2', name: 'Sam', displayOrder: 1, incomeSharePct: 0 })]
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })
    expect(within(personCard('Alex')).getByText('Unknown')).toHaveClass('sr-only')
    expect(within(personCard('Sam')).getByText('None')).toHaveClass('sr-only')
  })

  it('the KPI row: the hero says the month\'s income, the Spent tile what everyone spent, each with an (i)', { timeout: 15000 }, async () => {
    spendingData = [
      { memberId: 'm1', name: 'Alex', spent: 120, fxPendingCount: 0 },
      { memberId: 'm2', name: 'Sam', spent: 80, fxPendingCount: 0 },
    ]
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    expect(screen.getByLabelText('Income this month: €4,000.00')).toHaveTextContent('€4,000.00')
    const spent = screen.getByRole('group', { name: 'Spent' })
    expect(within(spent).getByLabelText('Spent this month: €200.00')).toHaveTextContent('€200.00')

    fireEvent.focus(screen.getByRole('button', { name: 'About income' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^The income lines in July 2026’s budget: each person’s own lines/)
    fireEvent.blur(screen.getByRole('button', { name: 'About income' }))
    fireEvent.focus(within(spent).getByRole('button', { name: 'About spent' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^What each person spent in July 2026/)
  })

  it('a card\'s chips: You, the access level, and Invited (in the warning tone) only while the invite is pending', { timeout: 15000 }, async () => {
    renderPage()
    await screen.findByRole('article', { name: 'Alex' }, { timeout: 5000 })

    const alexCard = within(personCard('Alex'))
    expect(alexCard.getByText('You')).toBeInTheDocument()
    expect(alexCard.getByText('Owner')).toBeInTheDocument()
    expect(alexCard.queryByText('Invited')).not.toBeInTheDocument()
    const samCard = within(personCard('Sam'))
    expect(samCard.queryByText('You')).not.toBeInTheDocument()
    expect(samCard.getByText('Admin')).toBeInTheDocument()
    expect(samCard.getByText('Invited').className).toMatch(/warn/)
    // No sign-in: no chips at all.
    expect(within(personCard('Robin')).queryByText(/You|Owner|Admin|Limited|Read-only|Invited/)).not.toBeInTheDocument()
    // Each name is its card's heading.
    expect(screen.getByRole('heading', { level: 2, name: 'Alex' })).toBeInTheDocument()
  })

  it('a sign-in row\'s ⋯: Send again, Link to a person (the picker in the row), then Remove in red after a divider', { timeout: 20000 }, async () => {
    membersData = [alex(), robin()]
    membershipsData = [
      membership(),
      membership({ id: 'mem8', email: 'kim@x.eu', displayName: null, role: 3, status: 1, memberId: null, isOwner: false, isSelf: false }),
      membership({ id: 'mem9', email: 'jo@x.eu', displayName: 'Jo', role: 2, status: 0, memberId: null, isOwner: false, isSelf: false }),
    ]
    mockPost.mockResolvedValue({ data: { emailSent: true } })
    const user = userEvent.setup()
    renderPage()
    const card = (await screen.findByRole('heading', { name: 'Other sign-ins' }, { timeout: 5000 })).closest('section')!
    const rows = within(card).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Invited').className).toMatch(/warn/)
    expect(within(rows[0]).getByText('Read-only')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('Invited')).not.toBeInTheDocument()
    expect(within(rows[1]).getByText('jo@x.eu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About other sign-ins' })).toBeInTheDocument()

    expect(await signInItems(user, 'kim@x.eu')).toEqual(['Send the email to kim@x.eu again', 'Link kim@x.eu to a person', 'Remove kim@x.eu'])
    await user.click(screen.getByRole('button', { name: 'Sign-in kim@x.eu: more actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Send again', 'Link to a person', 'Remove'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: 'Remove kim@x.eu' }).className).toMatch(/text-bad/)
    await user.keyboard('{Escape}')

    // Send again: the answer shows in the row.
    await signInAction(user, 'kim@x.eu', 'Send the email to kim@x.eu again')
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/access/members/mem8/resend'))
    expect(await within(rows[0]).findByRole('status')).toHaveTextContent("We've emailed kim@x.eu a new link. The earlier one no longer works.")

    // Link to a person: the picker opens in the row with the focus; Escape closes it and gives focus back.
    await signInAction(user, 'jo@x.eu', 'Link jo@x.eu to a person')
    const picker = await screen.findByRole('combobox', { name: 'Link jo@x.eu to a person' })
    await waitFor(() => expect(picker).toHaveFocus())
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Link to a person…', 'Robin'])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Link jo@x.eu to a person' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign-in jo@x.eu: more actions' })).toHaveFocus())

    // Picking a person links the sign-in, which moves onto their card: focus goes to that card's ⋯.
    mockPut.mockImplementation((url: string) => {
      if (url === '/access/members/mem9/link') membershipsData = [membershipsData[0], membershipsData[1], { ...membershipsData[2], memberId: 'm3' }]
      return Promise.resolve({ data: {} })
    })
    await signInAction(user, 'jo@x.eu', 'Link jo@x.eu to a person')
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Link jo@x.eu to a person' }), 'm3')
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/access/members/mem9/link', { memberId: 'm3' }))
    await waitFor(() => expect(within(personCard('Robin')).getByText('Limited')).toBeInTheDocument())
    await waitFor(() => expect(trigger('Robin')).toHaveFocus())
  })

  it('removing a sign-in moves focus to the next row\'s ⋯, else to Add person', { timeout: 20000 }, async () => {
    membershipsData = [
      membership(),
      membership({ id: 'mem8', email: 'kim@x.eu', displayName: null, role: 3, status: 1, memberId: null, isOwner: false, isSelf: false }),
      membership({ id: 'mem9', email: 'jo@x.eu', displayName: 'Jo', role: 2, status: 0, memberId: null, isOwner: false, isSelf: false }),
    ]
    mockDelete.mockImplementation((url: string) => {
      membershipsData = membershipsData.filter((m) => `/access/members/${m.id}` !== url)
      return Promise.resolve({ data: {} })
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'Other sign-ins' }, { timeout: 5000 })

    await signInAction(user, 'kim@x.eu', 'Remove kim@x.eu')
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/access/members/mem8'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign-in jo@x.eu: more actions' })).toHaveFocus(), { timeout: 5000 })

    await signInAction(user, 'jo@x.eu', 'Remove Jo')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Other sign-ins' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add person' })).toHaveFocus())
  })

  it('on a phone a sign-in\'s ⋯ opens a sheet titled with its name or email', { timeout: 15000 }, async () => {
    asPhone()
    membershipsData = [membership(), membership({ id: 'mem8', email: 'kim@x.eu', displayName: null, role: 3, status: 1, memberId: null, isOwner: false, isSelf: false })]
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Sign-in kim@x.eu: more actions' }, { timeout: 5000 }))
    const sheet = await screen.findByRole('dialog', { name: 'kim@x.eu' }, { timeout: 5000 })
    const buttons = within(sheet)
      .getAllByRole('button')
      .filter((b) => b.textContent)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(buttons).toEqual(['Send the email to kim@x.eu again', 'Link kim@x.eu to a person', 'Remove kim@x.eu'])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign-in kim@x.eu: more actions' })).toHaveFocus())
  })

  it('on a phone a named sign-in\'s sheet says its email under the name, so it can\'t pass for the person\'s', { timeout: 15000 }, async () => {
    asPhone()
    membershipsData = [membership(), membership({ id: 'mem9', email: 'sam.work@x.eu', displayName: 'Sam', role: 2, status: 0, memberId: null, isOwner: false, isSelf: false })]
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Sign-in sam.work@x.eu: more actions' }, { timeout: 5000 }))
    const sheet = await screen.findByRole('dialog', { name: 'Sam' }, { timeout: 5000 })
    expect(sheet).toHaveAccessibleDescription('sam.work@x.eu')
    expect(within(sheet).getByRole('button', { name: 'Remove Sam' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
  })
})
