import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

// The page's wire out: the welcome tour's replay.
const { replay } = vi.hoisted(() => ({ replay: vi.fn() }))
vi.mock('../onboarding/OnboardingContext', async (importOriginal) => {
  const real = await importOriginal<typeof import('../onboarding/OnboardingContext')>()
  return { ...real, useOnboarding: () => ({ ...real.useOnboarding(), replay }) }
})

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { HelpPage } from './HelpPage'

const renderPage = () => renderWithProviders(<HelpPage />)

/**
 * A topic's panel: the element its row's button controls, kept in the DOM and `hidden` while
 * closed. Not a landmark: eleven topics open independently, and eleven regions would crowd a
 * screen reader's list.
 */
const panelOf = (row: HTMLElement) => document.getElementById(row.getAttribute('aria-controls')!)!

const TOPICS = [
  'Months & appearance',
  'Accounts',
  'Saving with jars',
  'Transactions',
  'Importing a statement',
  'Bills & due dates',
  'Reports',
  'People & allocation',
  'Your account',
  'Install the app',
  'Good to know',
]

describe('HelpPage', () => {
  beforeEach(() => {
    replay.mockClear()
  })

  it('shows the hero, the topics and the way to more help', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Help & guide' })).toBeInTheDocument()
    // The one idea leads the page as the named hero region (no heading: the top bar's is the only h1).
    const hero = screen.getByRole('region', { name: 'Zero-based budgeting' })
    expect(hero).toHaveTextContent('Give every euro a job')
    expect(within(hero).getByRole('button', { name: 'About zero-based budgeting' })).toBeInTheDocument()

    // Every topic is a heading holding its row's button, the pages in the menu's order, all closed.
    expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { expanded: false }).filter((b) => b.hasAttribute('aria-controls'))
    expect(rows.map((b) => b.textContent)).toEqual(TOPICS)
    for (const row of rows) expect(panelOf(row)).not.toBeVisible()
    // The page's landmarks are the hero and the cards; a topic's panel is never one.
    expect(screen.getByRole('region', { name: 'Topics' })).toBeInTheDocument()
    expect(screen.getAllByRole('region')).toHaveLength(2)

    // The user guide link is gone: its GitHub page no longer opens for anyone else.
    expect(screen.queryByRole('link', { name: /user guide/i })).not.toBeInTheDocument()

    // The welcome tour can always be replayed from here.
    expect(screen.getByRole('button', { name: 'Replay welcome tour' })).toBeInTheDocument()
  })

  it('uses the household currency noun in the hero', () => {
    localStorage.setItem('zbb.budgetCurrency', 'USD')
    try {
      renderPage()
      expect(screen.getByRole('region', { name: 'Zero-based budgeting' })).toHaveTextContent('Give every dollar a job')
    } finally {
      localStorage.removeItem('zbb.budgetCurrency')
    }
  })

  it('opens and closes a topic with the mouse, keeping the others as they were', () => {
    renderPage()
    const jars = screen.getByRole('button', { name: 'Saving with jars' })
    expect(jars).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(jars)
    expect(jars).toHaveAttribute('aria-expanded', 'true')
    const panel = panelOf(jars)
    expect(panel).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Saving with jars' })).not.toBeInTheDocument()
    expect(panel).toHaveTextContent('A jar saves for a bill, a holiday or a rainy day, and sits in one of your accounts.')
    expect(panel).toHaveTextContent(
      'AllotJar works out what to set aside each month and puts it on the jar’s line in your Savings group.',
    )
    // Independent rows: the others stay closed.
    expect(screen.getByRole('button', { name: 'Reports' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(jars)
    expect(jars).toHaveAttribute('aria-expanded', 'false')
    expect(panel).not.toBeVisible()
  })

  it('opens and closes a topic from the keyboard (Enter and Space)', async () => {
    const user = userEvent.setup()
    renderPage()
    const bills = screen.getByRole('button', { name: 'Bills & due dates' })
    bills.focus()
    expect(document.activeElement).toBe(bills)

    await user.keyboard('{Enter}')
    expect(bills).toHaveAttribute('aria-expanded', 'true')
    const panel = panelOf(bills)
    expect(panel).toBeVisible()
    expect(panel).toHaveTextContent('Mark paid ticks it off for the month you’re viewing.')
    expect(panel).toHaveTextContent('Both are in the line’s ⋯ (on a phone, tap the line).')

    await user.keyboard(' ')
    expect(bills).toHaveAttribute('aria-expanded', 'false')
    expect(panel).not.toBeVisible()
    // Focus stays on the row either way.
    expect(document.activeElement).toBe(bills)
  })

  it('shows every topic’s facts when opened', () => {
    renderPage()
    for (const name of TOPICS) fireEvent.click(screen.getByRole('button', { name }))
    const text = (name: string) => {
      const panel = panelOf(screen.getByRole('button', { name }))
      expect(panel).toBeVisible()
      return panel.textContent ?? ''
    }
    expect(text('Months & appearance')).toContain('Dark mode is a switch in your account menu (under More on a phone)')
    expect(text('Accounts')).toContain('Start here: add each bank account, card and cash you use, with its opening balance.')
    expect(text('Accounts')).toContain('An account never goes below zero')
    expect(text('Saving with jars')).toContain('Move money shifts money between jars.')
    expect(text('Transactions')).toContain('Repeat payees categorise themselves.')
    expect(text('Transactions')).toContain('A Transfer moves money between your own accounts and never touches the budget.')
    expect(text('Importing a statement')).toContain('Import reads your bank’s CSV export or a CAMT.053 statement.')
    expect(text('Importing a statement')).toContain('Importing the same file again never creates duplicates.')
    expect(text('Reports')).toContain('What each jar paid out, monthly and for the year.')
    expect(text('People & allocation')).toContain('On your own, it stays out of the way until you add someone.')
    expect(text('Your account')).toContain('The same menu switches between them.')
    expect(text('Install the app')).toContain('iPhone: in Safari, tap Share, then Add to Home Screen.')
    expect(text('Install the app')).toContain('It opens like an app and still needs an internet connection.')
    expect(text('Good to know')).toContain('Amounts accept “12.50” or “12,50”, and sums like “20+30”; every figure is exact to the cent.')
  })

  it('replays the welcome tour from the Topics header', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Replay welcome tour' }))
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('leaves out the topics of the pages that are turned off', async () => {
    resetApiMocks()
    mockGet.mockImplementation((url: string) =>
      url === '/features'
        ? Promise.resolve({
            data: { accounts: false, jars: false, camtImport: false, reports: false, householdAllocation: false },
          })
        : Promise.resolve({ data: [] }),
    )
    renderWithProviders(<HelpPage />, { features: true })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accounts' })).not.toBeInTheDocument())
    const rows = screen.getAllByRole('button', { expanded: false }).filter((b) => b.hasAttribute('aria-controls'))
    expect(rows.map((b) => b.textContent)).toEqual([
      'Months & appearance',
      'Transactions',
      'Bills & due dates',
      'Your account',
      'Install the app',
      'Good to know',
    ])
  })

  it('has no Privacy card while analytics is not offered', () => {
    renderPage()
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
