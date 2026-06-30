import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LandingPage } from './LandingPage'

// LandingPage is self-contained (plain <a> links, no router hooks), so it renders
// without a Router — the same property the build-time prerender relies on.
describe('LandingPage', () => {
  it('renders a single H1 carrying the brand promise', () => {
    render(<LandingPage />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent(/give every euro a job/i)
  })

  it('points the primary CTAs at the registration tab', () => {
    render(<LandingPage />)
    const ctas = screen.getAllByRole('link', { name: /create your free account/i })
    expect(ctas.length).toBeGreaterThan(0)
    ctas.forEach((cta) => expect(cta).toHaveAttribute('href', '/login?register=1'))
  })

  it('offers a sign-in link', () => {
    render(<LandingPage />)
    expect(screen.getAllByRole('link', { name: /^sign in$/i }).length).toBeGreaterThan(0)
  })

  it('includes FAQ content for long-tail search', () => {
    render(<LandingPage />)
    expect(screen.getByText(/what is zero-based budgeting/i)).toBeInTheDocument()
    expect(screen.getByText(/Is AllotJar built for Europe\?/i)).toBeInTheDocument()
  })
})
