import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'

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

  it('covers GDPR data-subject rights', () => {
    render(<PrivacyPage />)
    expect(screen.getByRole('heading', { name: /your rights/i })).toBeInTheDocument()
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
