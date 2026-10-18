import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import type { HouseholdMemberDto, MeResponse } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

import { mockGet, mockPut, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { EVENTS, track } from '../analytics'
import { AccountPage } from './AccountPage'
import { joinedMe as sharedJoinedMe, ownerMe } from '../test/fixtures/me'

// Sam, a member who only joined someone else's household (no household of their own).
const joinedMe = sharedJoinedMe(2)

function member(over: Partial<HouseholdMemberDto> = {}): HouseholdMemberDto {
  return { id: 'm1', name: 'Alex', netMonthlyIncome: 6000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 1, ...over }
}

// The Household card reads /members; everything else (/auth/me) returns the login.
let membersData: HouseholdMemberDto[] = []
let meData: MeResponse = ownerMe

const renderPage = () => renderWithProviders(<AccountPage />, { household: true })
const W = { timeout: 5000 }

/** The text behind the (i) named `name` (it renders only while open), read as a pointer would. */
async function hintText(user: UserEvent, name: string): Promise<string> {
  const button = await screen.findByRole('button', { name }, W)
  await user.hover(button)
  const text = (await screen.findByRole('tooltip', {}, W)).textContent ?? ''
  await user.unhover(button)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  return text
}

/** Opens the Change password dialog from the Password row's "Change" (named "Change password"). */
async function openChangePassword(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Change password' }, W))
  return screen.findByRole('dialog', { name: 'Change password' }, W)
}

/** Opens the Leave dialog from the Household card's ⋯. */
async function openLeave(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Household: more actions' }, W))
  await user.click(await screen.findByRole('menuitem', { name: 'Leave household' }, W))
  return screen.findByRole('dialog', { name: /^Leave/ }, W)
}

/** Makes the page's media queries answer as on a phone (jsdom has no matchMedia). */
function asPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 699.98px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('AccountPage', () => {
  beforeEach(() => {
    resetApiMocks()
    vi.mocked(track).mockClear()
    membersData = []
    meData = ownerMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      return Promise.resolve({ data: meData })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects mismatched new passwords without calling the API', async () => {
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    await user.type(within(dialog).getByLabelText('Current password'), 'oldpassword')
    await user.type(within(dialog).getByLabelText('New password'), 'newpassword1')
    await user.type(within(dialog).getByLabelText('Confirm new password'), 'different1')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

    expect(await within(dialog).findByText(/do not match/)).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('offers to share the budget when solo (no members)', async () => {
    membersData = []

    renderPage()

    expect(
      await screen.findByRole('button', { name: 'Share this budget' }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getByText('Just you')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage people' })).not.toBeInTheDocument()
  })

  it('still offers to share when there is a single member (still solo)', async () => {
    membersData = [member()]

    renderPage()

    expect(
      await screen.findByRole('button', { name: 'Share this budget' }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage people' })).not.toBeInTheDocument()
  })

  it('links to manage members when the budget is shared (2+ members)', async () => {
    membersData = [member(), member({ id: 'm2', name: 'Sam' })]

    renderPage()

    const manage = await screen.findByRole('link', { name: 'Manage people' }, { timeout: 5000 })
    expect(manage).toHaveAttribute('href', '/people')
    // Who shares it: their faces (named by how many) and their names.
    expect(screen.getByRole('img', { name: 'Shared between 2 people' })).toBeInTheDocument()
    expect(screen.getByText('Alex & Sam')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share this budget' })).not.toBeInTheDocument()
  })

  it('names three or more people with commas and an ampersand', async () => {
    membersData = [member(), member({ id: 'm2', name: 'Sam' }), member({ id: 'm3', name: 'Robin' })]

    renderPage()

    expect(await screen.findByRole('img', { name: 'Shared between 3 people' }, W)).toBeInTheDocument()
    expect(screen.getByText('Alex, Sam & Robin')).toBeInTheDocument()
  })

  it('does not offer to start an own budget or leave when you own the household', async () => {
    meData = ownerMe

    renderPage()

    // The page rendered, under the menu item's words.
    expect(await screen.findByRole('heading', { level: 1, name: 'Account settings' }, W)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start my own budget' })).not.toBeInTheDocument()
    // Leave household lives behind the Household card's ⋯, which only a joined household has.
    await screen.findByRole('heading', { name: 'Household' }, W)
    await screen.findByRole('button', { name: 'Share this budget' }, W)
    expect(screen.queryByRole('button', { name: 'Household: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave household' })).not.toBeInTheDocument()
    expect(screen.queryByText('Your own budget')).not.toBeInTheDocument()
  })

  it('lets a member without an own budget start one', async () => {
    meData = joinedMe
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    const start = await screen.findByRole('button', { name: 'Start my own budget' }, { timeout: 5000 })
    expect(start).toHaveTextContent('Start')
    await user.click(start)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/households/start-own'))
  })

  it('says “Setting up…” while the own budget is being started, and why it failed', async () => {
    meData = joinedMe
    let fail: (e: unknown) => void = () => {}
    mockPost.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Start my own budget' }, W))
    const busy = await screen.findByRole('button', { name: 'Setting up…' }, W)
    expect(busy).toBeDisabled()
    fail(new Error('down'))
    expect(await screen.findByRole('alert', {}, W)).toHaveTextContent('Could not start your budget. Please try again.')
    expect(screen.getByRole('button', { name: 'Start my own budget' })).toBeEnabled()
  })

  it('lets a member leave a household they joined, after confirming', async () => {
    meData = joinedMe
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    // Behind the Household card's ⋯; a dialog asks first.
    const dialog = await openLeave(user)
    expect(dialog).toHaveAccessibleName('Leave Alex’s household?')
    expect(mockPost).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Yes, leave' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/households/leave', { ownerId: 'owner-1', privateAccounts: 0 }),
    )
  })

  // D4 (S-P3-7): leaving makes your private accounts there reachable by nobody, and the owner may
  // erase them, so the confirm step says how many before you leave.
  it('warns with the count of private accounts before a member leaves, and sends the count it showed', async () => {
    meData = joinedMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      if (url === '/households/leave-preview?ownerId=owner-1') return Promise.resolve({ data: { privateAccounts: 2 } })
      return Promise.resolve({ data: meData })
    })
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openLeave(user)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You keep 2 private accounts in this household. Once you leave, nobody can see them, and the owner can erase them for good.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Yes, leave' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/households/leave', { ownerId: 'owner-1', privateAccounts: 2 }),
    )
  })

  // The server labels a joined household with its owner's name, or plainly "Household" when the
  // owner has none (AuthController /auth/me): never "Household’s household".
  it('asks to leave “this household” when the owner has no name (the server’s label “Household”)', async () => {
    meData = sharedJoinedMe(2, {
      households: [{ ownerId: 'owner-1', label: 'Household', role: 2, isActive: true, isOwn: false }],
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openLeave(user)
    expect(dialog).toHaveAccessibleName('Leave this household?')
    expect(within(dialog).getByText(/You’ll no longer see its budget, and the owner isn’t needed to do this\. You can be invited back anytime\./)).toBeInTheDocument()
    expect(screen.queryByText(/Household’s household/)).not.toBeInTheDocument()
  })

  it('on a phone, the Household sheet of an owner with no name is “This household”', async () => {
    asPhone()
    meData = sharedJoinedMe(2, {
      households: [{ ownerId: 'owner-1', label: 'Household', role: 2, isActive: true, isOwn: false }],
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Household: more actions' }, W))
    const sheet = await screen.findByRole('dialog', { name: 'This household' }, W)
    await user.click(within(sheet).getByRole('button', { name: 'Leave household' }))
    expect(await screen.findByRole('dialog', { name: 'Leave this household?' }, W)).toBeInTheDocument()
  })

  it('warns in the singular for one private account', async () => {
    meData = joinedMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      if (url.startsWith('/households/leave-preview')) return Promise.resolve({ data: { privateAccounts: 1 } })
      return Promise.resolve({ data: meData })
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openLeave(user)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You keep 1 private account in this household. Once you leave, nobody can see it, and the owner can erase it for good. To keep it visible, share it on the Accounts page first.',
    )
  })

  it('shows the count when the server refuses a leave the warning did not cover', async () => {
    meData = joinedMe
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { error: 'You keep 1 private account in this household.', privateAccounts: 1 } },
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openLeave(user)
    await user.click(within(dialog).getByRole('button', { name: 'Yes, leave' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You keep 1 private account in this household.')
    const leave = within(dialog).getByRole('button', { name: 'Yes, leave' })
    expect(leave).toBeEnabled()
    expect(leave).not.toHaveAttribute('aria-disabled')
    // It kept the focus it was pressed with, so the keyboard is still in the dialog.
    expect(leave).toHaveFocus()
  })

  it('keeps the Leave dialog open with the reason when leaving fails', async () => {
    meData = joinedMe
    mockPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openLeave(user)
    await user.click(within(dialog).getByRole('button', { name: 'Yes, leave' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not leave this household. Please try again.')
    // Cancel clears the reason: the next ask starts clean.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    const again = await openLeave(user)
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('the Leave dialog: Escape and Cancel close it and give focus back to the ⋯; nothing closes it while leaving', async () => {
    meData = joinedMe
    let finish: (v: unknown) => void = () => {}
    mockPost.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const user = userEvent.setup()

    renderPage()

    const more = await screen.findByRole('button', { name: 'Household: more actions' }, W)
    let dialog = await openLeave(user)
    // Focus opens on the dialog's close control.
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(more).toHaveFocus())

    dialog = await openLeave(user)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(more).toHaveFocus())

    dialog = await openLeave(user)
    await user.click(within(dialog).getByRole('button', { name: 'Yes, leave' }))
    // Unavailable while leaving, but aria-disabled rather than disabled: it keeps its focus (a
    // disabled button would drop it to the page behind the dialog), and a second press does nothing.
    const leaving = await within(dialog).findByRole('button', { name: 'Leaving…' })
    expect(leaving).toHaveAttribute('aria-disabled', 'true')
    expect(leaving).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(mockPost.mock.calls.filter(([url]) => url === '/households/leave')).toHaveLength(1)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    within(dialog).getByRole('button', { name: 'Close' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Leave Alex’s household?' })).toBeInTheDocument()
    finish({ data: null })
  })

  it('the Household ⋯ holds only Leave household, and only for a household you joined', async () => {
    meData = joinedMe
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Household: more actions' }, W))
    const menu = await screen.findByRole('menu', {}, W)
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Leave household'])
  })

  // T8: Start and Leave don't wait for /members; only the sharing row does (as the Sharing card did).
  it('while the household loads: no sharing row, but Start and the ⋯ are there', async () => {
    meData = joinedMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return new Promise(() => {})
      return Promise.resolve({ data: meData })
    })

    renderPage()

    expect(await screen.findByRole('button', { name: 'Start my own budget' }, W)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Household: more actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share this budget' })).not.toBeInTheDocument()
    expect(screen.queryByText('Just you')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage people' })).not.toBeInTheDocument()
    // A quiet placeholder holds the sharing row's place, above Start, so Start doesn't move when it comes.
    const household = screen.getByRole('region', { name: 'Household' })
    const placeholder = household.querySelector('[aria-hidden="true"] [data-slot="skeleton"]')!.parentElement!
    expect(placeholder).toHaveTextContent('')
    expect(placeholder.compareDocumentPosition(screen.getByRole('button', { name: 'Start my own budget' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('while the household loads, an owner sees no Household card at all (nothing to show yet)', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return new Promise(() => {})
      return Promise.resolve({ data: meData })
    })

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Sign-in' }, W)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Household' })).not.toBeInTheDocument()
  })

  // W08: the budget and all its accounts use one currency, fixed once the budget has accounts,
  // months or transactions (the app never converts). The preference is then shown read-only.
  it('shows the currency read-only with a note once the budget currency is locked', async () => {
    // The login's saved preference and its own household's budget currency differ on older data
    // (#278 P3-5): the locked field shows the own household's, which its note names, not the
    // household being viewed (#287 review P2-4).
    meData = { ...ownerMe, preferredCurrency: 'EUR', budgetCurrency: 'CHF', currencyLocked: true, ownBudgetCurrency: 'GBP' }
    mockPut.mockResolvedValue({
      data: { firstName: 'Alex', lastName: null, displayName: 'Alex', preferredCurrency: 'GBP', numberFormat: 'comma-dot' },
    })
    const user = userEvent.setup()

    renderPage()

    // The note describes the field for a screen reader, and shows behind the (i) "About the lock".
    const note = await screen.findByText(/budget currency is fixed once your budget has accounts, months or transactions/)
    const currency = screen.getByLabelText('Currency') as HTMLInputElement
    expect(currency.tagName).toBe('INPUT')
    expect(currency).toHaveAttribute('readonly')
    expect(currency.value).toBe('British pound (£)')
    expect(currency).toHaveAttribute('aria-describedby', note.id)
    expect(await hintText(user, 'About the lock')).toMatch(
      /^Your budget currency is fixed once your budget has accounts, months or transactions\./,
    )

    await user.click(screen.getByRole('button', { name: 'Edit name' }))
    await user.type(screen.getByLabelText('First name'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))
    // The save sends the login's saved preference unchanged; the field only displays the budget's.
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/auth/preferences', expect.objectContaining({ preferredCurrency: 'EUR' })),
    )
  })

  it('unlocked, the currency is a select and its (i) says what the settings do (no lock note)', async () => {
    meData = { ...ownerMe, currencyLocked: false }
    const user = userEvent.setup()

    renderPage()

    expect((await screen.findByLabelText('Currency', {}, W)).tagName).toBe('SELECT')
    expect(screen.queryByRole('button', { name: 'About the lock' })).not.toBeInTheDocument()
    const text = await hintText(user, 'About these settings')
    expect(text).toBe(
      'Your currency is the one your budget and all its accounts use; number format controls the decimal and grouping separators.',
    )
  })

  it('shows the server’s reason when a currency change is refused', async () => {
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: 'The budget currency can’t change once the budget has accounts.' } },
    })
    const user = userEvent.setup()

    renderPage()

    await user.selectOptions(await screen.findByLabelText('Currency'), 'USD')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The budget currency can’t change once the budget has accounts.')
  })

  it('Save reads “Saving…” and is disabled while the preferences save', async () => {
    let finish: (v: unknown) => void = () => {}
    mockPut.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const user = userEvent.setup()

    renderPage()

    const save = await screen.findByRole('button', { name: 'Save preferences' }, W)
    expect(save).toHaveTextContent(/^Save$/)
    await user.click(save)
    const busy = await screen.findByRole('button', { name: 'Saving…' }, W)
    expect(busy).toBeDisabled()
    finish({ data: { firstName: null, lastName: null, displayName: 'Alex', preferredCurrency: 'EUR', numberFormat: 'comma-dot' } })
    expect(await screen.findByRole('status', {}, W)).toHaveTextContent('Your preferences have been saved.')
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeEnabled()
  })

  describe('the profile and its pencil', () => {
    it('shows you: the name, the access level as its own word, and the email', async () => {
      meData = { ...ownerMe, displayName: 'Alex Byrne', email: 'alex@x.com' }

      renderPage()

      expect(await screen.findByRole('heading', { level: 2, name: 'Alex Byrne' }, W)).toBeInTheDocument()
      // The chip's text is exactly the role (journeys look it up with exact: true).
      expect(screen.getByText('Owner', { exact: true })).toBeInTheDocument()
      expect(screen.getByText('Access level:', { exact: false })).toHaveClass('sr-only')
      expect(screen.getByText('alex@x.com')).toBeInTheDocument()
      // The name fields wait for the pencil.
      expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Last name')).not.toBeInTheDocument()
    })

    it('without a name, the heading is the email (shown once) and the avatar takes the email’s initial', async () => {
      meData = { ...ownerMe, displayName: null as unknown as string, email: 'zoe@x.com' }
      const user = userEvent.setup()

      renderPage()

      expect(await screen.findByRole('heading', { level: 2, name: 'zoe@x.com' }, W)).toBeInTheDocument()
      const section = screen.getByRole('region', { name: 'Your account' })
      expect(within(section).getAllByText('zoe@x.com')).toHaveLength(1)
      expect(within(section).queryByText('—')).not.toBeInTheDocument()
      expect(within(section).getByText('Z')).toHaveAttribute('aria-hidden')
      // The pencil still gives the name fields, empty.
      await user.click(screen.getByRole('button', { name: 'Edit name' }))
      expect(screen.getByLabelText('First name')).toHaveValue('')
      expect(screen.getByLabelText('Last name')).toHaveValue('')
    })

    it('your colour waits for the household’s people: a placeholder first, then your hue', async () => {
      meData = { ...ownerMe, memberId: 'm2' }
      let answer: (v: unknown) => void = () => {}
      mockGet.mockImplementation((url: string) => {
        if (url === '/members') return new Promise((resolve) => (answer = resolve))
        return Promise.resolve({ data: meData })
      })

      const { container } = renderPage()

      const section = await screen.findByRole('region', { name: 'Your account' }, W)
      // Not the "not linked to a person" steel while /members loads: a placeholder with no initial.
      expect(within(section).queryByText('A')).not.toBeInTheDocument()
      expect(section.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
      answer({ data: [member(), member({ id: 'm2', name: 'Sam', displayOrder: 1 })] })
      const initial = await within(section).findByText('A', {}, W)
      expect(initial.getAttribute('style')).not.toContain('steel')
      expect(container.querySelector('section[aria-label="Your account"] [data-slot="skeleton"]')).not.toBeInTheDocument()
    })

    it('the name and email are never cut off: no truncation on the heading or the email', async () => {
      meData = { ...ownerMe, displayName: 'Christopher Muscat', email: 'christopher.muscat89@example.eu' }

      renderPage()

      const heading = await screen.findByRole('heading', { level: 2, name: 'Christopher Muscat' }, W)
      expect(heading).not.toHaveClass('truncate')
      expect(screen.getByText('christopher.muscat89@example.eu')).not.toHaveClass('truncate')
    })

    it('the pencil opens First name and Last name with the focus in First name; ✕ puts them back and returns focus', async () => {
      meData = { ...ownerMe, firstName: 'Alex', lastName: 'Byrne', displayName: 'Alex Byrne' }
      const user = userEvent.setup()

      renderPage()

      const pencil = await screen.findByRole('button', { name: 'Edit name' }, W)
      await user.click(pencil)
      const first = screen.getByLabelText('First name') as HTMLInputElement
      const last = screen.getByLabelText('Last name') as HTMLInputElement
      expect(first).toHaveFocus()
      expect(first).toHaveAttribute('autocomplete', 'given-name')
      expect(last).toHaveAttribute('autocomplete', 'family-name')
      expect(first.value).toBe('Alex')
      expect(last.value).toBe('Byrne')
      expect(screen.queryByRole('heading', { level: 2, name: 'Alex Byrne' })).not.toBeInTheDocument()

      await user.clear(first)
      await user.type(first, 'Sasha')
      await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
      expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Alex Byrne' })).toBeInTheDocument()
      const back = screen.getByRole('button', { name: 'Edit name' })
      expect(back).toHaveFocus()

      // The typed name was dropped: the fields open with the saved one again.
      await user.click(back)
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Alex')
    })

    it('Escape in a name field cancels the edit', async () => {
      meData = { ...ownerMe, firstName: 'Alex', lastName: 'Byrne', displayName: 'Alex Byrne' }
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Edit name' }, W))
      await user.type(screen.getByLabelText('Last name'), 'x')
      await user.keyboard('{Escape}')
      expect(screen.queryByLabelText('Last name')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit name' })).toHaveFocus()
    })

    it('Save sends the edited names, then the heading shows the new name', async () => {
      meData = { ...ownerMe, firstName: 'Alex', lastName: 'Byrne', displayName: 'Alex Byrne' }
      mockPut.mockResolvedValue({
        data: { firstName: 'Sasha', lastName: 'Byrne', displayName: 'Sasha Byrne', preferredCurrency: 'EUR', numberFormat: 'comma-dot' },
      })
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Edit name' }, W))
      const first = screen.getByLabelText('First name')
      await user.clear(first)
      await user.type(first, 'Sasha{Enter}')

      await waitFor(() =>
        expect(mockPut).toHaveBeenCalledWith('/auth/preferences', expect.objectContaining({ firstName: 'Sasha', lastName: 'Byrne' })),
      )
      expect(await screen.findByRole('heading', { level: 2, name: 'Sasha Byrne' }, W)).toBeInTheDocument()
      expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit name' })).toHaveFocus()
    })

    it('a failed save keeps the name fields open with what was typed', async () => {
      mockPut.mockRejectedValue(new Error('down'))
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Edit name' }, W))
      await user.type(screen.getByLabelText('First name'), 'Sasha')
      await user.click(screen.getByRole('button', { name: 'Save preferences' }))
      expect(await screen.findByRole('alert', {}, W)).toHaveTextContent('Could not save your preferences.')
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Sasha')
    })
  })

  describe('the (i) hints', () => {
    it.each([
      [0, 'Owner', 'Full control, including managing who has access.'],
      [1, 'Admin', 'Everything except managing members and access.'],
      [2, 'Limited', 'Day-to-day entry: transactions, mark bills paid, run allocation.'],
      [3, 'Read-only', 'View everything; cannot make changes.'],
    ])('role %i: the chip reads %s and its (i) says what it allows', async (role, label, hint) => {
      meData = role === 0 ? ownerMe : sharedJoinedMe(role)
      const user = userEvent.setup()

      renderPage()

      expect(await screen.findByText(label, { exact: true }, W)).toBeInTheDocument()
      // Not in the page until it opens.
      expect(screen.queryByText(hint)).not.toBeInTheDocument()
      expect(await hintText(user, 'About access level')).toBe(hint)
    })

    it('an unknown role reads “Member”, with no (i)', async () => {
      meData = { ...ownerMe, role: 9 }

      renderPage()

      expect(await screen.findByText('Member', { exact: true }, W)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'About access level' })).not.toBeInTheDocument()
    })

    it('“Just you” and “Your own budget” keep today’s sentences behind their (i)', async () => {
      meData = joinedMe
      const user = userEvent.setup()

      renderPage()

      await screen.findByText('Just you', {}, W)
      expect(screen.queryByText(/budgeting on your own/)).not.toBeInTheDocument()
      expect(await hintText(user, 'About sharing')).toBe(
        'You’re budgeting on your own. If you share money with a partner or housemate, you can add them to split shared costs and divide savings between you.',
      )
      expect(await hintText(user, 'About your own budget')).toBe(
        'You’re a member of a shared household. Want a budget of your own too? We’ll create it and you can build your first month — blank or from a template — and switch between them anytime. The shared budget stays exactly as it is.',
      )
    })

    it('a password login’s Password row has no (i); a passwordless one’s says how to set one', async () => {
      const user = userEvent.setup()
      const view = renderPage()

      await screen.findByRole('heading', { name: 'Password' }, W)
      expect(screen.queryByRole('button', { name: 'About the password' })).not.toBeInTheDocument()
      view.unmount()

      meData = { ...ownerMe, hasPassword: false, hasGoogle: true } as MeResponse
      renderPage()
      expect(await hintText(user, 'About the password')).toBe(
        "You sign in with Google, so this account has no password yet. To add one, use Forgot password with this account's email — the emailed link lets you set a password. Signing in with Google keeps working either way.",
      )
    })
  })

  describe('the Change password dialog', () => {
    it('opens on its close control, closes on Escape and Cancel, and gives focus back to “Change”', async () => {
      const user = userEvent.setup()

      renderPage()

      const change = await screen.findByRole('button', { name: 'Change password' }, W)
      expect(change).toHaveTextContent(/^Change$/)
      let dialog = await openChangePassword(user)
      expect(within(dialog).getByRole('heading', { name: 'Change password' })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(change).toHaveFocus()

      dialog = await openChangePassword(user)
      await user.type(within(dialog).getByLabelText('Current password'), 'typed')
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(change).toHaveFocus()

      // A fresh dialog each time: nothing typed is kept.
      dialog = await openChangePassword(user)
      expect((within(dialog).getByLabelText('Current password') as HTMLInputElement).value).toBe('')
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('keeps today’s fields and rules', async () => {
      const user = userEvent.setup()

      renderPage()

      const dialog = await openChangePassword(user)
      const current = within(dialog).getByLabelText('Current password')
      const next = within(dialog).getByLabelText('New password')
      const confirm = within(dialog).getByLabelText('Confirm new password')
      expect(current).toHaveAttribute('type', 'password')
      expect(current).toHaveAttribute('autocomplete', 'current-password')
      expect(current).toBeRequired()
      expect(next).toHaveAttribute('autocomplete', 'new-password')
      expect(next).toHaveAttribute('minlength', '8')
      expect(next).toHaveAttribute('placeholder', 'At least 8 characters')
      expect(next).toBeRequired()
      expect(confirm).toHaveAttribute('autocomplete', 'new-password')
      expect(confirm).toHaveAttribute('minlength', '8')
      // The submit sits in the footer but submits the dialog's form.
      const submit = within(dialog).getByRole('button', { name: 'Change password' })
      expect(submit).toHaveAttribute('type', 'submit')
      expect(submit.getAttribute('form')).toBe(current.closest('form')?.id)
    })

    it('a successful change closes it, says so on the Password row, and is tracked once', async () => {
      mockPost.mockResolvedValue({
        data: { token: 'fresh-token', expiresAtUtc: '2999-01-01T00:00:00Z', userId: 'u1', email: 'alex@x.com', role: 0, displayName: 'Alex' },
      })
      const user = userEvent.setup()

      renderPage()

      const dialog = await openChangePassword(user)
      await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
      await user.type(within(dialog).getByLabelText('New password'), 'Aa1-fresh-secret')
      await user.type(within(dialog).getByLabelText('Confirm new password'), 'Aa1-fresh-secret')
      await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

      expect(await screen.findByRole('status', {}, W)).toHaveTextContent('Your password has been changed.')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Change password' })).toHaveFocus()
      expect(vi.mocked(track).mock.calls.filter(([e]) => e === EVENTS.passwordChanged)).toHaveLength(1)

      // The line stays until the next attempt, which clears it.
      const again = await openChangePassword(user)
      await user.type(within(again).getByLabelText('Current password'), 'x')
      await user.type(within(again).getByLabelText('New password'), 'aaaaaaaa')
      await user.type(within(again).getByLabelText('Confirm new password'), 'bbbbbbbb')
      await user.click(within(again).getByRole('button', { name: 'Change password' }))
      await within(again).findByRole('alert')
      expect(screen.queryByText('Your password has been changed.')).not.toBeInTheDocument()
    })

    it('reads “Saving…” while it saves, and nothing closes it until the answer', async () => {
      let fail: (e: unknown) => void = () => {}
      mockPost.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
      const user = userEvent.setup()

      renderPage()

      const dialog = await openChangePassword(user)
      await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
      await user.type(within(dialog).getByLabelText('New password'), 'Aa1-fresh-secret')
      await user.type(within(dialog).getByLabelText('Confirm new password'), 'Aa1-fresh-secret')
      await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

      // Unavailable while saving, but aria-disabled rather than disabled: it keeps its focus (a
      // disabled button would drop it to the page behind the dialog), and a second press does nothing.
      const saving = await within(dialog).findByRole('button', { name: 'Saving…' })
      expect(saving).toHaveAttribute('aria-disabled', 'true')
      expect(saving).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(mockPost.mock.calls.filter(([url]) => url === '/auth/change-password')).toHaveLength(1)
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
      await user.click(within(dialog).getByRole('button', { name: 'Close' }))
      within(dialog).getByRole('button', { name: 'Close' }).focus()
      await user.keyboard('{Escape}')
      expect(screen.getByRole('dialog', { name: 'Change password' })).toBeInTheDocument()

      within(dialog).getByRole('button', { name: 'Saving…' }).focus()
      fail({ isAxiosError: true, response: { status: 400, data: { errors: ['Incorrect password.'] } } })
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Incorrect password.')
      const submit = within(dialog).getByRole('button', { name: 'Change password' })
      expect(submit).toBeEnabled()
      expect(submit).not.toHaveAttribute('aria-disabled')
      // The refused change leaves the focus in the dialog, so Escape still closes it.
      expect(submit).toHaveFocus()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(track).not.toHaveBeenCalledWith(EVENTS.passwordChanged)
    })

    it('ties a check’s message to its field: Confirm for a mismatch, New password for the length', async () => {
      const user = userEvent.setup()

      renderPage()

      const dialog = await openChangePassword(user)
      const next = within(dialog).getByLabelText('New password')
      const confirm = within(dialog).getByLabelText('Confirm new password')
      expect(next).not.toHaveAttribute('aria-invalid')
      expect(confirm).not.toHaveAttribute('aria-invalid')

      await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
      await user.type(next, 'Aa1-fresh-secret')
      await user.type(confirm, 'Aa1-other-secret')
      await user.click(within(dialog).getByRole('button', { name: 'Change password' }))
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent('The new passwords do not match.')
      expect(confirm).toHaveAttribute('aria-invalid', 'true')
      expect(confirm).toHaveAccessibleDescription('The new passwords do not match.')
      expect(next).not.toHaveAttribute('aria-invalid')

      // Too short (the field's own minLength is bypassed with novalidate, as a server-side check would be).
      await user.clear(next)
      await user.clear(confirm)
      await user.type(next, 'Aa1-x')
      await user.type(confirm, 'Aa1-x')
      next.closest('form')!.noValidate = true
      await user.click(within(dialog).getByRole('button', { name: 'Change password' }))
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a new password of at least 8 characters.'))
      expect(next).toHaveAttribute('aria-invalid', 'true')
      expect(next).toHaveAccessibleDescription('Use a new password of at least 8 characters.')
      expect(confirm).not.toHaveAttribute('aria-invalid')
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('a non-HTTP failure gives the fallback message', async () => {
      mockPost.mockRejectedValue(new Error('offline'))
      const user = userEvent.setup()

      renderPage()

      const dialog = await openChangePassword(user)
      await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
      await user.type(within(dialog).getByLabelText('New password'), 'Aa1-fresh-secret')
      await user.type(within(dialog).getByLabelText('Confirm new password'), 'Aa1-fresh-secret')
      await user.click(within(dialog).getByRole('button', { name: 'Change password' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not change your password.')
    })
  })

  describe('Google', () => {
    it('a linked login sees a Connected chip; Disconnect is behind its ⋯', async () => {
      meData = { ...ownerMe, hasGoogle: true, hasPassword: true } as MeResponse
      const user = userEvent.setup()

      renderPage()

      expect(await screen.findByRole('heading', { name: 'Google' }, W)).toBeInTheDocument()
      expect(screen.getByText('Connected')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Google: more actions' }))
      const menu = await screen.findByRole('menu', {}, W)
      expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Disconnect'])
      expect(within(menu).getByRole('menuitem', { name: 'Disconnect' })).not.toHaveAttribute('aria-disabled')
    })

    it('while disconnecting the chip says so; a refusal shows at the foot of the Sign-in card', async () => {
      meData = { ...ownerMe, hasGoogle: true, hasPassword: true } as MeResponse
      let fail: (e: unknown) => void = () => {}
      mockPost.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Google: more actions' }, W))
      await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }, W))
      expect(await screen.findByText('Disconnecting…', {}, W)).toBeInTheDocument()
      expect(screen.queryByText('Connected')).not.toBeInTheDocument()
      // Not twice at once.
      await user.click(screen.getByRole('button', { name: 'Google: more actions' }))
      expect(await screen.findByRole('menuitem', { name: 'Disconnect' }, W)).toHaveAttribute('aria-disabled', 'true')
      await user.keyboard('{Escape}')

      fail({ isAxiosError: true, response: { status: 400, data: {} } })
      const alert = await screen.findByRole('alert', {}, W)
      expect(alert).toHaveTextContent('Could not disconnect Google. Please try again.')
      const signIn = screen.getByRole('region', { name: 'Sign-in' })
      expect(signIn).toContainElement(alert)
      expect(screen.getByText('Connected')).toBeInTheDocument()
    })

    it('once disconnected, the Google row goes and the line saying so takes the focus', async () => {
      meData = { ...ownerMe, hasGoogle: true, hasPassword: true } as MeResponse
      mockPost.mockResolvedValue({
        data: { token: 't2', expiresAtUtc: '2999-01-01T00:00:00Z', userId: 'u1', email: 'alex@x.com', role: 0, displayName: 'Alex' },
      })
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Google: more actions' }, W))
      // From now on the server says Google is no longer linked.
      meData = { ...ownerMe, hasGoogle: false, hasPassword: true } as MeResponse
      await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }, W))
      const done = await screen.findByText('Google has been disconnected.', {}, W)
      expect(done).toHaveAttribute('role', 'status')
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Google' })).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Google: more actions' })).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Sign-in' })).toContainElement(done)
      // The ⋯ that held the focus is gone: the line takes it, so the keyboard isn't left on the page.
      await waitFor(() => expect(done).toHaveFocus())
    })

    it('on a phone the ⋯ opens a sheet titled Google, with the disabled Disconnect and why', async () => {
      asPhone()
      meData = { ...ownerMe, hasGoogle: true, hasPassword: false } as MeResponse
      const user = userEvent.setup()

      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Google: more actions' }, W))
      const sheet = await screen.findByRole('dialog', { name: 'Google' }, W)
      const disconnect = within(sheet).getByRole('button', { name: 'Disconnect' })
      expect(disconnect).toHaveAttribute('aria-disabled', 'true')
      expect(disconnect).toHaveAccessibleDescription(
        "Google is your only way to sign in, so it can't be disconnected yet. Set a password first.",
      )
      await user.click(disconnect)
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  it('on a phone the Household ⋯ opens a sheet named for the household; Leave household opens the dialog', async () => {
    asPhone()
    meData = joinedMe
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Household: more actions' }, W))
    const sheet = await screen.findByRole('dialog', { name: 'Alex’s household' }, W)
    await user.click(within(sheet).getByRole('button', { name: 'Leave household' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave Alex’s household?' }, W)
    // On a phone the grab handle is the close control.
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(within(dialog).getByRole('button', { name: 'Yes, leave' })).toBeInTheDocument()
  })
})
