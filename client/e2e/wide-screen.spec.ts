import { expect, test, type Page, type Route } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup, mockApi } from './mocks'

/**
 * Wide-screen guard. The content column is 1240px wide until the screen leaves 80px either side of
 * it, then grows with the screen up to 3440px (`--content-max`, index.css), and the Jars and
 * Accounts grids add a fourth column from 1400px, a fifth from 1800px and a sixth from 2200px.
 * A laptop keeps the 1240px column and three columns.
 */

async function open(page: Page, path: string, stub?: () => Promise<void>) {
  await authedSetup(page, 'light')
  await stub?.() // registered after the mocks, so it wins
  await page.goto(path)
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.waitForLoadState('networkidle')
}

/** The page column's width and the top bar's, which keeps to the same column. */
async function columns(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById('main-content')!
    const body = main.querySelector(':scope > div')!.getBoundingClientRect().width
    const bar = main.querySelector('header > div')!.getBoundingClientRect().width
    return { body, bar }
  })
}

/** How many columns the grid holding the named cards lays out. */
async function gridColumns(page: Page, heading: string) {
  const grid = page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) }).locator(':scope > div.grid')
  return grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
}

for (const { width, column, cols } of [
  { width: 1440, column: 1192, cols: 3 }, // the sidebar leaves 1192px: the column fills it
  { width: 1920, column: 1512, cols: 4 }, // 1920 - 248 - 160
  { width: 2560, column: 2152, cols: 5 },
  { width: 3840, column: 3432, cols: 6 }, // a 4K screen at 100% scaling
  { width: 5120, column: 3440, cols: 6 }, // capped
]) {
  test.describe(`a ${width}px-wide screen`, () => {
    test.use({ viewport: { width, height: 1000 } })

    test(`the content column is ${column}px wide, the top bar with it`, async ({ page }) => {
      await open(page, '/')
      const { body, bar } = await columns(page)
      // The scroll bar (none in headless Chromium) would take a few pixels off.
      expect(Math.abs(body - column)).toBeLessThanOrEqual(1)
      expect(Math.abs(bar - body)).toBeLessThanOrEqual(1)
    })

    test(`the Jars and Accounts grids lay out ${cols} columns`, async ({ page }) => {
      // One jar-backed account's ledger, so the Unallocated card shows (the mocks hold none).
      const ledger = () => page.route('**/api/jars/ledger', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { accountId: 'acc1', accountName: 'Savings Joint', currency: 'EUR', asOf: '2026-06-20', accountBalance: 5000, unallocated: 4470, positiveAllocations: 570, hasBackingDeficit: false, unreconciledAllocations: 0, requiresReview: false, jars: [{ jarId: 'f1', name: 'Home insurance', balance: 120, isArchived: false }] },
          ]),
        }),
      )
      await open(page, '/jars', ledger)
      expect(await gridColumns(page, 'Your jars')).toBe(cols)
      // The Unallocated card under the jars stays as wide as one of their columns.
      const card = await page.locator('[data-jar-id]').first().boundingBox()
      const unallocated = await page.locator('section', { has: page.getByRole('heading', { name: 'Unallocated', exact: true }) }).boundingBox()
      expect(Math.abs(unallocated!.width - card!.width)).toBeLessThanOrEqual(1)
      await open(page, '/accounts')
      expect(await gridColumns(page, 'Your accounts')).toBe(cols)
    })
  })
}

// Every page uses the same column (Christopher, 19 Oct: nothing moves between pages), so a page
// that keeps to a narrower width of its own fails here.
test.describe('every page on a 3840px-wide screen', () => {
  test.use({ viewport: { width: 3840, height: 1000 } })
  for (const path of AUTHED_ROUTES) {
    test(`${path} uses the full 3432px column, the top bar with it`, async ({ page }) => {
      await open(page, path)
      const inner = await page.evaluate(() => {
        const width = (el: Element) => {
          const cs = getComputedStyle(el)
          return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        }
        const main = document.getElementById('main-content')!
        return { body: width(main.querySelector(':scope > div')!), bar: width(main.querySelector('header > div')!) }
      })
      expect(Math.abs(inner.body - (3432 - 80))).toBeLessThanOrEqual(1)
      expect(Math.abs(inner.bar - (3432 - 80))).toBeLessThanOrEqual(1)
    })
  }
})

test.describe('the widest screen', () => {
  test.use({ viewport: { width: 2560, height: 1440 } })
  for (const path of AUTHED_ROUTES) {
    test(`${path} does not overflow horizontally`, async ({ page }) => {
      await open(page, path)
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))
      expect(scrollW).toBeLessThanOrEqual(clientW + 1)
    })
  }
})

/**
 * The KPI row's edges against the two cards under it (Christopher, 19 Oct: the four looked out of
 * line). The hero ends where the left card ends; with one tile, the tile spans the right card; with
 * two, from a 1100px row (a 1440px screen) the two share the right card's width. Each card is the grid child holding
 * its heading.
 */
async function edges(page: Page, left: string, right: string) {
  return page.evaluate(([l, r]) => {
    const h = (name: string) => [...document.querySelectorAll('#main-content h2')].find((x) => x.textContent?.trim() === name)!
    const cell = (own: Element, other: Element) => {
      let el = own
      while (el.parentElement && !el.parentElement.contains(other)) el = el.parentElement
      return el.getBoundingClientRect()
    }
    const [hl, hr] = [h(l), h(r)]
    const tiles = [...document.querySelector('.kpi-hero')!.parentElement!.children].map((t) => t.getBoundingClientRect())
    return { tiles: tiles.map((t) => [t.left, t.right]), left: [cell(hl, hr).left, cell(hl, hr).right], right: [cell(hr, hl).left, cell(hr, hl).right] }
  }, [left, right])
}

/** The month without a due date on any line, so the Dashboard shows no Bills tile. */
async function noBills(page: Page) {
  await page.route(/\/api\/budget\/(current|\d+\/\d+)$/, (route) =>
    mockApi({
      request: () => route.request(),
      fulfill: ({ body, ...rest }: { body: string }) => {
        const month = JSON.parse(body)
        for (const c of month.categories) for (const item of c.items) item.dueDay = null
        return route.fulfill({ ...rest, body: JSON.stringify(month) })
      },
    } as unknown as Route),
  )
}

for (const width of [1440, 1920, 2560, 3840]) {
  test.describe(`the KPI row on a ${width}px-wide screen`, () => {
    test.use({ viewport: { width, height: 1000 } })
    for (const { name, path, left, right, stub } of [
      { name: 'the Dashboard without bills', path: '/', left: 'Budget', right: 'Jars', stub: noBills },
      { name: 'the Dashboard with bills', path: '/', left: 'Budget', right: 'Jars' },
      { name: 'Reports', path: '/reports', left: 'Trend', right: 'Spending' },
      { name: 'Allocation', path: '/allocation', left: 'Steps', right: 'Savings' },
    ]) {
      test(`${name}: the tiles line up with the cards under them`, async ({ page }) => {
        await open(page, path, stub && (() => stub(page)))
        const e = await edges(page, left, right)
        expect(e.tiles.length).toBe(stub ? 2 : 3)
        const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
        near(e.tiles[0][0], e.left[0])
        near(e.tiles[0][1], e.left[1])
        near(e.tiles[1][0], e.right[0])
        near(e.tiles[e.tiles.length - 1][1], e.right[1])
      })
    }

    test('the Dashboard while loading: the placeholder hero is as wide as the loaded one', async ({ page }) => {
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      await authedSetup(page, 'light')
      await page.route(/\/api\/budget\/(current|\d+\/\d+)$/, async (route) => {
        await held
        return route.fallback()
      })
      await page.goto('/')
      await expect(page.getByText('Loading your budget…')).toBeAttached()
      const placeholder = await page.evaluate(() => {
        const row = document.querySelector('#main-content [aria-hidden] .grid')!
        return row.firstElementChild!.getBoundingClientRect().width
      })
      release()
      await expect(page.locator('.kpi-hero')).toBeVisible()
      const hero = await page.locator('.kpi-hero').evaluate((el) => el.getBoundingClientRect().width)
      expect(Math.abs(placeholder - hero)).toBeLessThanOrEqual(1)
    })
  })
}
