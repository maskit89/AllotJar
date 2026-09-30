import { expect, test, type Locator } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * Responsive (375 px) + dark-mode cross-feature sweep — the slices of
 * docs/testing/cases/26-ux-states.md that the existing e2e specs don't already
 * cover:
 *
 *  - a11y.spec.ts runs the axe WCAG scan (light + dark) on every route;
 *  - mobile-layout.spec.ts asserts the *document* never scrolls sideways at 375 px;
 *  - keyboard-a11y.spec.ts covers focus/keyboard/ARIA structure.
 *
 * This file adds the two things those leave open:
 *
 *  1. Responsive containment (UX-031/032/033): at 375 px the DATA-HEAVY surfaces
 *     don't just avoid page overflow — the *inner container* is the horizontal
 *     scroller (a fixed-min-width table is wider than its wrapper, the wrapper is
 *     the `overflow-x-auto` scroll box, and the page stays put). The budget grid
 *     instead reflows (no inner scroller), which we assert as its own contract.
 *  2. Token-level dark inversion (UX-021/024/025/026/038/040): toggling to dark
 *     stamps the root, flips the slate ramp on a known-slate surface, keeps accent
 *     tints AA-legible via their `dark:` variants, and renders the shared
 *     ErrorBanner (role="alert") + EmptyState primitives correctly on dark.
 *
 * Everything is asserted structurally / from computed colour (canvas-resolved so
 * oklch or rgba both work) rather than by re-running axe, and is deterministic
 * (locator/expect-polling, no arbitrary sleeps). Stubbing + theme patterns are
 * reused from mocks.ts exactly as the sibling specs use them.
 */

// ---------------------------------------------------------------------------
// Colour helpers (WCAG relative luminance + contrast), computed in Node from
// canvas-resolved rgb triples so any CSS colour syntax normalises cleanly.
// ---------------------------------------------------------------------------

type RGB = { r: number; g: number; b: number }

const luminance = ({ r, g, b }: RGB) => {
  const chan = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

const contrast = (a: RGB, b: RGB) => {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/**
 * Sample an element's computed text colour, its own background, and its
 * *effective* background (the translucent bg-chain composited down onto the
 * first opaque ancestor / the body). Colours are resolved via a 1×1 canvas so
 * oklch, named, rgb and rgba all come back as concrete rgba pixels — robust to
 * however the browser serialises the design tokens.
 */
async function sample(el: Locator): Promise<{ color: RGB; ownBg: RGB; effBg: RGB }> {
  return el.evaluate((node: HTMLElement) => {
    const resolve = (s: string) => {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      const x = c.getContext('2d')!
      x.clearRect(0, 0, 1, 1)
      x.fillStyle = '#000'
      x.fillStyle = s // invalid → keeps #000; 'rgba(0,0,0,0)' → a=0 (transparent)
      x.fillRect(0, 0, 1, 1)
      const d = x.getImageData(0, 0, 1, 1).data
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }
    }
    const cs = getComputedStyle(node)
    const color = resolve(cs.color)
    const ownBg = resolve(cs.backgroundColor)

    // Composite the background chain up to the first opaque layer.
    const layers: { r: number; g: number; b: number; a: number }[] = []
    let cur: HTMLElement | null = node
    while (cur) {
      const bg = resolve(getComputedStyle(cur).backgroundColor)
      if (bg.a > 0.001) {
        layers.push(bg)
        if (bg.a >= 0.999) break
      }
      cur = cur.parentElement
    }
    if (layers.length === 0 || layers[layers.length - 1].a < 0.999) {
      layers.push({ r: 255, g: 255, b: 255, a: 1 })
    }
    let out = layers[layers.length - 1]
    for (let i = layers.length - 2; i >= 0; i--) {
      const s = layers[i]
      out = {
        r: s.a * s.r + (1 - s.a) * out.r,
        g: s.a * s.g + (1 - s.a) * out.g,
        b: s.a * s.b + (1 - s.a) * out.b,
        a: 1,
      }
    }
    const round = (v: number) => Math.round(v)
    return {
      color: { r: round(color.r), g: round(color.g), b: round(color.b) },
      ownBg: { r: round(ownBg.r), g: round(ownBg.g), b: round(ownBg.b) },
      effBg: { r: round(out.r), g: round(out.g), b: round(out.b) },
    }
  })
}

// ---------------------------------------------------------------------------
// Responsive — data-heavy surfaces scroll INSIDE their own container (375 px)
// ---------------------------------------------------------------------------

test.describe('responsive — data tables scroll inside their own container (375px)', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  /**
   * Measure a table and the nearest ancestor that is actually a horizontal
   * scroll container (computed overflow-x auto/scroll), plus the document.
   */
  async function metrics(table: Locator) {
    return table.evaluate((tableEl: HTMLElement) => {
      let c: HTMLElement | null = tableEl.parentElement
      while (c && !/(auto|scroll)/.test(getComputedStyle(c).overflowX)) c = c.parentElement
      const de = document.documentElement
      return {
        found: !!c,
        overflowX: c ? getComputedStyle(c).overflowX : null,
        containerScrollW: c ? c.scrollWidth : 0,
        containerClientW: c ? c.clientWidth : 0,
        containerOffsetW: c ? c.offsetWidth : 0,
        tableOffsetW: tableEl.offsetWidth,
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
      }
    })
  }

  /**
   * The shared containment contract: the page never scrolls sideways, the wide
   * content lives in a real overflow-x scroll box, and that box fits the screen
   * (so it — not the document — absorbs the width). `mustOverflow` additionally
   * proves the box is genuinely scrolling internally (content wider than box).
   */
  async function expectInnerScroller(table: Locator, label: string, mustOverflow: boolean) {
    const m = await metrics(table)
    expect(m.found, `${label}: no overflow-x scroll container wraps the table`).toBe(true)
    expect(['auto', 'scroll'], `${label}: wrapper overflow-x`).toContain(m.overflowX)
    // Page-level: the document does not scroll horizontally (UX-031).
    expect(m.pageScrollW, `${label}: document overflows the viewport`).toBeLessThanOrEqual(
      m.pageClientW + 1,
    )
    // The scroll box itself fits the screen, so it (not the page) is the clip.
    expect(m.containerOffsetW, `${label}: scroll box wider than the viewport`).toBeLessThanOrEqual(
      m.viewportW + 1,
    )
    if (mustOverflow) {
      // The table is wider than its box and the box scrolls internally — proof
      // the inner container, not the page, is the scroller.
      expect(m.tableOffsetW, `${label}: table not wider than its box`).toBeGreaterThan(
        m.containerClientW,
      )
      expect(m.containerScrollW, `${label}: box does not scroll internally`).toBeGreaterThan(
        m.containerClientW,
      )
    }
  }

  // UX-031 — the transactions register (min-w-[720px]) scrolls inside its own
  // overflow-x-auto box; the page never scrolls sideways at 375 px.
  test('the transactions register scrolls inside its own container (UX-031)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/transactions')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    const table = page.getByRole('table')
    await table.waitFor()
    await expectInnerScroller(table, '/transactions register', true)
  })

  // UX-031 — the People "Your household" table (min-w-[820px]) scrolls inside its
  // own overflow-x-auto box.
  test('the people household table scrolls inside its own container (UX-031)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/people')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    // /people also renders an "Other sign-ins" table; the household table is the
    // one with the "Share" column.
    const table = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Share' }) })
    await table.waitFor()
    // Alex's spending comes from the /members/spending/{y}/{m} mock, so the sweep sees real figures.
    await expect(table).toContainText('1,234.00')
    await expectInnerScroller(table, '/people household table', true)
  })

  // UX-033 — BOTH import tables (the generic-CSV sample/mapping preview and the
  // review grid) are wrapped in overflow-x-auto boxes and scroll internally; the
  // page stays put. The sample table (3 short columns) may fit the phone, so it is
  // asserted structurally (soft); the review grid carries per-row selects and is
  // asserted as a genuine internal scroller.
  test('the import mapping + review tables scroll inside their own containers (UX-033)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    await page.goto('/import')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    // Reach both tables via the proven upload flow (mirrors a11y.spec.ts).
    await page.getByLabel(/Add to account/).selectOption('acc0')
    await page.getByLabel('Statement file').setInputFiles({
      name: 'tx.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
    })
    await page.getByRole('button', { name: 'Review transactions' }).click()

    const sample = page.getByRole('table', { name: 'Sample of the uploaded file' })
    const review = page.getByRole('table', { name: 'Transactions to import' })
    await sample.waitFor()
    await review.waitFor()

    await expectInnerScroller(sample, '/import mapping sample table', false)
    await expectInnerScroller(review, '/import review grid', true)
  })

  // UX-031 — the /accounts jar-reconciliation table is wrapped in its own
  // overflow-x-auto box (soft: four columns may fit the phone, but the box, not
  // the page, is the designated scroller).
  test('the accounts reconciliation table scrolls inside its own container (UX-031)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    const table = page.getByRole('table')
    await table.waitFor()
    await expectInnerScroller(table, '/accounts reconciliation table', false)
  })

  // UX-036 — the account-detail register at /accounts/:id (a parameterized route
  // NOT in AUTHED_ROUTES, so the per-route sweeps never visit it). The fixture's
  // 'acc0' account carries every mocked transaction, so the register renders a
  // populated table (min-w-[520px]) that must scroll inside its own
  // overflow-x-auto box while the document never scrolls sideways at 375 px.
  test('the account-detail register scrolls inside its own container (UX-036)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts/acc0')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    // The register rendered real rows (not the empty state) — the table's width
    // pressure comes from actual content.
    await page.getByText('Welbees Supermarket').waitFor()
    const table = page.getByRole('table')
    await table.waitFor()
    await expectInnerScroller(table, '/accounts/acc0 register', true)
  })

  // UX-032 — the budget grid does NOT use an overflow-x scroller; its rows reflow
  // (name column min-w-0 flex-1, amount column shrink-0 min-w-[118px]). The UX-032
  // guarantee therefore holds via reflow: the DATA columns fit their allocated
  // width with no internal spill (the "columns collide / icons spill" bug class),
  // and the page never scrolls sideways. The reorder arrows / delete ✕ are
  // `position:absolute` in the card's gutter (deliberately outside the flow), so
  // they're excluded — this checks the flowing data, the non-duplicative
  // complement to mobile-layout.spec's document-level check.
  test('the budget grid data columns reflow without collision (UX-032)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const planned = page.getByRole('button', { name: 'Planned amount for Rent' })
    await planned.waitFor()
    const m = await planned.evaluate((btn: HTMLElement) => {
      const row = btn.closest('.group') as HTMLElement | null
      const cols = row
        ? Array.from(row.children).filter(
            (k) => getComputedStyle(k as HTMLElement).position !== 'absolute',
          )
        : []
      const overflowing = cols
        .map((k) => ({
          cls: (k as HTMLElement).className.toString().slice(0, 24),
          spill: (k as HTMLElement).scrollWidth - (k as HTMLElement).clientWidth,
        }))
        .filter((c) => c.spill > 1)
      const de = document.documentElement
      return {
        hasRow: !!row,
        colCount: cols.length,
        overflowing,
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
      }
    })
    expect(m.hasRow, 'budget row wrapper not found for the Rent line').toBe(true)
    expect(m.colCount, 'no in-flow budget data columns found').toBeGreaterThan(0)
    // Each flowing data column fits its allocated width — nothing spills/collides...
    expect(m.overflowing, 'budget data columns overflow/collide').toEqual([])
    // ...and the document itself does not gain a horizontal scrollbar.
    expect(m.pageScrollW, '/ document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
  })
})

// ---------------------------------------------------------------------------
// Dark mode — token-level inversion + shared primitives (desktop viewport)
// ---------------------------------------------------------------------------

test.describe('dark mode — token inversion + primitives', () => {
  const themeGroup = (page: import('@playwright/test').Page) =>
    page.getByRole('group', { name: 'Theme' })

  // UX-024 — toggling to Dark stamps `.dark` on the root and inverts the slate
  // ramp app-wide: a known bg-slate-50 surface (the reconciliation header, which
  // carries NO dark: override) flips from near-white to near-black purely via the
  // remapped ramp. Driven with the real ThemeToggle so the "stamp the root" step
  // is the live toggle, not a preloaded class.
  test('toggling to dark stamps the root and inverts the slate ramp (UX-024)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const slateSurface = page
      .locator('div.bg-slate-50')
      .filter({ has: page.getByRole('heading', { name: 'Jar reconciliation' }) })
    await slateSurface.waitFor()

    // Light: root is not dark, the slate-50 surface is near-white.
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    const lightBg = (await sample(slateSurface)).ownBg
    expect(luminance(lightBg), 'bg-slate-50 should be near-white in light').toBeGreaterThan(0.5)

    // Toggle → the root gains .dark and the SAME surface inverts to near-black.
    await themeGroup(page).getByRole('button', { name: 'Dark mode' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect
      .poll(async () => luminance((await sample(slateSurface)).ownBg))
      .toBeLessThan(0.15)
  })

  // UX-025 — the import mapping/sample table flips to dark using ONLY the remapped
  // slate ramp (the ImportPage comment: no dark: overrides on the preview table).
  // The header row (bg-slate-50) must render dark and the cells (text-slate-600)
  // must stay legible — no light-on-light and no double-inverted wash-out.
  test('the import mapping table flips to dark via the remapped ramp (UX-025)', async ({ page }) => {
    await authedSetup(page, 'dark')
    await page.goto('/import')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    await page.getByLabel(/Add to account/).selectOption('acc0')
    await page.getByLabel('Statement file').setInputFiles({
      name: 'tx.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
    })
    await page.getByRole('button', { name: 'Review transactions' }).click()

    const sampleTable = page.getByRole('table', { name: 'Sample of the uploaded file' })
    await sampleTable.waitFor()
    await expect(page.locator('html')).toHaveClass(/dark/)

    // Header row bg-slate-50 → dark (ramp inverted, not washed out to a light grey).
    const header = await sample(sampleTable.locator('thead tr'))
    expect(luminance(header.effBg), 'mapping header did not invert to dark').toBeLessThan(0.2)

    // Cell text stays AA-legible against its dark background.
    const cell = await sample(sampleTable.locator('tbody td').first())
    expect(contrast(cell.color, cell.effBg), 'mapping cell text illegible in dark').toBeGreaterThanOrEqual(
      4.5,
    )
  })

  // UX-026 — accent-on-tint surfaces (which don't ride the slate ramp) carry paired
  // dark: variants. The active sidebar nav link flips from a dark brand text in
  // light to the brightened brand-200 in dark, and stays AA-legible on its tint.
  test('accent tints keep their dark variant and stay AA-legible (UX-026)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const active = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Accounts' })
    await expect(active).toHaveAttribute('aria-current', 'page')

    // Light: the accent text is a dark brand tone.
    const lightColor = (await sample(active)).color
    expect(luminance(lightColor), 'active-nav accent should be dark in light').toBeLessThan(0.3)

    // Dark: the dark: variant brightens the accent text and it clears AA on its tint.
    await themeGroup(page).getByRole('button', { name: 'Dark mode' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect.poll(async () => luminance((await sample(active)).color)).toBeGreaterThan(0.4)
    const dark = await sample(active)
    expect(contrast(dark.color, dark.effBg), 'active-nav accent illegible in dark').toBeGreaterThanOrEqual(
      4.5,
    )
  })

  // UX-021 — a user-visible error uses the shared ErrorBanner (role="alert") and its
  // rose tint has explicit dark: variants so it stays legible on a dark surface. We
  // force the /reports GET to fail and assert the banner is a dark-legible alert.
  test('ErrorBanner (role="alert") is a dark-legible rose card (UX-021)', async ({ page }) => {
    await authedSetup(page, 'dark')
    // Registered after authedSetup's catch-all, so it wins for this route.
    await page.route('**/api/reports/trends**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    )
    await page.goto('/reports')

    const banner = page.getByRole('alert')
    await banner.waitFor()
    await expect(banner).toHaveText(/Could not load your reports\./)
    await expect(page.locator('html')).toHaveClass(/dark/)

    const s = await sample(banner)
    // The rose tint sits dark on the dark surface (not a light-mode rose-50 card)...
    expect(luminance(s.effBg), 'ErrorBanner background not dark-tuned').toBeLessThan(0.25)
    // ...and the rose text clears AA against it.
    expect(contrast(s.color, s.effBg), 'ErrorBanner text illegible in dark').toBeGreaterThanOrEqual(4.5)
  })

  // UX-038 / UX-040 — the shared EmptyState primitive is theme-aware: its bg-surface
  // card and slate-ramp border/text invert cleanly in dark and the copy stays
  // legible. Emptying the transactions fixture renders the canonical EmptyState.
  test('EmptyState renders theme-aware and legible in dark (UX-038, UX-040)', async ({ page }) => {
    await authedSetup(page, 'dark')
    await page.route('**/api/transactions', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
    await page.goto('/transactions')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const title = page.getByText('No transactions yet')
    await title.waitFor()
    const card = page.locator('div.border-dashed').filter({ has: title })
    await expect(card).toHaveClass(/border-dashed/) // rides the slate ramp, no dark: override
    await expect(page.locator('html')).toHaveClass(/dark/)

    // The bg-surface card flips to the dark surface...
    const cardBg = (await sample(card)).effBg
    expect(luminance(cardBg), 'EmptyState surface not dark').toBeLessThan(0.2)
    // ...and the title copy stays AA-legible on it.
    const t = await sample(title)
    expect(contrast(t.color, cardBg), 'EmptyState title illegible in dark').toBeGreaterThanOrEqual(4.5)
  })
})
