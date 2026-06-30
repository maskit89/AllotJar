import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/budget/months') return Promise.resolve({ data: [] })
      if (url === '/transactions') return Promise.resolve({ data: [] })
      return Promise.reject({ response: { status: 404 } }) // current month → none yet
    }),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { AuthProvider } from '../auth/AuthContext'
import { OnboardingProvider } from './OnboardingContext'
import { Onboarding } from './Onboarding'

function renderApp() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OnboardingProvider>
          <Onboarding />
        </OnboardingProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Onboarding', () => {
  beforeEach(() => {
    localStorage.setItem('zbb.email', 'me@test.app')
  })

  it('auto-opens the welcome dialog for a brand-new user', async () => {
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Welcome to AllotJar' })).toBeInTheDocument()
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

    const raw = localStorage.getItem('zbb.onboarding:me@test.app')
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

    const raw = localStorage.getItem('zbb.onboarding:me@test.app')
    expect(raw && JSON.parse(raw).checklistDismissed).toBe(true)
  })
})
