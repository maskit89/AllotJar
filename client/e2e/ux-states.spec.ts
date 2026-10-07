import { expect, test, type Locator, type Page } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * Empty / loading / error presentation-state sweep — the slice of
 * docs/testing/cases/26-ux-states.md (prefix UX) that only a *real browser + real
 * router + real CSS* render can prove, complementing the sibling specs:
 *
 *  - a11y.spec.ts axe-scans the HAPPY path only (never the empty/error fixtures);
 *  - mobile-layout.spec.ts guards 375px document overflow;
 *  - keyboard-a11y.spec.ts covers focus / keyboard / ARIA structure;
 *  - responsive-dark.spec.ts proves DARK-mode token inversion of the shared
 *    ErrorBanner (/reports) and EmptyState (/transactions) primitives.
 *
 * This file adds what those leave open — the cross-page *conventions* for the
 * three data-state surfaces, asserted structurally in the default (light) theme:
 *
 *  1. EmptyState (UX-038): every zero-data surface renders the shared dashed-card
 *     primitive with an icon medallion, a semibold title and muted copy (and the
 *     in-card CTA where the page supplies one) — consistent, not ad-hoc.
 *  2. Loading (UX-041): while the page's primary GET is in flight the loading
 *     placeholder shows, then swaps to content — it never flashes the empty-state
 *     or error before the fetch resolves.
 *  3. Error (UX-043 / UX-021): a failed primary GET surfaces a role="alert" load
 *     strip with the page's copy and the page stays usable (shell + primary action
 *     intact) — no white-screen, no half-rendered page.
 *
 * Determinism: the loading state is observed with a manually-gated route (the
 * response is released on command — no arbitrary sleep) and everything is asserted
 * via expect-polling / waitFor. Stubbing + auth setup reuse mocks.ts exactly as the
 * sibling specs do; the empty/error/gate routes are registered AFTER authedSetup's
 * catch-all so they win for their path (later route wins in Playwright), and the
 * gate defers to that catch-all via route.fallback() so the real happy fixture is
 * what finally renders — no fixture is duplicated here.
 */

// ---------------------------------------------------------------------------
// 1. Empty states — the shared EmptyState primitive, one page per row (UX-038)
// ---------------------------------------------------------------------------

interface EmptyCase {
  path: string
  /** The primary GET to stub with a zero-data body so the EmptyState renders. */
  route: string
  body: string
  title: string
  /** A quote-free substring of the muted description (avoids typographic-quote flake). */
  copy: RegExp
  /** The button label when the page renders a CTA INSIDE the EmptyState (only Jars does). */
  cta?: string
  /** Catalog id(s) this row automates. */
  ids: string
}

const EMPTY_CASES: EmptyCase[] = [
  {
    path: '/accounts',
    route: '**/api/accounts',
    body: '[]',
    title: 'No accounts yet',
    copy: /tag transactions to it/,
    ids: 'UX-038, ACCT-003',
  },
  {
    path: '/transactions',
    route: '**/api/transactions',
    body: '[]',
    title: 'No transactions yet',
    copy: /Import a bank statement/,
    ids: 'UX-038, TXN empty',
  },
  {
    path: '/jars',
    route: '**/api/jars',
    body: '[]',
    title: 'No jars yet',
    copy: /Start from one of these/,
    cta: 'New jar', // JarsPage is the one page whose EmptyState carries in-card CTAs (examples + New jar).
    ids: 'UX-038, JAR-001',
  },
  {
    path: '/reports',
    route: '**/api/reports/trends**', // the GET carries ?months=6, so match with a trailing **
    body: JSON.stringify({ points: [], totalIncome: 0, totalIncomeReceived: 0, totalSpent: 0 }),
    title: 'No budget data yet',
    copy: /your trends will appear here/,
    ids: 'UX-038, RPT empty',
  },
  {
    path: '/people',
    route: '**/api/members?**', // the list GET carries ?year=&month= (rule 29), so match with a trailing **
    body: '[]',
    title: 'Budgeting on your own?',
    copy: /split shared costs/,
    ids: 'UX-038, PPL solo',
  },
]

test.describe('empty states — shared EmptyState primitive (UX-038)', () => {
  for (const c of EMPTY_CASES) {
    test(`${c.path} renders the EmptyState: icon + title + copy${c.cta ? ' + CTA' : ''} (${c.ids})`, async ({
      page,
    }) => {
      await authedSetup(page, 'light')
      // Override the catch-all for this page's primary GET with a zero-data body.
      await page.route(c.route, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: c.body }),
      )
      await page.goto(c.path)
      await page.getByRole('heading', { level: 1 }).first().waitFor()

      // The dashed-border card is the shared EmptyState; scope to it via its title so
      // any unrelated border-dashed control can't be mistaken for it.
      const card = page
        .locator('div.border-dashed')
        .filter({ has: page.getByText(c.title, { exact: true }) })
      await expect(card).toBeVisible()

      // Icon medallion — an inline-SVG glyph inside the rounded bg-slate-100 disc.
      await expect(card.locator('div.rounded-full svg').first()).toBeVisible()
      // Semibold title.
      await expect(card.locator('p.font-semibold', { hasText: c.title })).toBeVisible()
      // Muted supporting copy.
      await expect(card.getByText(c.copy)).toBeVisible()

      // Only Jars puts its CTA in the EmptyState's children slot; when present it must
      // be a real, enabled button inside the card.
      if (c.cta) {
        await expect(card.getByRole('button', { name: c.cta })).toBeEnabled()
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Loading states — placeholder shows before content, never a wrong flash (UX-041)
// ---------------------------------------------------------------------------

interface LoadingCase {
  path: string
  /** The primary GET to hold open (gated) so the loading placeholder is observable. */
  route: string
  /** A locator for real page content that appears only AFTER the fetch resolves. */
  content: (page: Page) => Locator
  ids: string
}

const LOADING_CASES: LoadingCase[] = [
  {
    path: '/accounts',
    route: '**/api/accounts',
    content: (p) => p.getByRole('heading', { name: 'Your accounts' }),
    ids: 'UX-041, ACCT-004',
  },
  {
    path: '/transactions',
    route: '**/api/transactions',
    content: (p) => p.getByRole('table'),
    ids: 'UX-041',
  },
  {
    path: '/jars',
    route: '**/api/jars',
    content: (p) => p.getByRole('heading', { name: 'Your jars' }),
    ids: 'UX-041, JAR-003',
  },
  {
    path: '/reports',
    route: '**/api/reports/trends**',
    content: (p) => p.getByRole('heading', { name: 'Income vs spending' }),
    ids: 'UX-041',
  },
  {
    path: '/people',
    route: '**/api/members?**', // the list GET carries ?year=&month= (rule 29), so match with a trailing **
    content: (p) => p.getByRole('heading', { name: 'Your household' }),
    ids: 'UX-041',
  },
]

test.describe('loading states — placeholder then content (UX-041)', () => {
  for (const c of LOADING_CASES) {
    test(`${c.path} shows the loading placeholder before content (${c.ids})`, async ({ page }) => {
      await authedSetup(page, 'light')

      // Gate the primary GET: hold it open until we release it, then fall back to the
      // catch-all so the real happy fixture is what renders (no fixture duplicated).
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      await page.route(c.route, async (route) => {
        await gate
        await route.fallback()
      })

      await page.goto(c.path) // resolves on document load; the data XHR stays pending

      // The page's loading placeholder (<p class="text-slate-500">Loading…/Loading your
      // reports…</p>) is up while the fetch is in flight, and no content/empty/error yet.
      const loading = page.locator('p.text-slate-500').filter({ hasText: 'Loading' })
      await expect(loading).toBeVisible()
      await expect(c.content(page)).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)

      // Release the response → content swaps in and the placeholder clears.
      release()
      await expect(c.content(page)).toBeVisible()
      await expect(loading).toHaveCount(0)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Error handling — role="alert" load strip; the page stays usable (UX-043/UX-021)
// ---------------------------------------------------------------------------

interface ErrorCase {
  path: string
  /** The primary GET to fail (500) so the page's load-error path fires. */
  route: string
  /** The exact ErrorBanner copy for this page. */
  copy: RegExp
  /** A primary action the page still renders after the failure (proof it's usable). */
  action?: string
  ids: string
}

const ERROR_CASES: ErrorCase[] = [
  {
    path: '/accounts',
    route: '**/api/accounts',
    copy: /Could not load your accounts\./,
    action: 'Add account',
    ids: 'UX-043, UX-021, ACCT-004',
  },
  {
    path: '/transactions',
    route: '**/api/transactions',
    copy: /Could not load transactions\./,
    action: 'Add transaction',
    ids: 'UX-043, UX-021',
  },
  {
    path: '/jars',
    route: '**/api/jars',
    copy: /Could not load your jars\./,
    action: 'New jar',
    ids: 'UX-043, UX-021, JAR-004',
  },
  {
    // /reports shows ONLY the alert on failure (no hero, no empty), so usability is
    // proven by the intact shell rather than a page action. NB: responsive-dark.spec
    // asserts this banner's DARK-mode contrast; here it's the light-mode usability
    // contract — different case, no overlap.
    path: '/reports',
    route: '**/api/reports/trends**',
    copy: /Could not load your reports\./,
    ids: 'UX-043, UX-021',
  },
  {
    path: '/people',
    route: '**/api/members?**', // the list GET carries ?year=&month= (rule 29), so match with a trailing **
    copy: /Could not load your household\./,
    action: 'Add person',
    ids: 'UX-043, UX-021',
  },
]

test.describe('error handling — role="alert" load strip stays usable (UX-043, UX-021)', () => {
  for (const c of ERROR_CASES) {
    test(`${c.path} surfaces a role="alert" load error and stays usable (${c.ids})`, async ({
      page,
    }) => {
      await authedSetup(page, 'light')
      await page.route(c.route, (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      )
      await page.goto(c.path)

      // The shared ErrorBanner announces immediately (role="alert") with the page copy.
      const alert = page.getByRole('alert')
      await expect(alert).toBeVisible()
      await expect(alert).toHaveText(c.copy)

      // The page stays usable — the AppShell is intact (single h1 + Primary nav), so no
      // white-screen or half-render, and the primary action (where the page has one) is
      // still rendered and enabled despite the failed fetch.
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
      if (c.action) {
        await expect(page.getByRole('button', { name: c.action })).toBeEnabled()
      }
    })
  }
})
