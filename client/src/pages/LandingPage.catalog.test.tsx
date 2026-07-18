import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetMonthDto } from '../types'

// Catalog coverage for docs/testing/cases/01-landing-public.md (LAND-*): the public
// marketing landing page, its currency-aware tagline swap, the SSR-safe prerender
// invariant, the `/` auth-branch (anonymous -> landing, signed in -> dashboard), the
// public legal pages + LegalLayout title lifecycle, the analytics consent banner and
// its accept/decline persistence, and the beta banner on the landing surface.
//
// These COMPLEMENT (do not duplicate) the assertions already living in
// LandingPage.test.tsx (single H1 shape, primary CTA -> register tab, one sign-in
// link, two FAQ items), LegalPages.test.tsx (Privacy H1/contact/controller/GDPR
// rights; Terms H1/Malta law/privacy link), BetaBanner.test.tsx (production build
// renders nothing; beta build warns of data loss in isolation), ConsentModal.test.tsx
// (LAND-015 — modal suppressed on /privacy + /terms) and analytics.test.ts (LAND-025/
// 026/028/030/031 — start gating, PII redaction, whitelist, consent persistence at the
// module level, not the DOM banner flow).
//
// Harness matches the repo convention (PR #169 gotcha): hoisted api mock fns,
// vi.mock('../lib/api') spreading importOriginal, `../lib/env` mocked so a test can
// flip the build-time beta flag, `getToken` reading a mutable authState so a single
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

const { mockGet, mockPost, mockPut, mockDelete, envState, authState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  envState: { isBeta: false },
  authState: { token: null as string | null },
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockPut, delete: mockDelete },
  getToken: () => authState.token,
  setToken: vi.fn(),
  // Anonymous cold-load bootstrap: no cookie session to restore (the signed-in cases
  // pre-seed a token so this refresh is skipped entirely — see AuthContext bootstrap).
  refreshSession: () => Promise.resolve(null),
}))

// Build-time env flag — default off (GA/default build) so the beta banner is absent
// unless a test opts in.
vi.mock('../lib/env', () => ({
  get IS_BETA() {
    return envState.isBeta
  },
  get APP_ENV() {
    return envState.isBeta ? 'beta' : undefined
  },
}))

import App from '../App'
import { LandingPage } from './LandingPage'
import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'
import { AuthProvider } from '../auth/AuthContext'
import { FeatureProvider } from '../features/FeatureContext'
import { AnalyticsProvider } from '../analytics/AnalyticsProvider'

// ---- shared fixtures --------------------------------------------------------

/** Income(Take-home Pay 3000) + Housing(Rent 1100) — the same shape DashboardPage.test
 *  uses, so a signed-in `/` render surfaces the recognisable "Planned amount for Rent"
 *  control that proves the dashboard (not the landing) rendered. */
function budget(): BudgetMonthDto {
  return {
    id: 'm1',
    key: '2026-06',
    year: 2026,
    month: 6,
    baseCurrency: 'EUR',
    totalIncome: 3000,
    totalPlanned: 1100,
    remainingToBudget: 1900,
    isBalanced: false,
    categories: [
      {
        id: 'inc',
        name: 'Income',
        kind: 'Income',
        displayOrder: 0,
        totalPlanned: 3000,
        totalActual: 0,
        items: [
          { id: 'i-pay', name: 'Take-home Pay', displayOrder: 0, plannedAmount: 3000, actualAmount: 0, remaining: 3000 },
        ],
      },
      {
        id: 'c1',
        name: 'Housing',
        kind: 'Expense',
        displayOrder: 0,
        totalPlanned: 1100,
        totalActual: 0,
        items: [
          { id: 'i-rent', name: 'Rent', displayOrder: 0, plannedAmount: 1100, actualAmount: 0, remaining: 1100 },
        ],
      },
    ],
  }
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

/** Force the visitor's browser locale for the mount-only tagline-noun effect. */
function withLocale(lang: string) {
  return vi.spyOn(navigator, 'language', 'get').mockReturnValue(lang)
}

beforeEach(() => {
  localStorage.clear()
  envState.isBeta = false
  authState.token = null
  featuresData = {}
  mockGet.mockReset()
  mockPost.mockReset()
  mockPut.mockReset()
  mockDelete.mockReset()
  mockPost.mockResolvedValue({ data: {} })
  mockPut.mockResolvedValue({ data: {} })
  mockDelete.mockResolvedValue({ data: {} })
  installGet()
})

// =============================================================================
// Landing page — anonymous visit (LAND-001..004)
// =============================================================================
describe('LandingPage — anonymous hero, chrome & content', () => {
  let langSpy: ReturnType<typeof withLocale>
  beforeEach(() => {
    // A Eurozone locale so the mount-only noun swap resolves deterministically to
    // "euro" (jsdom's own default is en-US -> "dollar"); the swap itself is LAND-005.
    langSpy = withLocale('de-DE')
  })
  afterEach(() => langSpy.mockRestore())

  // LAND-001 — the full hero renders for an anonymous visitor: eyebrow, single H1,
  // sub-copy, the free-to-start note, and the "Your jars" panel with three decorative
  // jars carrying accessible labels and NO visible in-jar percent text.
  it('LAND-001: renders the complete hero with the jars panel and accessible jar labels', () => {
    render(<LandingPage />)

    expect(
      screen.getByText('Zero-based budgeting · crafted in Europe, at home anywhere'),
    ).toBeInTheDocument()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Give every euro a job.')

    expect(
      screen.getByText(/^AllotJar is a zero-based budgeting app crafted in Europe and at home anywhere\./),
    ).toBeInTheDocument()
    expect(screen.getByText('Free to start · No card required')).toBeInTheDocument()

    // The "Your jars" panel.
    expect(screen.getByText('Your jars')).toBeInTheDocument()
    expect(screen.getByText('€2,480')).toBeInTheDocument()
    expect(screen.getByText('set aside across 3 jars this year')).toBeInTheDocument()

    // Three decorative jars, each exposed to assistive tech via an aria-label only.
    expect(screen.getByRole('img', { name: 'Insurance: 90% funded' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Holiday: 70% funded' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'New car: 40% funded' })).toBeInTheDocument()

    // No in-jar percentage is rendered as visible text (showPct={false}).
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
    expect(screen.queryByText('70%')).not.toBeInTheDocument()
    expect(screen.queryByText('40%')).not.toBeInTheDocument()
  })

  // LAND-002 — the header logo + Primary nav and the footer chrome carry the right
  // accessible names and hrefs (year is the current year; all links are plain <a>).
  it('LAND-002: header logo, Primary nav and footer links have the right names and hrefs', () => {
    render(<LandingPage />)

    const logo = screen.getByRole('link', { name: 'AllotJar home' })
    expect(logo).toHaveAttribute('href', '/')

    const primary = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(primary).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(within(primary).getByRole('link', { name: 'Get started' })).toHaveAttribute(
      'href',
      '/login?register=1',
    )

    const year = new Date().getFullYear()
    expect(
      screen.getByText(new RegExp(`© ${year} AllotJar · Give every euro a job\\.`)),
    ).toBeInTheDocument()

    const footer = screen.getByRole('navigation', { name: 'Footer' })
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(within(footer).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(within(footer).getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/login?register=1',
    )
  })

  // LAND-003 — every register CTA points at /login?register=1 and every sign-in CTA at
  // /login; each is a plain anchor (works middle-click / new-tab, no JS state needed).
  it('LAND-003: all register CTAs target the register tab and all sign-in CTAs the sign-in tab', () => {
    render(<LandingPage />)

    const registerCtas = screen.getAllByRole('link', {
      name: /^(get started|create your free account|create account)$/i,
    })
    // Header "Get started", hero + closing-band "Create your free account", footer "Create account".
    expect(registerCtas.length).toBeGreaterThanOrEqual(4)
    registerCtas.forEach((cta) => {
      expect(cta).toHaveAttribute('href', '/login?register=1')
      expect(cta.tagName).toBe('A')
    })

    const signInCtas = screen.getAllByRole('link', { name: /^sign in$/i })
    expect(signInCtas.length).toBeGreaterThanOrEqual(2) // hero secondary + header + footer
    signInCtas.forEach((cta) => {
      expect(cta).toHaveAttribute('href', '/login')
      expect(cta.tagName).toBe('A')
    })
  })

  // LAND-004 — the features, how-it-works and FAQ sections render with their exact
  // headings and the expected counts of cards / steps / questions.
  it('LAND-004: features (6), how-it-works (3 steps) and FAQ (5) render with exact headings', () => {
    const { container } = render(<LandingPage />)

    expect(
      screen.getByRole('heading', { name: 'Everything you need to budget with confidence' }),
    ).toBeInTheDocument()
    for (const title of [
      'Zero-based budgeting',
      'Sinking-fund jars',
      'All your accounts',
      'Reports & trends',
      'Budget as a household',
      'Private & secure',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument()
    }

    expect(screen.getByRole('heading', { name: 'How AllotJar works' })).toBeInTheDocument()
    expect(screen.getByText('Three simple steps, every month.')).toBeInTheDocument()
    const ol = container.querySelector('ol')
    expect(ol).not.toBeNull()
    expect(within(ol as HTMLElement).getAllByRole('listitem')).toHaveLength(3)
    for (const step of ['Plan the month', 'Track as you spend', 'Adjust and save']) {
      expect(screen.getByRole('heading', { level: 3, name: step })).toBeInTheDocument()
    }

    expect(screen.getByRole('heading', { name: 'Frequently asked questions' })).toBeInTheDocument()
    for (const q of [
      'What is zero-based budgeting?',
      'Can I use AllotJar outside Europe?',
      'What makes AllotJar different?',
      'Can I share my budget with my partner?',
      'How much does AllotJar cost?',
    ]) {
      expect(screen.getByText(q)).toBeInTheDocument()
    }
  })
})

// =============================================================================
// Currency-aware copy — the mount-only tagline noun swap (LAND-005/006)
// =============================================================================
describe('LandingPage — currency-aware tagline noun', () => {
  // LAND-005 — the visitor's locale swaps the tagline noun after mount, consistently
  // across the H1, the closing-CTA heading and the footer tagline.
  it('LAND-005: the browser locale swaps the noun across H1, closing CTA and footer', () => {
    const cases = [
      { lang: 'en-US', noun: 'dollar' },
      { lang: 'en-GB', noun: 'pound' },
      { lang: 'de-CH', noun: 'franc' },
      { lang: 'en-IN', noun: 'rupee' },
      { lang: 'pl-PL', noun: 'złoty' }, // unicode noun renders correctly
    ]
    for (const c of cases) {
      const spy = withLocale(c.lang)
      try {
        const view = render(<LandingPage />)
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Give every ${c.noun} a job.`)
        expect(
          screen.getByRole('heading', { name: `Ready to give every ${c.noun} a job?` }),
        ).toBeInTheDocument()
        const year = new Date().getFullYear()
        expect(
          screen.getByText(new RegExp(`© ${year} AllotJar · Give every ${c.noun} a job\\.`)),
        ).toBeInTheDocument()
        view.unmount()
      } finally {
        spy.mockRestore()
      }
    }
  })

  // LAND-006 — an unmapped region and a missing navigator.language both fall back to
  // "euro"; the "unit" fallback of currencyNoun is never reachable from the landing.
  it('LAND-006: an unmapped region (pt-PT) and an empty locale both fall back to euro, never "unit"', () => {
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
describe('LandingPage — SSR-safe prerender noun', () => {
  // LAND-007 — renderToStaticMarkup (what scripts/prerender.mjs runs) stays euro-first
  // regardless of the "visitor" locale, because the noun swap is a mount-only effect
  // that never runs during static markup. (The full build/curl check is deferred to
  // the prerender/e2e layer.)
  it('LAND-007: static markup stays euro-first even under a US locale', () => {
    const spy = withLocale('en-US')
    try {
      const html = renderToStaticMarkup(<LandingPage />)
      expect(html).toContain('Give every euro a job.')
      expect(html).not.toContain('Give every dollar a job.')
    } finally {
      spy.mockRestore()
    }
  })
})

// =============================================================================
// Beta banner on the landing surface (LAND-033)
// =============================================================================
describe('LandingPage — beta banner integration', () => {
  // LAND-033 — the beta build renders the sticky amber data-loss strip at the top of the
  // landing page itself (BetaBanner.test.tsx proves the component in isolation; this
  // proves it is wired into LandingPage). The default build's absence is LAND-034 /
  // REG-016, already automated.
  it('LAND-033: the beta build shows the data-loss strip on the landing page', () => {
    const spy = withLocale('de-DE')
    try {
      envState.isBeta = true
      render(<LandingPage />)
      const strip = screen.getByRole('status')
      expect(strip).toHaveTextContent(/Beta/)
      expect(strip).toHaveTextContent(/your data can be reset or lost without notice/i)
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

  // LAND-013 — the shared legal chrome: brand home link, a Sign-in link, and a Footer
  // nav with Home / Privacy / Terms / Sign in and the copyright line. No app shell.
  it('LAND-013: LegalLayout renders the public header + Footer nav chrome', () => {
    render(<PrivacyPage />)

    expect(screen.getByRole('link', { name: 'AllotJar home' })).toHaveAttribute('href', '/')
    // Header + footer both carry a Sign-in link, both to /login.
    const signIns = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIns.length).toBeGreaterThanOrEqual(1)
    signIns.forEach((a) => expect(a).toHaveAttribute('href', '/login'))

    const footer = screen.getByRole('navigation', { name: 'Footer' })
    expect(within(footer).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
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
  it('LAND-009: anonymous `/` renders the landing, not the login form or the dashboard', async () => {
    authState.token = null
    const langSpy = withLocale('de-DE')
    try {
      renderApp('/')
      expect(
        await screen.findByText(
          'Zero-based budgeting · crafted in Europe, at home anywhere',
          {},
          { timeout: 5000 },
        ),
      ).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Give every euro a job.')
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
    expect(
      screen.queryByText('Zero-based budgeting · crafted in Europe, at home anywhere'),
    ).not.toBeInTheDocument()
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
    expect(region).toHaveTextContent(
      'We use Google Analytics to understand how the app is used and improve it.',
    )
    expect(region).toHaveTextContent(
      'We never send your name, email, account names or any amounts — only anonymous usage.',
    )
    expect(region).toHaveTextContent('You can change this anytime under Help')
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
