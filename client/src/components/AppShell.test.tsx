import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { FeatureFlags, HouseholdMemberDto, HouseholdSummary } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AppShell } from './AppShell'
import { splitForPhone, type FrameKey, type NavItem, type NavKey } from './navItems'

const flags = (over: Partial<FeatureFlags> = {}): FeatureFlags => ({
  accounts: true, multiCurrency: true, camtImport: true, reports: true, jars: true, householdAllocation: true, analytics: false, householdAccess: true, ...over,
})
const member = (id: string, name: string): HouseholdMemberDto => ({
  id, name, netMonthlyIncome: 1000, personalSavingsAccountId: null, displayOrder: 0, isArchived: false, incomeSharePct: 0.5,
})
const own: HouseholdSummary = { ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }

let flagsValue = flags()
let membersData: HouseholdMemberDto[] = []
let me: Record<string, unknown> = {}

function meFor(over: Record<string, unknown> = {}) {
  return {
    userId: 'u1', email: 'alex@example.eu', displayName: 'Alex Byrne', role: 0, ownerId: 'u1', memberId: null,
    needsConsent: false, preferredCurrency: 'EUR', budgetCurrency: 'EUR', currencyLocked: true, households: [own], ...over,
  }
}

function renderShell(props: { active?: FrameKey; title?: string; month?: boolean; actions?: ReactNode } = {}) {
  return renderWithProviders(
    <AppShell active={props.active ?? 'budget'} title={props.title ?? 'Dashboard'} month={props.month} actions={props.actions}>
      <p>Page body</p>
    </AppShell>,
    { features: true, household: true, month: true },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  resetApiMocks()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  flagsValue = flags()
  membersData = []
  me = meFor()
  mockGet.mockImplementation((url: string) => {
    if (url === '/auth/me') return Promise.resolve({ data: me })
    if (url === '/features') return Promise.resolve({ data: flagsValue })
    if (url === '/members') return Promise.resolve({ data: membersData })
    return Promise.resolve({ data: {} })
  })
  mockPost.mockResolvedValue({ data: {} })
})

describe('AppShell (the app frame)', () => {
  it('shows the page title as the one h1, and the month switcher only on month-scoped pages', { timeout: 15000 }, async () => {
    const { unmount } = renderShell({ active: 'jars', title: 'Jars' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Jars' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Month' })).not.toBeInTheDocument()
    expect(screen.queryByText('Zero-based')).not.toBeInTheDocument()
    unmount()

    const user = userEvent.setup()
    renderShell({ month: true })
    const month = await screen.findByRole('group', { name: 'Month' })
    const label = within(month).getByRole('heading', { level: 2 })
    const before = label.textContent
    expect(before).toMatch(/^[A-Z][a-z]+ \d{4}$/)
    await user.click(within(month).getByRole('button', { name: 'Next month' }))
    expect(label.textContent).not.toBe(before)
    await user.click(within(month).getByRole('button', { name: 'Previous month' }))
    expect(label.textContent).toBe(before)
  })

  it('lists the pages in the sidebar with icons, the current one marked, Help and Import included', { timeout: 15000 }, async () => {
    membersData = [member('m1', 'Alex'), member('m2', 'Sam')]
    renderShell({ active: 'people', title: 'People' })

    // jsdom applies no CSS, so the sidebar nav and the phone tab bar are both in the tree.
    const navs = await screen.findAllByRole('navigation', { name: 'Primary' })
    const sidebar = navs.find((n) => !n.hasAttribute('data-tabbar'))!
    await within(sidebar).findByRole('link', { name: 'Allocation' })
    const names = within(sidebar).getAllByRole('link').map((a) => a.textContent)
    expect(names).toEqual(['Dashboard', 'Transactions', 'Jars', 'Accounts', 'Reports', 'People', 'Allocation', 'Import'])
    expect(within(sidebar).getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
    // The tour's anchors are still there.
    expect(document.querySelector('[data-tour="sidebar"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="topbar"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="help"]')).toHaveAttribute('href', '/help')
    for (const k of ['transactions', 'accounts', 'jars', 'reports', 'people'])
      expect(document.querySelector(`[data-tour="nav-${k}"]`)).not.toBeNull()
    // On phones the tour points at the tabs, and at More for the pages in the sheet.
    const tabbar = navs.find((n) => n.hasAttribute('data-tabbar'))!
    for (const k of ['transactions', 'jars', 'reports'])
      expect(tabbar.querySelector(`[data-tour="nav-${k}"]`)).not.toBeNull()
    expect(tabbar.querySelector('[data-tour="nav-more"]')).toHaveAttribute('data-tour-more', 'accounts people allocation import help')
  })

  it('hides Import from a login that may not change the budget', { timeout: 15000 }, async () => {
    me = meFor({ role: 3, households: [{ ...own, role: 3 }] }) // read-only
    renderShell()
    const navs = await screen.findAllByRole('navigation', { name: 'Primary' })
    await screen.findByText(/Read-only access/)
    for (const n of navs) expect(within(n).queryByRole('link', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('the Dark mode button toggles the theme, persists it and keeps the account menu switch in step', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderShell()
    const button = await screen.findByRole('button', { name: 'Dark mode' })
    expect(button).toHaveAttribute('aria-pressed', 'false')

    await user.click(button)
    expect(document.documentElement).toHaveClass('dark')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('zbb.theme')).toBe('dark')

    // The sidebar's account button opens the menu: Account settings, the Dark mode switch, Sign out.
    await user.click(await screen.findByRole('button', { name: /^Account menu: Alex Byrne/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Account settings' })).toHaveAttribute('href', '/account')
    const sw = within(menu).getByRole('menuitemcheckbox', { name: 'Dark mode' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
    expect(within(menu).queryByText('Household')).not.toBeInTheDocument()

    // Choosing the switch flips the theme back and keeps the menu open.
    await user.click(sw)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('zbb.theme')).toBe('light')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'false')

    // Escape closes it and focus goes back to the account button.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Account menu: Alex Byrne/ })).toHaveFocus()
  })

  it('the account menu switches household when the login has several', { timeout: 15000 }, async () => {
    me = meFor({ households: [own, { ownerId: 'u9', label: 'Olive Tester', role: 2, isActive: false, isOwn: false }] })
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: /^Account menu: Alex Byrne/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Household')).toBeInTheDocument()
    // The choices form a group named by the label, so each is heard as a household.
    const group = within(menu).getByRole('group', { name: 'Household' })
    expect(within(group).getByRole('menuitemradio', { name: 'Your household' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Olive Tester' }))
    // (switchHousehold then reloads the app with location.assign, which jsdom leaves alone.)
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/households/switch', { ownerId: 'u9' }))
  })

  it('the phone tab bar opens the More sheet with the other pages, the account, Dark mode and Sign out', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderShell({ active: 'accounts', title: 'Accounts' })
    await screen.findByRole('button', { name: /^Account menu: Alex Byrne/ }) // the identity has loaded
    const navs = await screen.findAllByRole('navigation', { name: 'Primary' })
    const tabbar = navs.find((n) => n.hasAttribute('data-tabbar'))!
    expect(within(tabbar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'Transactions', 'Jars', 'Reports'])
    const more = within(tabbar).getByRole('button', { name: 'More' })

    await user.click(more)
    const sheet = await screen.findByRole('dialog', { name: 'More' })
    const pages = within(sheet).getByRole('navigation', { name: 'More pages' })
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Accounts', 'People', 'Import', 'Help'])
    expect(within(pages).getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page')
    expect(within(sheet).getByRole('link', { name: /Account settings: Alex Byrne/ })).toHaveAttribute('href', '/account')
    const sw = within(sheet).getByRole('switch', { name: 'Dark mode' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement).toHaveClass('dark')
    expect(within(sheet).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(more).toHaveFocus()
  })

  it('marks the account button (and More on phones) as the current place on the Account page', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderShell({ active: 'account', title: 'Account' })
    const button = await screen.findByRole('button', { name: /^Account menu: Alex Byrne/ })
    expect(button).toHaveAttribute('aria-current', 'page')
    const navs = await screen.findAllByRole('navigation', { name: 'Primary' })
    for (const n of navs) for (const a of within(n).getAllByRole('link')) expect(a).not.toHaveAttribute('aria-current')

    const tabbar = navs.find((n) => n.hasAttribute('data-tabbar'))!
    await user.click(within(tabbar).getByRole('button', { name: 'More' }))
    const sheet = await screen.findByRole('dialog', { name: 'More' })
    expect(within(sheet).getByRole('link', { name: /Account settings: Alex Byrne/ })).toHaveAttribute('aria-current', 'page')
  })

  it('renders the page actions once: in the content on phones, in the top bar from 900px', { timeout: 15000 }, async () => {
    const action = <button type="button">Add transaction</button>
    // jsdom has no matchMedia: the phone layout.
    const { unmount } = renderShell({ actions: action })
    const phone = await screen.findAllByRole('button', { name: 'Add transaction' })
    expect(phone).toHaveLength(1)
    expect(phone[0].closest('header')).toBeNull()
    unmount()

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 900px)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    renderShell({ actions: action })
    const desktop = await screen.findAllByRole('button', { name: 'Add transaction' })
    expect(desktop).toHaveLength(1)
    expect(desktop[0].closest('header')).toHaveAttribute('data-tour', 'topbar')
  })

  it('a detail page’s back link: a chevron named "Back to {page}" before the title, in place of the logo', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route
          path="/accounts/a1"
          element={
            <AppShell active="accounts" title="Savings" back={{ to: '/accounts', label: 'Accounts' }}>
              <p>Page body</p>
            </AppShell>
          }
        />
        <Route path="/accounts" element={<p>The accounts list</p>} />
      </Routes>,
      { route: '/accounts/a1', features: true, household: true, month: true },
    )
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Savings' })
    const header = h1.closest('header')!
    const back = within(header).getByRole('link', { name: 'Back to Accounts' })
    expect(back).toHaveAttribute('href', '/accounts')
    expect(screen.getAllByRole('link', { name: 'Back to Accounts' })).toHaveLength(1)
    // Before the title, and the phone's logo gives it its place.
    expect(back.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(header.querySelector('svg[viewBox="0 0 64 84"]')).toBeNull()
    // The sidebar's own Accounts link keeps its name, so the two never match one query.
    const navs = await screen.findAllByRole('navigation', { name: 'Primary' })
    const sidebar = navs.find((n) => !n.hasAttribute('data-tabbar'))!
    expect(await within(sidebar).findByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page')

    // A keyboard user reaches it and Enter follows it.
    back.focus()
    expect(back).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('The accounts list')).toBeInTheDocument()
  })

  it('without a back link the top bar keeps its logo and has no Back link', { timeout: 15000 }, async () => {
    renderShell({ active: 'accounts', title: 'Accounts' })
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Accounts' })
    const header = h1.closest('header')!
    expect(within(header).queryByRole('link', { name: /^Back to/ })).not.toBeInTheDocument()
    expect(header.querySelector('svg[viewBox="0 0 64 84"]')).not.toBeNull()
  })

  it('keeps the banners: read-only access and the household greeting, one line each', { timeout: 15000 }, async () => {
    window.history.replaceState(null, '', '/?joined=1')
    me = meFor({ role: 3 })
    const user = userEvent.setup()
    renderShell()
    const greeting = await screen.findByText('You’ve joined the household.')
    expect(greeting.closest('[data-tone]')).toHaveAttribute('data-tone', 'ok')
    expect(greeting.closest('[role="status"]')).not.toBeNull()
    // The param is stripped at once, so a refresh would not repeat it.
    expect(window.location.search).toBe('')
    const access = await screen.findByText('Read-only access: you can view everything, not change it.')
    expect(access.closest('[data-tone]')).toHaveAttribute('data-tone', 'info')
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content')
    // The full explanation sits behind the (i).
    await user.hover(screen.getByRole('button', { name: 'About your access' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/nothing here can be added, changed or deleted by you/)
    // The greeting dismisses; the access line stays.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('You’ve joined the household.')).not.toBeInTheDocument()
    expect(screen.getByText('Read-only access: you can view everything, not change it.')).toBeInTheDocument()
  })

  it('the other greetings and the limited-access line, each one sentence', { timeout: 15000 }, async () => {
    window.history.replaceState(null, '', '/?started=1')
    me = meFor({ role: 2, households: [{ ...own, role: 2 }] }) // Limited
    const { unmount } = renderShell()
    expect(await screen.findByText('Your own budget is ready.')).toBeInTheDocument()
    const limited = await screen.findByText('Limited access: you can record transactions, mark bills paid and run allocation.')
    expect(limited.closest('[data-tone]')).toHaveAttribute('data-tone', 'warn')
    expect(screen.getByRole('button', { name: 'About your access' })).toBeInTheDocument()
    unmount()

    window.history.replaceState(null, '', '/?left=1')
    me = meFor()
    renderShell()
    expect(await screen.findByText('You’re back on your own budget.')).toBeInTheDocument()
    await screen.findByRole('button', { name: /^Account menu: Alex Byrne/ })
    expect(screen.queryByRole('button', { name: 'About your access' })).not.toBeInTheDocument()
  })
})

describe('splitForPhone', () => {
  const item = (key: NavKey): NavItem => ({ key, to: `/${key}`, label: key, icon: () => null, group: 'main' })

  it('gives the four tabs to Dashboard, Transactions, Jars and Reports, the rest to More', () => {
    const { tabs, more } = splitForPhone(['budget', 'transactions', 'jars', 'accounts', 'reports', 'people', 'import', 'help'].map((k) => item(k as NavKey)))
    expect(tabs.map((t) => t.key)).toEqual(['budget', 'transactions', 'jars', 'reports'])
    expect(more.map((t) => t.key)).toEqual(['accounts', 'people', 'import', 'help'])
  })

  it('hands a switched-off page’s tab to the next page in line', () => {
    const { tabs, more } = splitForPhone(['budget', 'transactions', 'accounts', 'people', 'help'].map((k) => item(k as NavKey)))
    expect(tabs.map((t) => t.key)).toEqual(['budget', 'transactions', 'accounts', 'people'])
    expect(more.map((t) => t.key)).toEqual(['help'])
  })
})
