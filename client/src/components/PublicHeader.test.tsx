import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PublicFooter, PublicHeader } from './PublicHeader'
import { LandingPage } from '../pages/LandingPage'
import { PrivacyPage } from '../pages/PrivacyPage'

// The chrome the public pages share (restyle PR 16): the landing page and the legal pages draw the
// same header row and the same footer from one place, so the landing's markup is the legal pages'
// to the byte, and both stay SSR-safe (the landing is prerendered).

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('PublicHeader / PublicFooter', () => {
  it('the header row: the wordmark home, the Primary nav with "Sign in", the "Dark mode" button', () => {
    render(<PublicHeader />)

    expect(screen.getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')
    const primary = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(primary).getAllByRole('link')).toHaveLength(1)
    expect(within(primary).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    const theme = screen.getByRole('button', { name: 'Dark mode' })
    expect(theme).toHaveAttribute('aria-pressed', 'false')
    expect(theme).toHaveClass('auth-theme')
    // The logo is decoration: no image role, and no heading in the row.
    expect(screen.queryAllByRole('img')).toEqual([])
    expect(screen.queryAllByRole('heading')).toEqual([])
  })

  it('the footer: the year, Privacy and Terms, as plain links', () => {
    render(<PublicFooter />)

    const nav = within(screen.getByRole('contentinfo')).getByRole('navigation', { name: 'Footer' })
    expect(within(nav).getByText(`© ${new Date().getFullYear()} AllotJar`)).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(nav).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(within(nav).getAllByRole('link')).toHaveLength(2)
  })

  it('the landing page and a legal page draw the same header row and the same footer', () => {
    const landing = render(<LandingPage />)
    const landingRow = landing.container.querySelector('.auth-top')!.outerHTML
    const landingFoot = screen.getByRole('contentinfo').outerHTML
    landing.unmount()

    const legal = render(<PrivacyPage />)
    expect(legal.container.querySelector('.auth-top')!.outerHTML).toBe(landingRow)
    expect(screen.getByRole('contentinfo').outerHTML).toBe(landingFoot)
  })

  it('renders to static markup without a router or browser globals (the landing is prerendered)', () => {
    const html = renderToStaticMarkup(
      <>
        <PublicHeader />
        <PublicFooter />
      </>,
    )
    expect(html).toContain('aria-label="AllotJar home"')
    expect(html).toContain('href="/login"')
    expect(html).toContain('aria-label="Dark mode"')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/terms"')
  })
})
