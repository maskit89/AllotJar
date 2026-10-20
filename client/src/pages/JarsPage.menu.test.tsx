import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JarAccountLedgerDto, JarDto } from '../types'

// The restyled Jars page (restyle PR 4): each card's actions sit behind a ⋯ (a menu on wider
// screens, a bottom sheet titled with the jar's name on a phone) whose note says what the card
// leaves out; the cards come attention first; the page's own Move money and the New jar tile.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockDelete, mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { jarAction, jarNote, menuItems } from '../test/rowMenu'
import { JarsPage } from './JarsPage'
import { account, jar, ledger } from '../test/fixtures/jars'
import { me } from '../test/fixtures/me'
import { setMoneyFormat } from '../lib/money'

let jarsData: JarDto[] = []
let ledgerData: JarAccountLedgerDto[] = []

function mockLoads(opts: { jars?: JarDto[]; ledgers?: JarAccountLedgerDto[]; meRole?: number } = {}) {
  jarsData = opts.jars ?? []
  ledgerData = opts.ledgers ?? [ledger()]
  mockGet.mockImplementation((url: string) => {
    if (url === '/accounts') return Promise.resolve({ data: [account(), account({ id: 'acc2', name: 'Rainy Day', type: 1, displayOrder: 1 })] })
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: ledgerData })
    if (url === '/jars') return Promise.resolve({ data: jarsData })
    if (url === '/auth/me') return Promise.resolve({ data: opts.meRole === undefined ? {} : me({ role: opts.meRole }) })
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

const renderPage = () => renderWithProviders(<JarsPage />)

// A yearly bill, a goal, a goal that never held money and a completed goal.
const bill = () => jar({ plannedThisMonth: 25, contributedThisMonth: 10, remainingThisMonth: 15 })
const goal = (over: Partial<JarDto> = {}) =>
  jar({ id: 'g1', name: 'Holiday', kind: 1, recurMonths: null, targetAmount: 1000, currentBalance: 400, targetDate: '2027-06-01', deadline: '2027-06-01', ...over })

describe('JarsPage — the jar ⋯ menu, its phone sheet and the page actions', () => {
  beforeEach(() => {
    setMoneyFormat('en-GB')
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setMoneyFormat('en-GB')
  })

  it('each jar\'s ⋯ offers what that jar can do, the rare endings after a divider', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [
        bill(),
        goal(),
        goal({ id: 'g2', name: 'Someday', targetAmount: 0, currentBalance: 0, targetDate: null, deadline: null, status: 'Unscheduled', canDelete: true }),
        goal({ id: 'g3', name: 'New laptop', completedOn: '2026-09-15', status: 'Completed' }),
      ],
    })
    const user = userEvent.setup()
    renderPage()

    const names = async (jarName: string) => {
      const items = (await menuItems(user, `${jarName}: more actions`)).map((i) => i.name)
      await user.keyboard('{Escape}')
      return items
    }
    expect(await names('Home insurance')).toEqual(['Mark paid', 'Move money', 'Edit', 'Archive'])
    expect(await names('Holiday')).toEqual(['Mark completed', 'Move money', 'Edit', 'Archive'])
    expect(await names('Someday')).toEqual(['Mark completed', 'Move money', 'Edit', 'Archive', 'Delete'])
    expect(await names('New laptop')).toEqual(['Reopen', 'Move money', 'Edit', 'Archive'])

    // Archive sits after a divider, Delete is in the warning colour.
    await user.click(screen.getByRole('button', { name: 'Someday: more actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).className).toMatch(/text-bad/)
  })

  it('the ⋯\'s note says where the money is held and this month\'s plan, as the menu\'s description', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill()] })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Home insurance: more actions' }, { timeout: 5000 }))
    const menu = await screen.findByRole('menu')
    // One fact a line, each line apart in what a screen reader reads.
    expect(menu).toHaveAccessibleDescription('Held in Joint Current Plan €25.00 · in €10.00 · to go €15.00')
    // The card itself says neither: each fact has one home.
    const card = within(screen.getByRole('article', { name: 'Home insurance' }))
    expect(card.queryByText(/Held in/)).not.toBeInTheDocument()
    expect(card.queryByText(/^Plan /)).not.toBeInTheDocument()
  })

  it('works from the keyboard: Enter opens the ⋯, arrows move, Escape closes and gives focus back to the ⋯', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill()] })
    const user = userEvent.setup()
    renderPage()

    const trigger = await screen.findByRole('button', { name: 'Home insurance: more actions' }, { timeout: 5000 })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Mark paid' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Move money' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()

    // Enter on an item opens its dialog; closing it gives focus back to the ⋯.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Jar name')).toHaveValue('Home insurance')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('gives focus back to the ⋯ when a dialog opened from it closes', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill(), goal()] })
    const user = userEvent.setup()
    renderPage()

    await jarAction(user, 'Holiday', 'Move money')
    let dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(await dialog.findByRole('button', { name: 'Cancel move' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Holiday: more actions' })).toHaveFocus(), { timeout: 5000 })

    await jarAction(user, 'Home insurance', 'Mark paid')
    dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByLabelText('Cancel marking paid'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Home insurance: more actions' })).toHaveFocus(), { timeout: 5000 })
  })

  it('Archive in the ⋯ opens the edit form with "Really archive?" asked and focused; confirming archives', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill(), goal()] })
    mockPut.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    await jarAction(user, 'Holiday', 'Archive')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    const confirm = dialog.getByRole('button', { name: 'Really archive?' })
    await waitFor(() => expect(confirm).toHaveFocus())
    expect(mockPut).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/jars/g1/archive', { archived: true }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Holiday' })).not.toBeInTheDocument())
  })

  it('once a jar is archived or deleted from its ⋯, focus moves to the next card\'s ⋯ (or the one before), else to New jar', { timeout: 20000 }, async () => {
    mockLoads({ jars: [bill(), goal(), goal({ id: 'g2', name: 'Sofa', canDelete: true })] })
    mockPut.mockResolvedValue({ data: null })
    mockDelete.mockResolvedValue({ data: null })
    const user = userEvent.setup()
    renderPage()

    // The middle card: the card that takes its place gets the focus, not the page.
    await jarAction(user, 'Holiday', 'Archive')
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByRole('button', { name: 'Really archive?' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Holiday' })).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sofa: more actions' })).toHaveFocus())

    // The last card (deleted): the one before it.
    await jarAction(user, 'Sofa', 'Delete')
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByRole('button', { name: 'Really delete?' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/jars/g2'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Home insurance: more actions' })).toHaveFocus(), { timeout: 5000 })

    // The only card: the empty page's New jar.
    await jarAction(user, 'Home insurance', 'Archive')
    await user.click(within(await screen.findByRole('dialog', {}, { timeout: 5000 })).getByRole('button', { name: 'Really archive?' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New jar' })).toHaveFocus(), { timeout: 5000 })
    expect(screen.getByText('No jars yet')).toBeInTheDocument()
  })

  it('Delete in the ⋯ opens the edit form with "Really delete?" asked and focused; Escape asks nothing and gives focus back', { timeout: 15000 }, async () => {
    mockLoads({ jars: [goal({ canDelete: true })] })
    const user = userEvent.setup()
    renderPage()

    await jarAction(user, 'Holiday', 'Delete')
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Really delete?' })).toHaveFocus())
    // The other ending is still on offer, unarmed.
    expect(dialog.getByRole('button', { name: 'Archive jar' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Holiday: more actions' })).toHaveFocus())

    // Edit opens the same form with neither ending asked.
    await jarAction(user, 'Holiday', 'Edit')
    const edit = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(edit.getByRole('button', { name: 'Delete jar' })).toBeInTheDocument()
    expect(edit.queryByRole('button', { name: 'Really delete?' })).not.toBeInTheDocument()
    expect(edit.queryByRole('button', { name: 'Really archive?' })).not.toBeInTheDocument()
  })

  it('on a phone, the ⋯ opens a sheet titled with the jar\'s name, its note under the title; a pick gives focus back to the ⋯', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads({ jars: [bill(), goal()] })
    const user = userEvent.setup()
    renderPage()

    const trigger = await screen.findByRole('button', { name: 'Home insurance: more actions' }, { timeout: 5000 })
    await user.click(trigger)
    const sheet = await screen.findByRole('dialog', { name: 'Home insurance' }, { timeout: 5000 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(sheet).toHaveAccessibleDescription(/^Held in Joint Current.*Plan €25\.00 · in €10\.00 · to go €15\.00$/)
    const buttons = within(sheet)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter(Boolean)
    expect(buttons).toEqual(['Mark paid', 'Move money', 'Edit', 'Archive'])

    // Escape closes the sheet and gives focus back to the ⋯.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger).toHaveFocus())

    // Edit from the sheet opens the edit form; closing it gives focus back to the ⋯ too.
    await user.click(trigger)
    await user.click(within(await screen.findByRole('dialog', { name: 'Home insurance' })).getByRole('button', { name: 'Edit' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit jar' }, { timeout: 5000 }))
    expect(dialog.getByLabelText('Jar name')).toHaveValue('Home insurance')
    await user.click(dialog.getByRole('button', { name: 'Cancel edit' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('on a phone, a card names the month a jar is due (as the mock-up) and its sheet the exact day', { timeout: 15000 }, async () => {
    asPhone()
    mockLoads({ jars: [jar({ targetDate: '2026-12-15', deadline: '2026-12-15' }), goal({ targetDate: '2027-06-15', deadline: '2027-06-15' })] })
    const user = userEvent.setup()
    renderPage()

    const bill = within(await screen.findByRole('article', { name: 'Home insurance' }, { timeout: 5000 }))
    expect(bill.getByText('Due Dec 2026 · yearly')).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Holiday' })).getByText('Needed by Jun 2027')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Home insurance: more actions' }))
    const sheet = await screen.findByRole('dialog', { name: 'Home insurance' }, { timeout: 5000 })
    expect(sheet).toHaveAccessibleDescription(/Due (Dec 15, 2026|15 Dec 2026)/)
    expect(sheet).not.toHaveAccessibleDescription(/yearly/)
  })

  it('on a wider screen, a card keeps the exact day and its ⋯\'s note does not repeat it', { timeout: 15000 }, async () => {
    asDesktop()
    mockLoads({ jars: [jar({ targetDate: '2026-12-15', deadline: '2026-12-15' })] })
    const user = userEvent.setup()
    renderPage()

    const card = within(await screen.findByRole('article', { name: 'Home insurance' }, { timeout: 5000 }))
    expect(card.getByText(/^Due (Dec 15, 2026|15 Dec 2026) · yearly$/)).toBeInTheDocument()
    expect((await jarNote(user, 'Home insurance')).join(' ')).not.toMatch(/Due|yearly/)
  })

  it('lists the jars that need attention first, whatever order the API gives', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [
        goal({ id: 'a', name: 'Done', completedOn: '2026-09-15', status: 'Completed' }),
        goal({ id: 'b', name: 'Fine', status: 'OnTrack' }),
        goal({ id: 'c', name: 'Slow', status: 'Behind' }),
        goal({ id: 'd', name: 'Over', currentBalance: -40, status: 'Overspent' }),
        jar({ id: 'e', name: 'Missed', deadline: '2026-09-01', shortfall: 150, status: 'DeadlineMissed' }),
        goal({ id: 'f', name: 'Full', currentBalance: 1000, status: 'FullyFunded' }),
      ],
    })
    renderPage()

    await screen.findByRole('article', { name: 'Done' }, { timeout: 5000 })
    const grid = screen.getByRole('region', { name: 'Your jars' })
    expect(within(grid).getAllByRole('article').map((a) => within(a).getByRole('heading').textContent)).toEqual([
      'Missed',
      'Over',
      'Slow',
      'Fine',
      'Full',
      'Done',
    ])
    // A chip only where there is something to say: none on a jar that is on track.
    expect(within(screen.getByRole('article', { name: 'Fine' })).queryByText(/On track/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Over' })).getByText('Overspent')).toBeInTheDocument()
  })

  it('ends the grid with a New jar tile that opens the new jar form', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill()] })
    const user = userEvent.setup()
    renderPage()

    const grid = within(await screen.findByRole('region', { name: 'Your jars' }, { timeout: 5000 }))
    const tile = grid.getByRole('button', { name: 'New jar' })
    // The last thing in the grid, after the cards.
    const items = [...tile.parentElement!.children]
    expect(items[items.length - 1]).toBe(tile)
    await user.click(tile)
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    expect(dialog.getByLabelText('Jar name')).toHaveValue('')
    expect(dialog.getByRole('button', { name: 'Add jar' })).toBeInTheDocument()
  })

  it('the page\'s Move money moves unallocated money into the first jar that needs it', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [bill(), goal({ status: 'Behind' })],
      ledgers: [ledger({ jars: [{ jarId: 'f1', name: 'Home insurance', balance: 120, isArchived: false }, { jarId: 'g1', name: 'Holiday', balance: 400, isArchived: false }] })],
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Move money' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Move money' }, { timeout: 5000 }))
    expect(await dialog.findByLabelText('Move from', {}, { timeout: 5000 })).toHaveValue('unallocated:acc1')
    expect(dialog.getByLabelText('Move to')).toHaveValue('g1')
    await user.click(dialog.getByRole('button', { name: 'Cancel move' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move money' })).toHaveFocus())
  })

  it('on a desktop the page\'s Move money sits in the top bar', { timeout: 15000 }, async () => {
    asDesktop()
    mockLoads({ jars: [bill()] })
    renderPage()

    const header = (await screen.findByRole('heading', { level: 1, name: 'Jars' }, { timeout: 5000 })).closest('header')!
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Move money' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Move money' })).toHaveLength(1)
  })

  it('offers no page Move money when the jars sit in more than one account, or to a viewer', { timeout: 15000 }, async () => {
    mockLoads({
      jars: [bill(), goal({ fundingAccountId: 'acc2' })],
      ledgers: [ledger(), ledger({ accountId: 'acc2', accountName: 'Rainy Day', jars: [{ jarId: 'g1', name: 'Holiday', balance: 400, isArchived: false }] })],
    })
    const { unmount } = renderPage()

    expect(await screen.findByRole('article', { name: 'Holiday' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move money' })).not.toBeInTheDocument()
    unmount()

    mockLoads({ jars: [bill()], meRole: 3 })
    renderPage()
    expect(await screen.findByRole('article', { name: 'Home insurance' }, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Home insurance: more actions' })).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Move money' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New jar' })).not.toBeInTheDocument()
  })

  it('a read-only login reads the ⋯\'s note behind an (i)', { timeout: 15000 }, async () => {
    mockLoads({ jars: [bill()], meRole: 3 })
    const user = userEvent.setup()
    renderPage()

    const about = await screen.findByRole('button', { name: 'About Home insurance' }, { timeout: 5000 })
    await user.hover(about)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe('Held in Joint Current Plan €25.00 · in €10.00 · to go €15.00')
    expect(screen.queryByRole('button', { name: 'Home insurance: more actions' })).not.toBeInTheDocument()
  })
})
