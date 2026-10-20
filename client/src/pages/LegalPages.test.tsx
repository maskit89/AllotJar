import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The public legal pages: the policy and the terms themselves, and (restyle PR 16) the chrome
// LegalLayout draws around them — the landing page's header row (the wordmark home, "Sign in",
// the theme button), one card holding the h1, the "Last updated" line and the prose, the
// landing's footer. `../lib/env` is mocked so a test can flip the staging flag.

const envState = vi.hoisted(() => ({ isStaging: false }))
vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return envState.isStaging
  },
  get APP_ENV() {
    return envState.isStaging ? 'staging' : undefined
  },
}))

import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  envState.isStaging = false
})

// Both legal pages are self-contained (plain <a> links, no router hooks).
describe('PrivacyPage', () => {
  it('renders the policy with an H1 and the contact address', () => {
    render(<PrivacyPage />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/privacy policy/i)
    expect(screen.getByText(/data controller/i)).toBeInTheDocument()
    const contact = screen.getAllByRole('link', { name: /privacy@allotjar\.com/i })
    expect(contact.length).toBeGreaterThan(0)
    expect(contact[0]).toHaveAttribute('href', 'mailto:privacy@allotjar.com')
  })

  it('covers GDPR data-subject rights, with the in-app export and delete', () => {
    render(<PrivacyPage />)
    expect(screen.getByRole('heading', { name: /your rights/i })).toBeInTheDocument()
    expect(screen.getByText(/“Download my data” in Account settings/)).toBeInTheDocument()
    expect(screen.getByText(/“Delete account” in Account settings/)).toBeInTheDocument()
  })

  // Compliance fix 6: the policy names what the app really does with data.
  it('names imports and bank details, the providers, where the server is and real retention periods', () => {
    render(<PrivacyPage />)
    expect(screen.getByText(/CAMT\.053 or CSV/)).toBeInTheDocument()
    expect(screen.getAllByText(/IBAN/).length).toBeGreaterThan(0)
    for (const name of ['InterServer', 'Cloudflare', 'Google']) {
      expect(screen.getAllByText(new RegExp(name)).length).toBeGreaterThan(0)
    }
    expect(screen.getByRole('heading', { name: /where your data is/i })).toBeInTheDocument()
    expect(screen.getByText(/the transfer is protected by/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /how long we keep it/i })).toBeInTheDocument()
    expect(screen.getByText(/14 days/)).toBeInTheDocument()
    // Compliance fix 9: tied to RefreshTokenService.LifetimeDays (+1 for the daily purge) and
    // ExpiredRecordsPurge.InviteGraceDays by RetentionPolicyGuardTests on the server side.
    expect(screen.getByText(/deleted within 31 days of its last use/)).toBeInTheDocument()
    expect(screen.getByText(/30 days after its link\s+expires/)).toBeInTheDocument()
    expect(screen.getByText(/fonts are served from our own server/i)).toBeInTheDocument()
    // Any login, including one an owner gives a household person, is for 16 and over (review P2-1).
    expect(screen.getByText(/anyone you give one must be 16 or over/)).toBeInTheDocument()
  })

  // The constants only the operator can confirm start as [TO CONFIRM: ...]; none may ship.
  it('has no unconfirmed placeholder left', () => {
    const { container } = render(<PrivacyPage />)
    expect(container.textContent).not.toMatch(/TO CONFIRM/)
  })
})

describe('TermsPage', () => {
  it('renders the terms with an H1 and Maltese governing law', () => {
    render(<TermsPage />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/terms of service/i)
    expect(screen.getByRole('heading', { name: /governing law/i })).toBeInTheDocument()
    expect(screen.getByText(/laws of Malta/i)).toBeInTheDocument()
  })

  it('links to the privacy policy', () => {
    render(<TermsPage />)
    const links = screen.getAllByRole('link', { name: /privacy policy/i })
    expect(links.some((a) => a.getAttribute('href') === '/privacy')).toBe(true)
  })
})

describe('LegalLayout in the warm look (restyle PR 16)', () => {
  it('the header is the landing page\'s: the wordmark home, the Primary nav\'s "Sign in", the "Dark mode" button', () => {
    render(<TermsPage />)

    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')
    expect(header).toHaveTextContent('AllotJar')
    const primary = within(header).getByRole('navigation', { name: 'Primary' })
    expect(within(primary).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(within(header).getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false')
    // No Light | Dark group anywhere, and no green room's line: a document page.
    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Give every euro a job/)).not.toBeInTheDocument()
    // One Sign in on the page: the header's (the footer no longer repeats it).
    expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(1)
  })

  it('the theme button switches the page to dark mode and back', async () => {
    const user = userEvent.setup()
    render(<PrivacyPage />)
    const theme = screen.getByRole('button', { name: 'Dark mode' })

    await user.click(theme)
    expect(theme).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('zbb.theme')).toBe('dark')

    await user.click(theme)
    expect(theme).toHaveAttribute('aria-pressed', 'false')
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('one card holds the h1, the "Last updated" line and the prose, in that order', () => {
    render(<PrivacyPage />)

    const main = screen.getByRole('main')
    const card = within(main).getByRole('article')
    const h1 = within(card).getByRole('heading', { level: 1, name: 'Privacy Policy' })
    const date = within(card).getByText(/^Last updated: /)
    const prose = card.querySelector('.legal-prose')!
    expect(h1.nextElementSibling).toBe(date)
    expect(date.nextElementSibling).toBe(prose)
    expect(within(prose as HTMLElement).getByRole('heading', { level: 2, name: 'Who we are' })).toBeInTheDocument()
    // Exactly one h1 on the page, inside the card.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('the footer is the landing page\'s: the year, Privacy and Terms, nothing else', () => {
    render(<TermsPage />)

    const footer = within(screen.getByRole('contentinfo')).getByRole('navigation', { name: 'Footer' })
    expect(within(footer).getByText(`© ${new Date().getFullYear()} AllotJar`)).toBeInTheDocument()
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(within(footer).getAllByRole('link')).toHaveLength(2)
    expect(within(footer).queryByRole('link', { name: 'Home' })).not.toBeInTheDocument()
  })

  it('has the skip link, whose target takes focus, and one of each landmark', () => {
    render(<PrivacyPage />)

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content')
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).toHaveAttribute('tabindex', '-1')
    main.focus()
    expect(document.activeElement).toBe(main)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1)
    expect(screen.getAllByRole('navigation')).toHaveLength(2)
  })

  it('shows the staging banner in a staging build above the header, as the landing does', () => {
    envState.isStaging = true
    render(<PrivacyPage />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Staging · test data, may be reset')
    expect(status.compareDocumentPosition(screen.getByRole('banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
