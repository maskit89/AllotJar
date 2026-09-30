import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { renderWithProviders } from '../test/render'
import { HelpPage } from './HelpPage'

const renderPage = () => renderWithProviders(<HelpPage />)

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
