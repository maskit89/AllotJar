import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { HelpPage } from './HelpPage'
import { AuthProvider } from '../auth/AuthContext'

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HelpPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('HelpPage', () => {
  it('shows the guide sections and links to the full manual', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Help & guide' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Zero-based budgeting' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument()

    const guideLink = screen.getByRole('link', { name: /complete user guide/i })
    expect(guideLink).toHaveAttribute('href', expect.stringContaining('USER_GUIDE.md'))

    // The welcome tour can always be replayed from here.
    expect(screen.getByRole('button', { name: 'Replay welcome tour' })).toBeInTheDocument()
  })
})
