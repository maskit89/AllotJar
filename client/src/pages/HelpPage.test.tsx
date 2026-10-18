import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

// The page's two wires out: the welcome tour's replay and the analytics event of the guide link.
const { replay, track } = vi.hoisted(() => ({ replay: vi.fn(), track: vi.fn() }))
vi.mock('../onboarding/OnboardingContext', async (importOriginal) => {
  const real = await importOriginal<typeof import('../onboarding/OnboardingContext')>()
  return { ...real, useOnboarding: () => ({ ...real.useOnboarding(), replay }) }
})
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track,
}))

import { EVENTS } from '../analytics'
import { renderWithProviders } from '../test/render'
import { HelpPage } from './HelpPage'

const renderPage = () => renderWithProviders(<HelpPage />)

/**
 * A topic's panel: the element its row's button controls, kept in the DOM and `hidden` while
 * closed. Not a landmark: nine topics open independently, and nine regions would crowd a
 * screen reader's list.
 */
const panelOf = (row: HTMLElement) => document.getElementById(row.getAttribute('aria-controls')!)!

const TOPICS = [
  'Months & appearance',
  'Transactions',
  'Bills & due dates',
  'Accounts',
  'Saving with jars',
  'Reports',
  'People & allocation',
  'Your account',
  'Good to know',
]

describe('HelpPage', () => {
  beforeEach(() => {
    replay.mockClear()
    track.mockClear()
  })

  it('shows the hero, the topics and the links to more help', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Help & guide' })).toBeInTheDocument()
    // The one idea leads the page as the named hero region (no heading: the top bar's is the only h1).
    const hero = screen.getByRole('region', { name: 'Zero-based budgeting' })
    expect(hero).toHaveTextContent('Give every euro a job')
    expect(within(hero).getByRole('button', { name: 'About zero-based budgeting' })).toBeInTheDocument()

    // Every topic is a heading holding its row's button, in the mock-up's order, all closed.
    expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { expanded: false }).filter((b) => b.hasAttribute('aria-controls'))
    expect(rows.map((b) => b.textContent)).toEqual(TOPICS)
    for (const row of rows) expect(panelOf(row)).not.toBeVisible()
    // The page's landmarks are the hero and the cards; a topic's panel is never one.
    expect(screen.getByRole('region', { name: 'Topics' })).toBeInTheDocument()
    expect(screen.getAllByRole('region')).toHaveLength(2)

    const guideLink = screen.getByRole('link', { name: /complete user guide/i })
    expect(guideLink).toHaveAttribute('href', expect.stringContaining('USER_GUIDE.md'))
    expect(guideLink).toHaveAttribute('target', '_blank')
    expect(guideLink).toHaveAttribute('rel', 'noreferrer')

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
    expect(panel).toHaveTextContent('For big or irregular costs: car, holiday, Christmas.')
    expect(panel).toHaveTextContent(
      'Its monthly contribution becomes a line in your Savings group, whose balance rolls over month to month.',
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
    expect(text('Months & appearance')).toContain('Dark mode is a switch in your account menu')
    expect(text('Transactions')).toContain('Repeat payees categorise themselves.')
    expect(text('Accounts')).toContain('opening + income − expenses')
    expect(text('Reports')).toContain('An annual overview of what you earned, spent and saved.')
    expect(text('People & allocation')).toContain('On your own, it stays out of the way until you add someone.')
    expect(text('Your account')).toContain('The same menu switches between them.')
    expect(text('Good to know')).toContain('Amounts accept both “12.50” and “12,50”; every figure is exact to the cent.')
  })

  it('replays the welcome tour from the Topics header', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Replay welcome tour' }))
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('records the guide link being opened', () => {
    renderPage()
    fireEvent.click(screen.getByRole('link', { name: /complete user guide/i }))
    expect(track).toHaveBeenCalledWith(EVENTS.helpGuideOpened)
  })

  it('has no Privacy card while analytics is not offered', () => {
    renderPage()
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
