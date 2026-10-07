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

test('the empty Jars page fits its example jars on a phone screen', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.route('**/api/jars', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.goto('/jars')
  await page.getByRole('button', { name: /^Rainy day, / }).waitFor()
  await assertNoHorizontalOverflow(page, '/jars (empty, example jars)')
})
