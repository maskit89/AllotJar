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

  // UX-031 — the transactions list (restyle PR 5) has no wide table any more: on a phone each row
  // is two lines that truncate, so the list card fits the screen with nothing scrolling sideways,
  // neither the page nor the card nor a row.
  test('the transactions list fits a phone with no sideways scroll (UX-031)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/transactions')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    const list = page.getByRole('region', { name: 'Transactions' })
    await list.waitFor()
    await expect(list.getByTestId('tx-row').first()).toBeVisible()
    const m = await list.evaluate((card: HTMLElement) => {
      const de = document.documentElement
      const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-testid="tx-row"]'))
      return {
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
        cardRight: card.getBoundingClientRect().right,
        cardScrollW: card.scrollWidth,
        cardClientW: card.clientWidth,
        rows: rows.length,
        // What shows of a row (its elements; a chip's invisible ::after hit area may reach past it,
        // which the card's own scroll width above still guards).
        contentPastRow: rows.flatMap((r) => {
          const right = r.getBoundingClientRect().right
          return Array.from(r.querySelectorAll<HTMLElement>('*')).filter((el) => el.getBoundingClientRect().right > right + 1)
        }).length,
        rowsPastCard: rows.filter((r) => r.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).length,
      }
    })
    expect(m.rows, 'the mocked rows render').toBeGreaterThan(5)
    expect(m.pageScrollW, 'document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
    expect(m.cardRight, 'list card wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.cardScrollW, 'list card scrolls sideways').toBeLessThanOrEqual(m.cardClientW + 1)
    expect(m.contentPastRow, 'a row\'s content runs past the row').toBe(0)
    expect(m.rowsPastCard, 'a row runs past the card').toBe(0)
  })

  // UX-031 — the People page (restyle PR 8) has no wide household table any more: each person is a
  // card, full width on a phone, whose name wraps and whose three figures share the card's
  // width, so nothing scrolls sideways: neither the page, nor the list, nor a card.
  test('the people cards fit a phone with no sideways scroll (UX-031)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/people')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    const list = page.getByRole('region', { name: 'Your household' })
    const alex = list.getByRole('article', { name: 'Alex', exact: true })
    // Alex's spending comes from the /members/spending/{y}/{m} mock, so the sweep sees real figures.
    await expect(alex).toContainText('1,234.00')
    const m = await list.evaluate((region: HTMLElement) => {
      const de = document.documentElement
      const cards = Array.from(region.querySelectorAll<HTMLElement>('article'))
      return {
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
        regionRight: region.getBoundingClientRect().right,
        cards: cards.length,
        cardsPastViewport: cards.filter((c) => c.getBoundingClientRect().right > window.innerWidth + 1).length,
        cardsScrolling: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
        // What shows of a card (its elements; an (i)'s invisible ::after hit area may reach past
        // it, which the card's own scroll width above still guards).
        contentPastCard: cards.flatMap((c) => {
          const right = c.getBoundingClientRect().right
          return Array.from(c.querySelectorAll<HTMLElement>('*')).filter((el) => el.getBoundingClientRect().right > right + 1)
        }).length,
      }
    })
    expect(m.cards, 'the mocked people render').toBe(2)
    expect(m.pageScrollW, 'document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
    expect(m.regionRight, 'the cards are wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.cardsPastViewport, 'a card runs past the viewport').toBe(0)
    expect(m.cardsScrolling, 'a card scrolls sideways').toBe(0)
    expect(m.contentPastCard, 'a card\'s content runs past the card').toBe(0)
  })

  // UX-033 — the import review (restyle PR 14) has no wide grid any more: it is one list card
  // whose rows are two lines on a phone (the payee and its chips truncate, the amount sits at the
  // end), so nothing scrolls sideways: neither the page, nor the card, nor a row. The one table
  // left, the sample of the uploaded file, sits in the Columns dialog in its own overflow-x box
  // (3 short columns, which may fit the phone, so it is asserted structurally).
  test('the import review list fits a phone with no sideways scroll, and the sample table scrolls in its own box (UX-033)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    await page.goto('/import')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    // The format (i)'s popover opens under its icon, inside the phone's screen.
    await page.getByRole('button', { name: 'About file formats' }).focus()
    const formatHint = page.getByRole('tooltip')
    await formatHint.waitFor()
    const placed = await formatHint.evaluate((el) => {
      const t = el.getBoundingClientRect()
      const b = document.querySelector('button[aria-label="About file formats"]')!.getBoundingClientRect()
      return {
        inside: t.left >= 0 && t.top >= 0 && t.right <= window.innerWidth && t.bottom <= window.innerHeight,
        dx: Math.abs(t.left + t.width / 2 - (b.left + b.width / 2)),
        gap: Math.min(Math.abs(t.top - b.bottom), Math.abs(b.top - t.bottom)),
      }
    })
    expect(placed.inside, 'the format hint runs off the screen').toBe(true)
    expect(placed.dx, 'the format hint is not centred under its (i)').toBeLessThan(24)
    expect(placed.gap, 'the format hint sits away from its (i)').toBeLessThan(12)
    await page.keyboard.press('Escape')
    await expect(formatHint).toBeHidden()

    // Reach the review via the proven upload flow (mirrors a11y.spec.ts).
    await page.getByLabel(/Add to account/).selectOption('acc0')
    await page.getByLabel('Statement file').setInputFiles({
      name: 'tx.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('19/06/2026,SHOP,-5.00'),
    })
    await page.getByRole('button', { name: 'Review transactions' }).click()

    const list = page.getByRole('region', { name: 'Transactions to import' })
    await list.waitFor()
    await expect(list.getByTestId('import-row').first()).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    const m = await list.evaluate((card: HTMLElement) => {
      const de = document.documentElement
      const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-testid="import-row"]'))
      return {
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
        cardRight: card.getBoundingClientRect().right,
        cardScrollW: card.scrollWidth,
        cardClientW: card.clientWidth,
        rows: rows.length,
        // What shows of a row (its elements; a chip's or an (i)'s invisible ::after hit area may
        // reach past it, which the card's own scroll width above still guards).
        contentPastRow: rows.flatMap((r) => {
          const right = r.getBoundingClientRect().right
          return Array.from(r.querySelectorAll<HTMLElement>('*')).filter((el) => el.getBoundingClientRect().right > right + 1)
        }).length,
        rowsPastCard: rows.filter((r) => r.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).length,
      }
    })
    expect(m.rows, 'the mocked rows render').toBe(4)
    expect(m.pageScrollW, 'document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
    expect(m.cardRight, 'list card wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.cardScrollW, 'list card scrolls sideways').toBeLessThanOrEqual(m.cardClientW + 1)
    expect(m.contentPastRow, 'a row\'s content runs past the row').toBe(0)
    expect(m.rowsPastCard, 'a row runs past the card').toBe(0)

    // A tap on a row's include box ticks it: the box sits above the payee button's full-row overlay (which
    // opens the row's sheet), so the tap lands on the input and opens nothing.
    const box = page.getByLabel('Include WOLT on 2026-06-15')
    await expect(box).toBeChecked()
    const at = (await box.boundingBox())!
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    await expect(box).not.toBeChecked()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    await expect(box).toBeChecked()
    // A flag that would not fit beside its payee drops under it, instead of squeezing the payee to a letter.
    const payee = list.getByRole('button', { name: 'SEPA RETURN', exact: true })
    const flag = list.getByText('Looks like a transfer coming back')
    expect(await payee.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the payee is cut short beside its flag').toBe(true)
    const [p, f] = [(await payee.boundingBox())!, (await flag.boundingBox())!]
    expect(f.y, 'the flag did not drop under the payee').toBeGreaterThanOrEqual(p.y + p.height - 2)

    // The sample table, in the Columns sheet.
    await page.getByRole('button', { name: 'Columns' }).click()
    const sample = page.getByRole('dialog', { name: 'Columns' }).getByRole('table', { name: 'Sample of the uploaded file' })
    await sample.waitFor()
    await expectInnerScroller(sample, '/import mapping sample table', false)
  })

  // UX-031 — the accounts list (restyle PR 6) has no jar-reconciliation table any more: what the
  // jars hold of an account is on its card (the jar bar and its caption). On a phone the cards are
  // rows of one list card, each name truncates and the chips and the jar bar take lines of their
  // own, so nothing scrolls sideways: neither the page, nor the list card, nor a row.
  test('the accounts list fits a phone with no sideways scroll (UX-031)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    const list = page.getByRole('region', { name: 'Your accounts', exact: true })
    await list.waitFor()
    await expect(list.getByRole('article').first()).toBeVisible()
    // The account that holds jars shows them on its row.
    await expect(list.getByTestId('account-jars').first()).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    const m = await list.evaluate((section: HTMLElement) => {
      const de = document.documentElement
      const rows = Array.from(section.querySelectorAll<HTMLElement>('article[data-account-id]'))
      const card = rows[0]?.parentElement ?? section
      return {
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
        cardRight: card.getBoundingClientRect().right,
        cardScrollW: card.scrollWidth,
        cardClientW: card.clientWidth,
        rows: rows.length,
        // What shows of a row (its elements; the name link's ::after hit area and a hint's
        // invisible ::after are pseudo-elements, which the card's own scroll width still guards).
        // The ⋯ alone hangs into the card's side padding, as in the mock-up, so its dots line up
        // with the balance's edge: it is checked against the card's padding box below.
        contentPastRow: rows.flatMap((r) => {
          const right = r.getBoundingClientRect().right
          return Array.from(r.querySelectorAll<HTMLElement>('*')).filter(
            (el) => !el.closest('[data-row-trigger]') && !el.querySelector('[data-row-trigger]') && el.getBoundingClientRect().right > right + 1,
          )
        }).length,
        triggersPastCard: rows.filter((r) => {
          const t = r.querySelector<HTMLElement>('[data-row-trigger]')
          const inner = card.getBoundingClientRect().left + card.clientLeft + card.clientWidth
          return !t || t.getBoundingClientRect().right > inner - 4
        }).length,
        rowsPastCard: rows.filter((r) => r.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).length,
      }
    })
    expect(m.rows, 'the mocked accounts render').toBeGreaterThanOrEqual(2)
    expect(m.pageScrollW, 'document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
    expect(m.cardRight, 'list card wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.cardScrollW, 'list card scrolls sideways').toBeLessThanOrEqual(m.cardClientW + 1)
    expect(m.contentPastRow, "a row's content runs past the row").toBe(0)
    expect(m.triggersPastCard, "a row's ⋯ is missing or reaches the card's edge").toBe(0)
    expect(m.rowsPastCard, 'a row runs past the card').toBe(0)
  })

  // UX-036 — the account-detail register at /accounts/:id (a parameterized route NOT in
  // AUTHED_ROUTES, so the per-route sweeps never visit it). The fixture's 'acc0' account carries
  // every mocked transaction. Since the restyle (PR 11) the register is a list like Transactions,
  // not a wide table: on a phone each row is two lines that truncate, so neither the page, nor the
  // Transactions card, nor a row scrolls sideways, and the Account details card follows the list.
  test('the account-detail register fits a phone with no sideways scroll (UX-036)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts/acc0')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    // The register rendered real rows (not the empty state): the width pressure comes from
    // actual content.
    await page.getByText('Welbees Supermarket').waitFor()
    await expect(page.getByText('Welbees Supermarket')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    const list = page.getByRole('region', { name: /^Transactions/ })
    const details = page.getByRole('region', { name: 'Account details' })
    await expect(list.getByTestId('tx-row').first()).toBeVisible()
    await expect(details).toBeVisible()
    const detailsEl = await details.elementHandle()
    const m = await list.evaluate((card: HTMLElement, details) => {
      const de = document.documentElement
      const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-testid="tx-row"]'))
      return {
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        viewportW: window.innerWidth,
        cardRight: card.getBoundingClientRect().right,
        cardScrollW: card.scrollWidth,
        cardClientW: card.clientWidth,
        rows: rows.length,
        // What shows of a row (its elements; an (i)'s invisible ::after hit area may reach past
        // it, which the card's own scroll width above still guards).
        contentPastRow: rows.flatMap((r) => {
          const right = r.getBoundingClientRect().right
          return Array.from(r.querySelectorAll<HTMLElement>('*')).filter((el) => el.getBoundingClientRect().right > right + 1)
        }).length,
        rowsPastCard: rows.filter((r) => r.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).length,
        detailsRight: details?.getBoundingClientRect().right ?? 0,
        // On a phone the list comes first and the details card after it.
        detailsBelowList: !!details && details.getBoundingClientRect().top >= card.getBoundingClientRect().bottom,
      }
    }, detailsEl)
    expect(m.rows, 'the mocked rows render').toBeGreaterThan(5)
    expect(m.pageScrollW, 'document overflows the viewport').toBeLessThanOrEqual(m.pageClientW + 1)
    expect(m.cardRight, 'list card wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.cardScrollW, 'list card scrolls sideways').toBeLessThanOrEqual(m.cardClientW + 1)
    expect(m.contentPastRow, "a row's content runs past the row").toBe(0)
    expect(m.rowsPastCard, 'a row runs past the card').toBe(0)
    expect(m.detailsRight, 'details card wider than the viewport').toBeLessThanOrEqual(m.viewportW + 1)
    expect(m.detailsBelowList, 'the details card follows the list').toBe(true)
  })

  // UX-036 at the reflow width (320 px, WCAG 1.4.10) and at 360 px: on an account kept in another
  // currency every row has its "Counts as … in the budget" line under the amount, which wraps in a
  // capped width there; a row waiting for its euro amount has the "Needs EUR amount" tag and its (i)
  // under the amount, or on the row's second line below 360 px. So the payee and the category chip
  // beside them keep their room: no chip is cut to its dot, nothing of the middle column runs under
  // the amount, and the page never scrolls sideways.
  test('the account-detail rows keep their category readable beside long amount lines at 320 and 360 px (UX-036)', async ({
    page,
  }) => {
    await authedSetup(page, 'light')
    const gb = { id: 'gb', name: 'UK current', type: 0, currency: 'GBP', openingBalance: 500, currentBalance: 420, displayOrder: 2 }
    const row = { bankReference: null, transferAccountId: null, transferAccountName: null, memberId: null, memberName: null, type: 0, accountId: 'gb', accountName: 'UK current', isSplit: false, splits: [] }
    const rows = [
      { ...row, id: 'g1', date: '2026-06-20', payee: 'Tesco Express', amount: 23.4, currency: 'GBP', budgetAmount: 27.15, budgetItemId: 'i-groc', budgetItemName: 'Groceries' },
      { ...row, id: 'g2', date: '2026-06-19', payee: 'Kwik Fit Leeds', amount: 1162.4, currency: 'GBP', budgetAmount: 1350.12, budgetItemId: 'i-car', budgetItemName: 'Car service' },
      { ...row, id: 'g3', date: '2026-06-18', payee: 'Pret A Manger', amount: 8.9, currency: 'GBP', budgetAmount: 10.33, budgetItemId: 'i-rent', budgetItemName: 'Rent' },
      { ...row, id: 'g4', date: '2026-06-17', payee: 'Corner shop', amount: 18, currency: 'USD', fxPending: true, budgetItemId: 'i-groc', budgetItemName: 'Groceries' },
    ]
    await page.route('**/api/accounts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([gb]) }),
    )
    await page.route('**/api/transactions', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
    )
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/accounts/gb')
      await page.getByText('Tesco Express').waitFor()
      await expect(page.getByText('Counts as €27.15 in the budget')).toBeVisible()
      await expect(page.getByText('Needs EUR amount')).toBeVisible()
      const m = await page.getByRole('region', { name: /^Transactions/ }).evaluate((card: HTMLElement) =>
        Array.from(card.querySelectorAll<HTMLElement>('[data-testid="tx-row"]')).map((r) => {
          const amount = r.querySelector<HTMLElement>('[data-tx-amount]')!.getBoundingClientRect()
          // The row's truncating texts: the payee, then the category chip's name.
          const [payee, chip] = Array.from(r.querySelectorAll<HTMLElement>('.truncate'))
          const under = Array.from(r.querySelectorAll<HTMLElement>('.truncate, [data-tone]')).filter(
            (el) => !el.closest('[data-tx-amount]') && el.getBoundingClientRect().right > amount.left + 1,
          )
          return {
            name: payee?.textContent ?? '',
            payeeShown: payee ? payee.clientWidth / payee.scrollWidth : 0,
            chip: chip?.textContent ?? '',
            chipShown: chip ? chip.clientWidth / chip.scrollWidth : 0,
            under: under.length,
          }
        }),
      )
      const de = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }))
      expect(m, `${width}px: the rows render`).toHaveLength(4)
      expect(de.scrollW, `${width}px: the page scrolls sideways`).toBeLessThanOrEqual(de.clientW + 1)
      for (const r of m) {
        expect(r.under, `${width}px ${r.name}: the middle column runs under the amount`).toBe(0)
        // At 320 px a name may give a few letters to its ellipsis (most of it shows); at 360 px it
        // shows whole.
        expect(r.chipShown, `${width}px ${r.name}: its category chip ${r.chip} is cut`).toBeGreaterThanOrEqual(width === 320 ? 0.6 : 1)
        expect(r.payeeShown, `${width}px ${r.name}: its payee is cut`).toBeGreaterThanOrEqual(width === 320 ? 0.6 : 1)
      }
    }
  })

  // UX-032 — the budget grid does NOT use an overflow-x scroller; its rows reflow
  // (a CSS grid: icon, name minmax(0,1fr), amount auto, the status on a second line
  // below 500px of card). The UX-032 guarantee therefore holds via reflow: the DATA
  // columns fit their allocated width with no internal spill (the "columns collide /
  // icons spill" bug class), and the page never scrolls sideways. Anything
  // `position:absolute` is excluded — this checks the flowing data, the
  // non-duplicative complement to mobile-layout.spec's document-level check. On a
  // phone the line's name is the button that opens its actions (restyle PR 3).
  test('the budget grid data columns reflow without collision (UX-032)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const rent = page.getByRole('button', { name: 'Rent', exact: true })
    await rent.waitFor()
    const m = await rent.evaluate((btn: HTMLElement) => {
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
  // The top bar's theme control: one aria-pressed toggle named "Dark mode".
  const darkMode = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: 'Dark mode', exact: true })

  // UX-024 — toggling to Dark stamps `.dark` on the root and inverts the slate
  // ramp app-wide: a known slate-ramp colour (a People card's name, text-slate-900, which carries
  // NO dark: override; the "Other sign-ins" bg-slate-50 header it used to sample went with
  // restyle PR 8, and the Accounts page's reconciliation header before it with PR 6) flips from
  // near-black to near-white purely via the remapped ramp. Driven with the top bar's real Dark
  // mode button so the "stamp the root" step is the live toggle, not a preloaded class.
  test('toggling to dark stamps the root and inverts the slate ramp (UX-024)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/people')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const slateInk = page.getByRole('heading', { level: 2, name: 'Alex', exact: true })
    await slateInk.waitFor()
    expect(await slateInk.evaluate((el) => el.className)).toMatch(/(^| )text-slate-900( |$)/)
    expect(await slateInk.evaluate((el) => el.className)).not.toMatch(/dark:/)

    // Light: root is not dark, the slate-900 ink is near-black.
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    const lightInk = (await sample(slateInk)).color
    expect(luminance(lightInk), 'text-slate-900 should be near-black in light').toBeLessThan(0.15)

    // Toggle → the root gains .dark and the SAME ink inverts to near-white.
    await darkMode(page).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect
      .poll(async () => luminance((await sample(slateInk)).color))
      .toBeGreaterThan(0.5)
  })

  // UX-025 — the import sample table (in the Columns dialog since restyle PR 14) flips to dark
  // using ONLY the remapped slate ramp (no dark: overrides on it): its box, the dialog's field
  // tint, must render dark, and the header and the cells (text-slate-500) must stay legible — no
  // light-on-light and no double-inverted wash-out.
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
    await page.getByRole('button', { name: 'Columns' }).click()

    const sampleTable = page.getByRole('dialog', { name: 'Columns' }).getByRole('table', { name: 'Sample of the uploaded file' })
    await sampleTable.waitFor()
    await expect(page.locator('html')).toHaveClass(/dark/)

    // The header row's background → dark (ramp inverted, not washed out to a light grey), and
    // its text AA-legible on it.
    const header = await sample(sampleTable.locator('thead th').first())
    expect(luminance(header.effBg), 'mapping header did not invert to dark').toBeLessThan(0.2)
    expect(contrast(header.color, header.effBg), 'mapping header text illegible in dark').toBeGreaterThanOrEqual(4.5)

    // Cell text stays AA-legible against its dark background.
    const cell = await sample(sampleTable.locator('tbody td').first())
    expect(contrast(cell.color, cell.effBg), 'mapping cell text illegible in dark').toBeGreaterThanOrEqual(
      4.5,
    )
  })

  // UX-026 — the active sidebar nav link (the current page on its raised card) flips
  // from dark ink in light to light ink in dark with the theme, and stays AA-legible
  // on its card in both.
  test('accent tints keep their dark variant and stay AA-legible (UX-026)', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/accounts')
    await page.getByRole('heading', { level: 1 }).first().waitFor()

    const active = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Accounts' })
    await expect(active).toHaveAttribute('aria-current', 'page')

    // Light: the active item's text is dark ink, AA on its card.
    const light = await sample(active)
    expect(luminance(light.color), 'active-nav text should be dark in light').toBeLessThan(0.3)
    expect(contrast(light.color, light.effBg), 'active-nav text illegible in light').toBeGreaterThanOrEqual(4.5)

    // Dark: the text brightens and still clears AA on its card.
    await darkMode(page).click()
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
