import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { OnboardingProvider } from './OnboardingContext'
import { Onboarding } from './Onboarding'

function renderApp() {
  return renderWithProviders(
    <OnboardingProvider>
      <Onboarding />
    </OnboardingProvider>,
  )
}

describe('Onboarding', () => {
  beforeEach(() => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [] })
      if (url === '/transactions') return Promise.resolve({ data: [] })
      // The signed-in login's id keys the onboarding record; it comes from /auth/me (D2).
      if (url === '/auth/me') return Promise.resolve({ data: { userId: 'u-me', email: 'me@test.app', role: 0 } })
      return Promise.reject({ response: { status: 404 } }) // current month → none yet
    })
  })

  it('walks from welcome through the tour to the checklist', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }))

    // First step, then the zero-based goal a couple of steps in.
    expect(await screen.findByRole('heading', { name: 'Find your way around' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: /Pick the month/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: 'Give every euro a job' })).toBeInTheDocument()

    // Advance through the remaining page-by-page steps until the final one.
    let guard = 20
    while (screen.queryByRole('button', { name: 'Next' }) && guard-- > 0) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }
    expect(await screen.findByRole('heading', { name: /You're all set/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(await screen.findByRole('region', { name: 'Getting started' })).toBeInTheDocument()
  })

  it('skips cleanly, shows the checklist, and never auto-opens again', async () => {
    const { unmount } = renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))

    expect(await screen.findByRole('region', { name: 'Getting started' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument()

    const raw = localStorage.getItem('zbb.onboarding:u-me')
    expect(raw && JSON.parse(raw).welcomeSeen).toBe(true)

    // A fresh mount for the same (returning) user must not re-open the welcome.
    unmount()
    renderApp()
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument(),
    )
  })

  it('dismissing the checklist hides it and persists the choice', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    const region = await screen.findByRole('region', { name: 'Getting started' })
    expect(region).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument(),
    )

    const raw = localStorage.getItem('zbb.onboarding:u-me')
    expect(raw && JSON.parse(raw).checklistDismissed).toBe(true)
  })

  // D2 (PR #307 review P3-1): progress is kept under the login's id, never its email; a record an
  // older version kept under the email is moved across once, so a returning user isn't welcomed again.
  it('moves an email-keyed record to the login id once and deletes it', async () => {
    localStorage.setItem('zbb.onboarding:me@test.app', JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: false }))
    renderApp()

    await waitFor(() => expect(localStorage.getItem('zbb.onboarding:me@test.app')).toBeNull())
    expect(JSON.parse(localStorage.getItem('zbb.onboarding:u-me') ?? '{}').welcomeSeen).toBe(true)
    expect(screen.queryByRole('heading', { name: 'Welcome to AllotJar' })).not.toBeInTheDocument()
    expect(Object.keys(localStorage).some((k) => k.includes('@'))).toBe(false)
  })

  // Restyle PR 19: the owner's "one primary (green) button on the screen at a time".
  it('shows one primary button at a time: Take the tour, then Next / Finish, and none on the checklist', async () => {
    const primaries = (scope: HTMLElement) =>
      within(scope)
        .queryAllByRole('button')
        .filter((b) => b.classList.contains('bg-brand-600'))
        .map((b) => b.textContent)

    renderApp()
    const welcome = await screen.findByRole('dialog', { name: 'Welcome to AllotJar' })
    expect(primaries(document.body)).toEqual(['Take the tour'])
    fireEvent.click(within(welcome).getByRole('button', { name: 'Take the tour' }))

    await screen.findByRole('heading', { name: 'Find your way around' })
    for (let step = 1; step < 9; step++) {
      expect(primaries(document.body)).toEqual(['Next'])
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }
    expect(primaries(document.body)).toEqual(['Finish'])
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    const region = await screen.findByRole('region', { name: 'Getting started' })
    expect(primaries(region)).toEqual([])
    fireEvent.click(within(region).getByRole('button', { name: 'Collapse getting started' }))
    const pill = await screen.findByRole('button', { name: /Getting started/ })
    expect(pill).not.toHaveClass('bg-brand-600')
  })

  it('on a wide screen the tour card sits beside its target, not docked', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }))
    const tour = await screen.findByRole('dialog', { name: 'Find your way around' })
    expect(tour).not.toHaveAttribute('data-docked')
  })
})

// Restyle PR 19: on a phone (below 700px) the tour card docks above the tab bar, and the checklist
// starts collapsed so the Dashboard's hero and budget card stay in sight.
describe('Onboarding on a phone', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 699.98px'),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }))
    mockGet.mockImplementation((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [] })
      if (url === '/transactions') return Promise.resolve({ data: [] })
      if (url === '/auth/me') return Promise.resolve({ data: { userId: 'u-me', email: 'me@test.app', role: 0 } })
      return Promise.reject({ response: { status: 404 } })
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('docks the tour card, then shows the checklist collapsed; the pill opens it and focus follows', async () => {
    renderApp()
    // The welcome is a bottom sheet there: its grab handle is the close control.
    const welcome = await screen.findByRole('dialog', { name: 'Welcome to AllotJar' })
    expect(within(welcome).getByRole('button', { name: 'Close' })).toHaveAttribute('data-sheet-close')
    fireEvent.click(within(welcome).getByRole('button', { name: 'Take the tour' }))

    const tour = await screen.findByRole('dialog', { name: 'Find your way around' })
    expect(tour).toHaveAttribute('data-docked')
    expect(tour.style.bottom).toContain('var(--tabbar-h)')
    fireEvent.click(within(tour).getByRole('button', { name: 'Skip tour' }))

    // Collapsed: the quiet pill with its count, no open card.
    const pill = await screen.findByRole('button', { name: /Getting started/ })
    expect(pill).toHaveTextContent('0 of 5')
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument()
    // Collapsing is not dismissing.
    expect(JSON.parse(localStorage.getItem('zbb.onboarding:u-me') ?? '{}').checklistDismissed).toBe(false)

    fireEvent.click(pill)
    const region = await screen.findByRole('region', { name: 'Getting started' })
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Collapse getting started' })).toHaveFocus())
    fireEvent.click(within(region).getByRole('button', { name: 'Collapse getting started' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Getting started/ })).toHaveFocus())
  })
})
