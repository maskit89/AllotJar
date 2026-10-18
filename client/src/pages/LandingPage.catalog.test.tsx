import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetMonthDto } from '../types'

// Catalog coverage for docs/testing/cases/01-landing-public.md (LAND-*): the public
// landing page in the sign-in pages' look (restyle PR 15: the room, one line, one primary,
// the theme button, three feature cards, the closing line and the quiet footer), its
// euro-always line, the SSR-safe prerender invariant, the `/` auth-branch (anonymous ->
// landing, signed in -> dashboard), the public legal pages + LegalLayout title lifecycle,
// the analytics consent banner and its accept/decline persistence, and the staging banner
// on the landing surface.
//
// These complement the assertions in LegalPages.test.tsx (Privacy H1/contact/controller/GDPR
// rights; Terms H1/Malta law/privacy link), StagingBanner.test.tsx (production build
// renders nothing; staging build warns of data loss in isolation), ConsentModal.test.tsx
// (LAND-015 — modal suppressed on /privacy + /terms) and analytics.test.ts (LAND-025/
// 026/028/030/031 — start gating, PII redaction, whitelist, consent persistence at the
// module level, not the DOM banner flow).
//
// Harness matches the repo convention: the shared api mock, `../lib/env` mocked so a test can
// flip the build-time staging flag, `getToken` reading a mutable authState so a single
// file can render the `/` branch signed out AND signed in. The analytics module is
// left REAL — no measurement id exists under test, so isConfigured() is false and GA
// never starts; the consent banner still shows on the flag alone (by design), which is
// exactly the DOM surface these tests exercise.
//
// Deferred to other layers (documented, not automatable in a jsdom component render):
//   - LAND-007 build/curl of the prerendered dist HTML (the SSR string invariant IS
//     asserted here via renderToStaticMarkup; the actual `npm run build` output belongs
//     to the prerender/e2e layer).
//   - LAND-008/009 splash->content no-flash *sequence* and the single-flight refresh
//     count (AuthContext.test.tsx owns the count; e2e owns the visual no-flash).
//   - LAND-016 dark-mode AA contrast, LAND-024 axe scan (a11y/e2e).
//   - LAND-025/026 GA Consent Mode v2 wire sequence, LAND-030/031 GA payloads (no real
//     gtag/network under jsdom; analytics.test.ts + e2e own these).
//   - LAND-029 Case B (localStorage access throwing) — the polyfilled in-memory storage
//     can't be made to throw without global surgery; Case A (garbage value) is covered.

const { envState, authState } = vi.hoisted(() => ({
  envState: { isStaging: false },
  authState: { token: null as string | null },
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => authState.token,
    // Anonymous cold-load bootstrap: no cookie session to restore (the signed-in cases
    // pre-seed a token so this refresh is skipped entirely — see AuthContext bootstrap).
    refreshSession: () => Promise.resolve(null),
  }),
)

// Build-time env flag — default off (GA/default build) so the staging banner is absent
// unless a test opts in.
vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return envState.isStaging
  },
  get APP_ENV() {
    return envState.isStaging ? 'staging' : undefined
  },
}))

import { mockGet, mockPut, mockPost, mockDelete, resetApiMocks } from '../test/apiMock'
import App from '../App'
import { LandingPage } from './LandingPage'
import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'
import { AuthProvider } from '../auth/AuthContext'
import { FeatureProvider } from '../features/FeatureContext'
import { AnalyticsProvider } from '../analytics/AnalyticsProvider'
import { budgetCategory, budgetItem, budgetMonth } from '../test/fixtures/budget'

// ---- shared fixtures --------------------------------------------------------

/** Income(Take-home Pay 3000) + Housing(Rent 1100) — the same shape DashboardPage.test
 *  uses, so a signed-in `/` render surfaces the recognisable "Planned amount for Rent"
 *  control that proves the dashboard (not the landing) rendered. */
function budget(): BudgetMonthDto {
  return budgetMonth({
    key: '2026-06',
    month: 6,
    categories: [
      budgetCategory({ id: 'inc', name: 'Income', kind: 'Income', items: [budgetItem({ id: 'i-pay', name: 'Take-home Pay', plannedAmount: 3000 })] }),
      budgetCategory({ id: 'c1', name: 'Housing', items: [budgetItem({ id: 'i-rent', name: 'Rent', plannedAmount: 1100 })] }),
    ],
  })
}

/** The /auth/me body an authenticated `/` render loads (needsConsent false so the
 *  ConsentModal stays hidden and cannot steal the dashboard assertion). */
function meOwner() {
  return {
    userId: 'u1',
    email: 'owner@example.com',
    displayName: 'Owner',
    firstName: 'Olive',
    lastName: 'Owner',
    role: 0,
    ownerId: 'u1',
    memberId: null,
    households: [],
    needsConsent: false,
    preferredCurrency: 'EUR',
    numberFormat: 'comma-dot',
  }
}

// Per-test mutable server state, reset in beforeEach.
let featuresData: Record<string, unknown> = {}

function installGet() {
  mockGet.mockImplementation((url: string) => {
    if (url === '/features') return Promise.resolve({ data: featuresData })
    if (url === '/auth/me') return Promise.resolve({ data: meOwner() })
    if (url === '/budget/months' || url === '/budget/templates' || url === '/jars') {
      return Promise.resolve({ data: [] })
    }
    if (typeof url === 'string' && url.startsWith('/budget/')) return Promise.resolve({ data: budget() })
    return Promise.resolve({ data: {} })
  })
}

/** Force the visitor's browser locale (the landing's line must not follow it). */
function withLocale(lang: string) {
  return vi.spyOn(navigator, 'language', 'get').mockReturnValue(lang)
}

beforeEach(() => {
  localStorage.clear()
  envState.isStaging = false
  authState.token = null
  featuresData = {}
  resetApiMocks()
  mockPost.mockResolvedValue({ data: {} })
  mockPut.mockResolvedValue({ data: {} })
  mockDelete.mockResolvedValue({ data: {} })
  installGet()
})

// =============================================================================
// Landing page — anonymous visit (LAND-001..004)
// =============================================================================
describe('LandingPage — the room, the card and the chrome', () => {
  // LAND-001 — the hero for an anonymous visitor: exactly one H1 (the line, euro always), the
  // one sentence, the free-to-start note, and the shelf's jars as decoration only (no figure,
  // no labelled jars, no percent text: nothing on the page is an invented number).
  it('LAND-001: renders the line, the sentence and the note; the jars are decoration', () => {
    render(<LandingPage />)

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Give every euro a job.')

    expect(
      screen.getByText(
        'Zero-based budgeting for households: plan the month to zero, with jars for the big bills and a budget you share.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Free to start · No card required')).toBeInTheDocument()

    // The old hero's figure and labelled jars are gone; the glass jars carry no name.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByText(/€\s?\d/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument()
  })

  // LAND-002 — the header (the wordmark home link, the Primary nav's quiet "Sign in", the theme
  // button) and the quiet footer (the year, Privacy, Terms; no sign-in or register links there).
  it('LAND-002: header wordmark, Primary nav, theme button and the quiet footer', () => {
    render(<LandingPage />)

    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')

    const primary = within(header).getByRole('navigation', { name: 'Primary' })
    expect(within(primary).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(within(primary).queryByRole('link', { name: /get started/i })).not.toBeInTheDocument()

    // The theme button, as the sign-in page has: a toggle named "Dark mode", off in light mode.
    const theme = within(header).getByRole('button', { name: 'Dark mode' })
    expect(theme).toHaveAttribute('aria-pressed', 'false')

    const footer = screen.getByRole('contentinfo')
    const year = new Date().getFullYear()
    expect(within(footer).getByText(`© ${year} AllotJar`)).toBeInTheDocument()
    const nav = within(footer).getByRole('navigation', { name: 'Footer' })
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(nav).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(within(nav).getAllByRole('link')).toHaveLength(2)
  })

  // LAND-003 — every CTA is a plain anchor to today's targets: "Create your free account" (the
  // hero's and the closing line's) → /login?register=1, both "Sign in" links → /login. One
  // primary (green) button per screen: the hero card holds one and the closing line the other,
  // nothing else on the page is filled green.
  it('LAND-003: the two register CTAs and the two sign-in links are plain anchors to the login tabs; one primary per screen', () => {
    const { container } = render(<LandingPage />)

    const registerCtas = screen.getAllByRole('link', { name: 'Create your free account' })
    expect(registerCtas).toHaveLength(2)
    registerCtas.forEach((cta) => {
      expect(cta).toHaveAttribute('href', '/login?register=1')
      expect(cta.tagName).toBe('A')
    })
    expect(screen.queryByRole('link', { name: /^(get started|create account)$/i })).not.toBeInTheDocument()

    const signIns = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIns).toHaveLength(2) // the header's and the one beside the primary
    signIns.forEach((a) => {
      expect(a).toHaveAttribute('href', '/login')
      expect(a.tagName).toBe('A')
    })

    const primaries = container.querySelectorAll('.bg-brand-600')
    expect(primaries).toHaveLength(2)
    expect(primaries[0].closest('.auth-card')).not.toBeNull()
    expect(primaries[1].closest('.land-close')).not.toBeNull()
    // "Sign in" beside the primary is a quiet link, not a second button.
    expect(signIns[1].className).not.toMatch(/bg-brand/)
  })

  // LAND-004 — the three feature cards (one glyph, a short title, one line each), the one line of
  // promises, and the closing line; the old six-card grid, the three steps and the FAQ are gone.
  it('LAND-004: three feature cards, the promises line and the closing line; no steps, no FAQ', () => {
    render(<LandingPage />)

    const features = screen.getByRole('region', { name: 'What AllotJar does' })
    const cards = within(features).getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    const titles = ['Budget to zero', 'Jars for the big bills', 'Budget together']
    const lines = [
      'Plan the month until Remaining to budget reads zero.',
      'Set a little aside each month for insurance, the car and the holiday.',
      'One shared budget for everyone in your household.',
    ]
    cards.forEach((card, i) => {
      expect(within(card).getByRole('heading', { level: 3, name: titles[i] })).toBeInTheDocument()
      expect(within(card).getByText(lines[i])).toBeInTheDocument()
      // One line each: the title and its line are the card's only text.
      expect(card.textContent).toBe(titles[i] + lines[i])
    })
    expect(within(features).getByText('In your currency, the way you write it')).toBeInTheDocument()
    expect(within(features).getByText('Your data is never sold.')).toBeInTheDocument()

    expect(screen.getByRole('heading', { level: 2, name: 'Ready to give every euro a job?' })).toBeInTheDocument()

    for (const gone of [
      'Everything you need to budget with confidence',
      'How AllotJar works',
      'Frequently asked questions',
      'Sinking-fund jars',
      'crafted in Europe',
    ]) {
      expect(screen.queryByText(new RegExp(gone, 'i'))).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('list', { name: /faq/i })).not.toBeInTheDocument()
  })

  // The theme button works on the public page: a press turns dark mode on (the `.dark` class on
  // <html>, persisted under zbb.theme) and the toggle reads pressed.
  it('the theme button switches the page to dark mode and back', async () => {
    const user = userEvent.setup()
    render(<LandingPage />)
    const theme = screen.getByRole('button', { name: 'Dark mode' })

    await user.click(theme)
    expect(theme).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('zbb.theme')).toBe('dark')

    await user.click(theme)
    expect(theme).toHaveAttribute('aria-pressed', 'false')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  // The skip link and the landmarks: one banner, one main (the skip link's target), one
  // contentinfo, the Primary and Footer navs.
  it('has the skip link and one of each landmark', () => {
    render(<LandingPage />)
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1)
    expect(screen.getAllByRole('navigation')).toHaveLength(2)
  })

  // #351 review P3-2: the skip link's target is programmatically focusable (tabindex -1, as the
  // app frame's main), so following the link really moves focus into the content.
  it('the skip link lands focus on the main content', () => {
    render(<LandingPage />)
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('tabindex', '-1')
    main.focus()
    expect(document.activeElement).toBe(main)
  })
})

// =============================================================================
// Euro always (LAND-005/006)
// =============================================================================
describe('LandingPage — the line says euro whatever the browser locale', () => {
  // LAND-005 — the app is euro-first: the line, the closing line and the footer never follow the
  // visitor's locale (the sign-in page's noun swap is not on this page), so the prerendered HTML
  // never changes after the SPA mounts and a UK visitor never reads "pound" here.
  it('LAND-005: the H1 and the closing line read euro under every locale', () => {
    for (const lang of ['en-US', 'en-GB', 'de-CH', 'en-IN', 'pl-PL', 'de-DE']) {
      const spy = withLocale(lang)
      try {
        const view = render(<LandingPage />)
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Give every euro a job.')
        expect(screen.getByRole('heading', { name: 'Ready to give every euro a job?' })).toBeInTheDocument()
        expect(screen.queryByText(/give every (dollar|pound|franc|rupee|złoty) a job/i)).not.toBeInTheDocument()
        view.unmount()
      } finally {
        spy.mockRestore()
      }
    }
  })

  // LAND-006 — an unmapped region and a missing navigator.language change nothing either, and
  // "unit" can never appear.
  it('LAND-006: an unmapped region (pt-PT) and an empty locale read euro too, never "unit"', () => {
    for (const lang of ['pt-PT', '']) {
      const spy = withLocale(lang)
      try {
        const view = render(<LandingPage />)
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Give every euro a job.')
        expect(screen.queryByText(/give every unit a job/i)).not.toBeInTheDocument()
        view.unmount()
      } finally {
        spy.mockRestore()
      }
    }
  })
})

// =============================================================================
// Prerender / SSR safety (LAND-007 — the automatable core)
// =============================================================================
describe('LandingPage — SSR-safe prerender', () => {
  // LAND-007 — renderToStaticMarkup (what scripts/prerender.mjs runs) carries the line (euro),
  // the primary, the sign-in link, the theme button and the feature cards, whatever the
  // "visitor" locale. (The full build check, that dist/index.html contains the line, belongs to
  // the build/e2e layer.)
  it('LAND-007: static markup holds the euro line, both CTAs, the theme button and the cards', () => {
    const spy = withLocale('en-US')
    try {
      const html = renderToStaticMarkup(<LandingPage />)
      expect(html).toContain('Give every <span class="gold-number">euro</span> a job.')
      expect(html).not.toMatch(/Give every (dollar|pound)/)
      expect(html).toContain('href="/login?register=1"')
      expect(html).toContain('href="/login"')
      expect(html).toContain('aria-label="Dark mode"')
      expect(html).toContain('Jars for the big bills')
      expect(html).toContain('Ready to give every euro a job?')
      // Nothing reads window, document or navigator during render: the static render is
      // the same as the client's first render.
      expect(html).toBe(renderToStaticMarkup(<LandingPage />))
    } finally {
      spy.mockRestore()
    }
  })
})

// =============================================================================
// Staging banner on the landing surface (LAND-033)
// =============================================================================
describe('LandingPage — staging banner integration', () => {
  // LAND-033 — the staging build renders the sticky warn-tone data-loss strip at the top of the
  // landing page itself (StagingBanner.test.tsx proves the component in isolation; this
  // proves it is wired into LandingPage). The default build's absence is LAND-034 /
  // REG-016, already automated.
  it('LAND-033: the staging build shows the data-loss strip on the landing page', () => {
    const spy = withLocale('de-DE')
    try {
      envState.isStaging = true
      render(<LandingPage />)
      const strip = screen.getByRole('status')
      expect(strip).toHaveTextContent(/Staging/)
      expect(strip).toHaveTextContent('Staging · test data, may be reset')
    } finally {
      spy.mockRestore()
    }
  })
})

// =============================================================================
// Legal pages & LegalLayout (LAND-011/012/013)
// =============================================================================
describe('Legal pages — Privacy & Terms completeness and chrome', () => {
  // LAND-011 — the Privacy page carries the dated header, the Malta IDPC complaint link
  // and the 16+ children clause (complements the H1/controller/GDPR-rights already in
  // LegalPages.test.tsx).
  it('LAND-011: Privacy shows the last-updated date, the Malta IDPC link and the 16+ clause', () => {
    render(<PrivacyPage />)
    expect(screen.getByText('Last updated: 1 July 2026')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'idpc.org.mt' })).toHaveAttribute('href', 'https://idpc.org.mt')
    expect(screen.getByText(/intended for users aged 16 and over/i)).toBeInTheDocument()
  })

  // LAND-012 — the Terms page has exactly 13 numbered sections, the dated header, the
  // eligibility 16+ clause, the "Not financial advice" section and Maltese exclusive
  // jurisdiction (complements the H1/Malta-law/privacy-link already covered).
  it('LAND-012: Terms has 13 numbered sections incl. "Not financial advice" and Malta jurisdiction', () => {
    render(<TermsPage />)
    expect(screen.getByText('Last updated: 1 July 2026')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(13)
    expect(screen.getByRole('heading', { name: /Not financial advice/i })).toBeInTheDocument()
    expect(screen.getByText(/at least 16 years old/i)).toBeInTheDocument()
    expect(screen.getByText(/exclusive jurisdiction of the courts of Malta/i)).toBeInTheDocument()
  })

  // LAND-013 — LegalLayout gives each page a distinct document title on mount and
  // restores the previous title on unmount.
  it('LAND-013: LegalLayout sets the tab title on mount and restores it on unmount', () => {
    const spaDefault = 'AllotJar — Zero-Based Budgeting App'
    document.title = spaDefault

    const privacy = render(<PrivacyPage />)
    expect(document.title).toBe('Privacy Policy — AllotJar')
    privacy.unmount()
    expect(document.title).toBe(spaDefault)

    const terms = render(<TermsPage />)
    expect(document.title).toBe('Terms of Service — AllotJar')
    terms.unmount()
    expect(document.title).toBe(spaDefault)
  })

  // LAND-013 — the shared public chrome (restyle PR 16: the landing's header row and footer):
  // the wordmark is the way home, the header's Primary nav holds the one Sign-in link, and the
  // Footer nav is the landing's (Privacy, Terms, the copyright line: no Home, no Sign in). No
  // app shell.
  it('LAND-013: LegalLayout renders the public header + Footer nav chrome', () => {
    render(<PrivacyPage />)

    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')
    const signIns = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIns).toHaveLength(1)
    expect(within(header).getByRole('navigation', { name: 'Primary' })).toContainElement(signIns[0])
    expect(signIns[0]).toHaveAttribute('href', '/login')
    expect(within(header).getByRole('button', { name: 'Dark mode' })).toBeInTheDocument()

    const footer = screen.getByRole('navigation', { name: 'Footer' })
    expect(within(footer).queryByRole('link', { name: 'Home' })).not.toBeInTheDocument()
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(within(footer).getAllByRole('link')).toHaveLength(2)
    const year = new Date().getFullYear()
    expect(within(footer).getByText(`© ${year} AllotJar`)).toBeInTheDocument()
  })
})

// =============================================================================
// Route `/` auth branching (LAND-008/009)
// =============================================================================
describe('Route `/` — auth-state branching', () => {
  function renderApp(path = '/') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <FeatureProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </FeatureProvider>
      </MemoryRouter>,
    )
  }

  // LAND-009 — an anonymous cold load lands on the marketing landing after the bootstrap
  // refresh resolves signed-out: no dashboard, no bounce to /login.
  it('LAND-009: anonymous `/` renders the landing, not the login form or the dashboard', { timeout: 15000 }, async () => {
    authState.token = null
    // A non-euro locale: the line still says euro (LAND-005).
    const langSpy = withLocale('en-GB')
    try {
      renderApp('/')
      expect(await screen.findByText('Free to start · No card required', {}, { timeout: 5000 })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Give every euro a job.')
      expect(screen.getAllByRole('link', { name: 'Create your free account' })).toHaveLength(2)
      // Not the login form, not the dashboard.
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Planned amount for Rent')).not.toBeInTheDocument()
    } finally {
      langSpy.mockRestore()
    }
  })

  // LAND-008 — a signed-in visit to `/` renders the dashboard (month view), never the
  // marketing landing.
  it('LAND-008: authenticated `/` renders the dashboard and never the landing', { timeout: 15000 }, async () => {
    authState.token = 'tok'
    renderApp('/')

    expect(
      await screen.findByLabelText('Planned amount for Rent', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    // No landing content at any point once authed.
    expect(screen.queryByRole('link', { name: 'Create your free account' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { level: 1, name: /give every \w+ a job/i }),
    ).not.toBeInTheDocument()
  })
})

// =============================================================================
// Analytics consent banner & gating (LAND-024/025/026/027/028/029)
// =============================================================================
describe('Analytics consent banner', () => {
  function renderBanner(path = '/') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <FeatureProvider>
          <AuthProvider>
            <AnalyticsProvider>
              <div>app content</div>
            </AnalyticsProvider>
          </AuthProvider>
        </FeatureProvider>
      </MemoryRouter>,
    )
  }

  const CONSENT_KEY = 'zbb.analyticsConsent'

  // LAND-024 — with the flag on and no stored choice, the non-modal consent region
  // appears (after the features fetch) with the exact copy and Decline / Accept buttons.
  it('LAND-024: flag on + undecided shows the consent region with the exact copy and both buttons', async () => {
    featuresData = { analytics: true }
    renderBanner()

    const region = await screen.findByRole('region', { name: 'Analytics consent' }, { timeout: 5000 })
    expect(region).toHaveTextContent('We use Google Analytics for anonymous usage only; change it under Help.')
    // One line (restyle PR 17): the detail lives on the Help page's Privacy card.
    expect(region.textContent).not.toMatch(/never send/)
    expect(within(region).getByRole('button', { name: 'Decline' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Accept' })).toBeInTheDocument()
  })

  // LAND-027 — with the flag off (the code default), the banner never renders and no
  // consent key is created.
  it('LAND-027: flag off renders no banner and creates no consent key', async () => {
    featuresData = { analytics: false }
    renderBanner()

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/features'), { timeout: 5000 })
    expect(await screen.findByText('app content', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Analytics consent' })).not.toBeInTheDocument()
    expect(localStorage.getItem(CONSENT_KEY)).toBeNull()
  })

  // LAND-025 / LAND-028 — Accept persists "granted" and dismisses the banner; with no
  // build-time measurement id nothing actually starts (isConfigured() false) and no
  // error is thrown — the silently-inert path.
  it('LAND-025/028: Accept persists "granted", dismisses the banner and starts nothing (inert without an id)', async () => {
    featuresData = { analytics: true }
    const user = userEvent.setup()
    renderBanner()

    const region = await screen.findByRole('region', { name: 'Analytics consent' }, { timeout: 5000 })
    await user.click(within(region).getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(localStorage.getItem(CONSENT_KEY)).toBe('granted'), { timeout: 5000 })
    await waitFor(
      () => expect(screen.queryByRole('region', { name: 'Analytics consent' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
    // No GA hosts are reachable under jsdom; the only side effect is the stored choice.
    expect(mockPost).not.toHaveBeenCalledWith(expect.stringContaining('google'), expect.anything())
  })

  // LAND-026 — Decline persists "denied" and dismisses the banner; it does not reappear
  // for the remainder of the render (denied !== null).
  it('LAND-026: Decline persists "denied" and dismisses the banner', async () => {
    featuresData = { analytics: true }
    const user = userEvent.setup()
    renderBanner()

    const region = await screen.findByRole('region', { name: 'Analytics consent' }, { timeout: 5000 })
    await user.click(within(region).getByRole('button', { name: 'Decline' }))

    await waitFor(() => expect(localStorage.getItem(CONSENT_KEY)).toBe('denied'), { timeout: 5000 })
    await waitFor(
      () => expect(screen.queryByRole('region', { name: 'Analytics consent' })).not.toBeInTheDocument(),
      { timeout: 5000 },
    )
  })

  // LAND-029 (Case A) — a corrupted stored value (anything other than exactly
  // granted/denied) reads as undecided, so the banner still shows; no crash.
  it('LAND-029: a garbage stored consent value degrades to undecided and shows the banner', async () => {
    localStorage.setItem(CONSENT_KEY, 'yes') // not a valid ConsentChoice
    featuresData = { analytics: true }
    renderBanner()

    expect(
      await screen.findByRole('region', { name: 'Analytics consent' }, { timeout: 5000 }),
    ).toBeInTheDocument()
  })
})
