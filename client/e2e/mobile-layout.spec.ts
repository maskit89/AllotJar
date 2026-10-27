import { expect, test } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup, mockApi } from './mocks'

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

// Restyle PR 6 — an account's jar caption ("N jars", then what is not in the jars, the shortfall
// over them, or "Jars exceed account money", each with its (i)) fits the narrowest phone (320px,
// the width WCAG 1.4.10 names): where the line has no room, its right part moves under the jar
// count instead of running out of the card. Each (i)'s explanation wraps inside its popover.
test('the accounts jar captions and their hints fit a 320px phone, a shortfall included', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await authedSetup(page, 'light')
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const acct = (id: string, name: string, type: number, currentBalance: number, displayOrder: number) => ({
    id, name, type, currency: 'EUR', openingBalance: 0, openingDate: '2026-01-01', currentBalance, displayOrder,
  })
  await page.route('**/api/accounts', (route) =>
    route.fulfill(json([acct('a1', 'Long-term savings', 1, 104250, 0), acct('a2', 'Rainy day', 1, 6200, 1), acct('a3', 'Holiday pot', 1, 700, 2)])),
  )
  await page.route('**/api/accounts/reconciliation', (route) =>
    route.fulfill(
      json([
        { accountId: 'a1', accountName: 'Long-term savings', currentBalance: 104250, backedJarsTotal: 23456.78, backedJarCount: 12, float: 80793.22 },
        { accountId: 'a2', accountName: 'Rainy day', currentBalance: 6200, backedJarsTotal: 16900, backedJarCount: 3, float: -10700, hasBackingDeficit: true },
        // A jar below zero offsets the others: no amount over, the shortfall in words.
        { accountId: 'a3', accountName: 'Holiday pot', currentBalance: 700, backedJarsTotal: 700, backedJarCount: 2, float: 0, hasBackingDeficit: true },
      ]),
    ),
  )
  await page.goto('/accounts')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  const captions = page.getByTestId('account-jars')
  await expect(captions).toHaveCount(3)
  await expect(captions.nth(2)).toContainText('Jars exceed account money')
  await assertNoHorizontalOverflow(page, '/accounts (jar captions at 320px)')
  // What shows of each caption line (its elements; the (i)'s invisible ::after hit area may reach
  // a little past it, as everywhere) stays inside the line, and the line inside its row.
  const overflow = await captions.evaluateAll((els) =>
    els.map((el) => {
      const line = el.lastElementChild as HTMLElement
      const row = el.closest('article')!.getBoundingClientRect()
      const right = Math.max(...Array.from(line.querySelectorAll('*')).map((c) => c.getBoundingClientRect().right))
      return { pastLine: Math.round(right - line.getBoundingClientRect().right), pastRow: Math.round(right - row.right) }
    }),
  )
  for (const [i, o] of overflow.entries()) {
    expect(o.pastLine, `caption ${i} runs out of its line`).toBeLessThanOrEqual(1)
    expect(o.pastRow, `caption ${i} runs past its row`).toBeLessThanOrEqual(1)
  }

  for (const name of ['About the money not in jars in Long-term savings', 'About the shortfall in Rainy day', 'About the shortfall in Holiday pot']) {
    const hint = page.getByRole('button', { name })
    await hint.focus()
    const tip = page.getByRole('tooltip')
    await tip.waitFor()
    const m = await tip.evaluate((el) => ({ scroll: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right }))
    expect(m.scroll, `${name}: the explanation runs out of its popover`).toBeLessThanOrEqual(1)
    expect(m.right, `${name}: the popover runs off the screen`).toBeLessThanOrEqual(320)
    await assertNoHorizontalOverflow(page, `/accounts (${name} open at 320px)`)
    await hint.blur()
    await expect(tip).toHaveCount(0)
  }
})

// The signed-out pages (restyle PR 9): the green band and the sheet never scroll sideways, and on a
// phone the whole Sign in form (both fields and the button; Google's button sits under it when
// configured) is on the first screen without scrolling.
test.describe('signed-out pages on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const path of [
    '/',
    '/login',
    '/login?register=1',
    '/forgot-password',
    '/reset-password?email=a%40b.c&token=t',
    '/accept-invite?code=x',
    '/confirm-email',
    '/confirm-email?email=a%40b.c&token=t',
    '/privacy',
    '/terms',
  ]) {
    test(`${path} does not overflow horizontally`, async ({ page }) => {
      await page.route('**/api/**', mockApi)
      await page.goto(path)
      await page.getByRole('heading', { level: 1 }).waitFor()
      await assertNoHorizontalOverflow(page, path)
    })
  }

  // The landing (restyle PR 15, decluttered): the band, the line, the card's one primary and the
  // header's "Sign in" are on the first screen of a 390x844 phone.
  test('the landing shows the line and the primary on the first screen', async ({ page }) => {
    await page.route('**/api/**', mockApi)
    await page.goto('/')
    const line = page.getByRole('banner').getByRole('heading', { level: 1, name: 'Give every euro a job.' })
    await line.waitFor()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    for (const el of [line, page.getByRole('link', { name: 'Create your free account' }), page.getByRole('link', { name: 'Sign in' })]) {
      const box = await el.boundingBox()
      expect(box, 'on the page').not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    }
    // The hero's button is the only filled green button on the first screen.
    const inView = await page.locator('.bg-brand-600').evaluateAll((els) =>
      els.filter((el) => el.getBoundingClientRect().top < window.innerHeight).length,
    )
    expect(inView).toBe(1)
  })

  test('the Sign in form fits the first screen, the expired notice included', async ({ page }) => {
    await page.route('**/api/**', mockApi)
    await page.goto('/login?reason=expired')
    await page.getByText('Your session has expired').waitFor()
    for (const el of [
      page.getByRole('group', { name: 'Sign in or create an account' }),
      page.getByLabel('Email'),
      page.getByLabel('Password'),
      page.locator('button[type="submit"]'),
    ]) {
      const box = await el.boundingBox()
      expect(box, 'on the page').not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('the band is one height everywhere: the switch and the line stay put across modes and pages', async ({ page }) => {
    await page.route('**/api/**', mockApi)
    await page.goto('/login')
    const line = page.getByRole('banner').getByText('Give every euro a job.')
    const sw = page.getByRole('group', { name: 'Sign in or create an account' })
    await sw.waitFor()
    // Where the switch sits depends on how the line wraps, and that depends on the web font: on a
    // slow runner Hanken Grotesk can arrive between the two measurements, and the fallback face
    // wraps the line onto two lines. Settle the font before measuring.
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    const lineY = (await line.boundingBox())!.y
    const swY = (await sw.boundingBox())!.y

    await sw.getByRole('button', { name: 'Create account', exact: true }).click()
    await page.getByLabel('First name').waitFor()
    expect((await sw.boundingBox())!.y, 'the switch under the finger').toBe(swY)
    expect((await line.boundingBox())!.y).toBe(lineY)

    for (const path of ['/forgot-password', '/reset-password?email=a%40b.c&token=t', '/accept-invite?code=x', '/login?reason=expired', '/confirm-email']) {
      await page.goto(path)
      await page.getByRole('heading', { level: 1 }).waitFor()
      expect((await line.boundingBox())!.y, path).toBe(lineY)
    }
  })
})

// The desktop frame keeps the approved room at the top (no viewport-based drop), so Create account,
// the tallest card, fits the reference 1440x900 screen without scrolling.
test.describe('signed-out pages on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Create account fits 1440x900 without scrolling', async ({ page }) => {
    await page.route('**/api/**', mockApi)
    await page.goto('/login?register=1')
    await page.getByLabel('First name').waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900)
    const submit = await page.locator('button[type="submit"]').boundingBox()
    expect(submit!.y + submit!.height).toBeLessThanOrEqual(900)
  })
})
