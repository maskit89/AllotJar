import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

// The Privacy card exists only while the household is offered analytics (the `analytics` feature
// flag): the hook stands in for the provider, in each of the three consent states.
const { analytics } = vi.hoisted(() => ({
  analytics: {
    available: true,
    consent: null as 'granted' | 'denied' | null,
    accept: vi.fn(),
    decline: vi.fn(),
    reset: vi.fn(),
  },
}))
vi.mock('../analytics/AnalyticsProvider', () => ({ useAnalytics: () => analytics }))

import { renderWithProviders } from '../test/render'
import { HelpPage } from './HelpPage'

const renderPage = () => renderWithProviders(<HelpPage />)

describe('HelpPage — the Privacy card', () => {
  beforeEach(() => {
    analytics.available = true
    analytics.consent = null
    analytics.accept.mockClear()
    analytics.decline.mockClear()
  })

  it('renders only while analytics is offered', () => {
    analytics.available = false
    const { unmount } = renderPage()
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    unmount()

    analytics.available = true
    renderPage()
    expect(screen.getByRole('heading', { name: 'Privacy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About privacy' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Google Analytics' })).toBeInTheDocument()
  })

  it('explains what is sent behind the (i)', () => {
    renderPage()
    expect(screen.queryByText(/only anonymous page views/)).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About privacy' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'We use Google Analytics to understand how AllotJar is used, so we can improve it. We never send your name, email, account or category names, or any amounts: only anonymous page views and feature-usage events. You can change this at any time.',
    )
  })

  it('undecided: the switch is off, says so, and a click accepts', () => {
    renderPage()
    const sw = screen.getByRole('switch', { name: 'Google Analytics' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveAccessibleDescription('Not chosen yet')
    fireEvent.click(sw)
    expect(analytics.accept).toHaveBeenCalledTimes(1)
    expect(analytics.decline).not.toHaveBeenCalled()
  })

  it('declined: the switch is off without the sub-line, and a click accepts', () => {
    analytics.consent = 'denied'
    renderPage()
    const sw = screen.getByRole('switch', { name: 'Google Analytics' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('Not chosen yet')).not.toBeInTheDocument()
    fireEvent.click(sw)
    expect(analytics.accept).toHaveBeenCalledTimes(1)
  })

  it('granted: the switch is on, and a click declines', () => {
    analytics.consent = 'granted'
    renderPage()
    const sw = screen.getByRole('switch', { name: 'Google Analytics' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Not chosen yet')).not.toBeInTheDocument()
    fireEvent.click(sw)
    expect(analytics.decline).toHaveBeenCalledTimes(1)
    expect(analytics.accept).not.toHaveBeenCalled()
  })

  it('toggles from the keyboard', async () => {
    analytics.consent = 'granted'
    const user = userEvent.setup()
    renderPage()
    const sw = screen.getByRole('switch', { name: 'Google Analytics' })
    sw.focus()
    await user.keyboard(' ')
    expect(analytics.decline).toHaveBeenCalledTimes(1)
    await user.keyboard('{Enter}')
    expect(analytics.decline).toHaveBeenCalledTimes(2)
  })

  it('keeps the page’s reading order: hero, topics, then privacy', () => {
    renderPage()
    const hero = screen.getByRole('region', { name: 'Zero-based budgeting' })
    const topics = screen.getByRole('heading', { name: 'Topics' })
    const privacy = screen.getByRole('heading', { name: 'Privacy' })
    expect(hero.compareDocumentPosition(topics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(topics.compareDocumentPosition(privacy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
