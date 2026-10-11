import { expect, test } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup } from './mocks'

/**
 * Mobile layout guard. At a phone-width viewport, no page may scroll sideways:
 * wide, column-dense content (the budget grid, the data tables) must scroll
 * *inside its own container*, never push the document past the viewport. This is
 * the regression test for the "columns collide / icons spill into the next
 * column on mobile" class of bug.
 */

// A small phone (iPhone SE width) — the tightest mainstream target.
test.use({ viewport: { width: 375, height: 812 } })

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page, label: string) {
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))
  expect(
    scrollW,
    `${label}: document is ${scrollW}px wide but the viewport is only ${clientW}px — something overflows horizontally`,
  ).toBeLessThanOrEqual(clientW + 1) // +1 for sub-pixel rounding
}

for (const path of AUTHED_ROUTES) {
  test(`${path} does not overflow horizontally on mobile`, async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.waitForLoadState('networkidle')
    await assertNoHorizontalOverflow(page, path)
  })
}

test('the jar modal fits a phone screen (2-col grid in a dialog)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/jars')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  await page.getByRole('button', { name: 'New jar' }).click()
  // A new jar doesn't repeat, so its date reads "Needed by", beside Repeats in the grid.
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Needed by').waitFor()
  await dialog.getByLabel('Repeats').waitFor()
  // The journeys find the date by a part of its name: the Date / Month choice beside it must not carry it.
  await expect(dialog.getByLabel('Needed by')).toHaveCount(1)
  await assertNoHorizontalOverflow(page, '/jars (new-jar modal)')
  // Just the month: the list of months in the date's half of the grid.
  await dialog.getByRole('radio', { name: 'Month' }).check()
  await dialog.getByLabel('Needed by (month)').waitFor()
  await assertNoHorizontalOverflow(page, '/jars (new-jar modal, just the month)')
  await dialog.getByRole('radio', { name: 'Date' }).check()
  // The More options fold holds a second 2-col grid ("Already set aside" + "Set aside on").
  await dialog.getByRole('button', { name: 'More options' }).click()
  await dialog.getByLabel('Set aside on').waitFor()
  // getByLabel matches a substring: the field's info button must not carry the field's name,
  // or the journeys' getByLabel('Already set aside') finds two elements.
  await expect(dialog.getByLabel('Already set aside')).toHaveCount(1)
  await assertNoHorizontalOverflow(page, '/jars (new-jar modal, More options open)')
})

test('a jar\'s ⋯ opens a sheet titled with its name on a phone, which fits the screen', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/jars')
  const more = page.getByRole('button', { name: 'Home insurance: more actions' })
  await more.click()
  const sheet = page.getByRole('dialog', { name: 'Home insurance' })
  await sheet.getByRole('button', { name: 'Edit' }).waitFor()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await assertNoHorizontalOverflow(page, '/jars (jar sheet open)')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('the empty Jars page fits its example jars on a phone screen', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.route('**/api/jars', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.goto('/jars')
  await page.getByRole('button', { name: /^Rainy day, / }).waitFor()
  await assertNoHorizontalOverflow(page, '/jars (empty, example jars)')
})

// The phone frame's bottom tab bar is fixed over the page: the content reserves its height
// (safe area included), so scrolled to the very bottom, the page's last element still ends
// above the bar — nothing is ever hidden under it.
for (const path of ['/', '/transactions', '/help']) {
  test(`${path}: the tab bar never covers the end of the page`, async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const m = await page.evaluate(() => {
      const bar = document.querySelector('[data-tabbar]')!.getBoundingClientRect()
      const content = document.querySelector('#main-content > header + div') as HTMLElement
      const last = content.lastElementChild!.getBoundingClientRect()
      return { barTop: bar.top, barHeight: bar.height, lastBottom: last.bottom }
    })
    expect(m.barHeight, 'tab bar height').toBeGreaterThanOrEqual(60)
    expect(m.lastBottom, `${path}: the last block ends under the tab bar`).toBeLessThanOrEqual(m.barTop)
  })
}

// WCAG 2.4.11 (Focus Not Obscured): the fixed tab bar also reserves its height for scrolling
// (html scroll-padding-bottom), so tabbing forward through a long page scrolls each focused
// control clear of the bar instead of leaving it underneath.
for (const path of ['/', '/transactions', '/people', '/account']) {
  test(`${path}: keyboard focus never ends up under the tab bar`, async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.waitForLoadState('networkidle')
    const hidden: string[] = []
    let stops = 0
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab')
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        const bar = document.querySelector('[data-tabbar]')!
        if (!el || el === document.body || bar.contains(el)) return null
        const e = el.getBoundingClientRect()
        const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)
        return { name, top: e.top, bottom: e.bottom, barTop: bar.getBoundingClientRect().top }
      })
      if (!r) continue
      stops++
      if (r.bottom > r.barTop + 1) hidden.push(`${r.name} [${Math.round(r.top)}-${Math.round(r.bottom)}], bar at ${Math.round(r.barTop)}`)
    }
    expect(stops, `${path}: focus stops outside the tab bar`).toBeGreaterThan(10)
    expect(hidden, `${path}: focused controls (partly) under the tab bar`).toEqual([])
  })
}

// Widening the window past the breakpoint with the More sheet open (a tablet turning to
// landscape) closes the sheet; More is hidden then, so focus goes to the main content rather
// than being dropped on <body>.
test('the More sheet closes on widening and focus lands on the main content', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 812 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('#main-content')).toBeFocused()
})

// The tab bar stays above the sheet's scrim, so a tab tapped while the sheet is open closes the
// sheet and opens that page in the same tap.
test('a tab tapped with the More sheet open goes straight to its page', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
  // The open modal sheet hides the bar from the accessibility tree, so reach the tab by its link.
  await page.locator('[data-tabbar] a[href="/jars"]').click()
  await expect(page).toHaveURL(/\/jars$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Jars' })).toBeVisible()
})
