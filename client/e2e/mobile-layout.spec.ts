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
  await page.getByRole('dialog').getByLabel('Next due date').waitFor()
  await assertNoHorizontalOverflow(page, '/jars (new-jar modal)')
})
