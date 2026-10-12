import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { authedSetup, FLAGS } from './mocks'

/**
 * The Help page's restyle (PR 13), in a real browser on the mocked API (e2e/mocks.ts): the hero
 * across the top, then the Topics card and (only with the `analytics` flag on) the Privacy card
 * beside it on a wide screen, under it on a phone; a topic row opening in place by mouse and
 * keyboard; the Replay link ("Replay tour" on a phone) opening the welcome dialog and taking focus
 * back; the guide link's attributes; the consent switch's three states; and no WCAG A/AA
 * violations with a topic and a hint open.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function expectNoViolations(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}`).join('\n')
  expect(violations, summary).toEqual([])
}

/** The analytics flag on (it ships off), with the stored consent choice, if any. */
async function withAnalytics(page: Page, consent: 'granted' | 'denied' | null) {
  await page.route('**/api/features', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...FLAGS, analytics: true }) }),
  )
  if (consent) await page.addInitScript((c) => localStorage.setItem('zbb.analyticsConsent', c), consent)
}

async function openHelp(page: Page) {
  await page.goto('/help')
  await expect(page.getByRole('heading', { level: 1, name: 'Help & guide' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Topics' })).toBeVisible()
}

/**
 * A topic's panel: the element its row controls, kept in the DOM and `hidden` while closed. Not a
 * landmark (nine topics open independently; nine regions would crowd a screen reader's list).
 */
async function panelOf(page: Page, name: string) {
  const id = await page.getByRole('button', { name, exact: true }).getAttribute('aria-controls')
  expect(id).toBeTruthy()
  return page.locator(`[id="${id}"]`)
}

/** Whether the point at the element's centre hits the element itself (nothing fixed over it). */
function coveredAtCentre(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !(hit && el.contains(hit))
}

const TOPICS = [
  'Months & appearance',
  'Transactions',
  'Bills & due dates',
  'Accounts',
  'Saving with jars',
  'Reports',
  'People & allocation',
  'Your account',
  'Good to know',
]

test.describe('Help', () => {
  test('the hero leads, then the topics across the width while analytics is off', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await openHelp(page)

    const hero = page.getByRole('region', { name: 'Zero-based budgeting' })
    await expect(hero).toContainText('Give every euro a job')
    const topics = page.getByRole('region', { name: 'Topics' })
    const heroBox = (await hero.boundingBox())!
    const topicsBox = (await topics.boundingBox())!
    expect(heroBox.height).toBeGreaterThanOrEqual(150)
    expect(topicsBox.y).toBeGreaterThan(heroBox.y + heroBox.height)
    // The card spans both columns: as wide as the hero.
    expect(Math.abs(topicsBox.width - heroBox.width)).toBeLessThan(2)

    await expect(page.getByRole('heading', { name: 'Privacy' })).toHaveCount(0)
    await expect(page.getByRole('switch')).toHaveCount(0)

    // Nine rows, all closed, in order.
    const rows = topics.getByRole('button', { expanded: false })
    await expect(rows).toHaveText(TOPICS)
    await expect(await panelOf(page, 'Saving with jars')).toBeHidden()
    // The page's landmarks are the hero and the cards (the frame's nav, main and header aside).
    await expect(page.getByRole('region')).toHaveCount(2)
  })

  test('a topic opens in place with the mouse and closes again; the others stay as they were', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await openHelp(page)

    const jars = page.getByRole('button', { name: 'Saving with jars' })
    const reports = page.getByRole('button', { name: 'Reports' })
    const before = (await reports.boundingBox())!.y
    await jars.click()
    await expect(jars).toHaveAttribute('aria-expanded', 'true')
    const panel = await panelOf(page, 'Saving with jars')
    await expect(panel).toBeVisible()
    // Open, it is still no landmark.
    await expect(page.getByRole('region', { name: 'Saving with jars' })).toHaveCount(0)
    await expect(panel.getByRole('listitem')).toHaveText([
      'For big or irregular costs: car, holiday, Christmas.',
      'Give a jar a target and a date, and AllotJar works out what to set aside each month and shows it filling up.',
      'Its monthly contribution becomes a line in your Savings group, whose balance rolls over month to month.',
    ])
    // The rows below move down to make room; nothing else opened.
    expect((await reports.boundingBox())!.y).toBeGreaterThan(before + 60)
    await expect(reports).toHaveAttribute('aria-expanded', 'false')

    await jars.click()
    await expect(jars).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
    expect((await reports.boundingBox())!.y).toBe(before)
  })

  test('a topic opens and closes from the keyboard (Enter, Space), focus staying on the row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await openHelp(page)

    const bills = page.getByRole('button', { name: 'Bills & due dates' })
    await bills.focus()
    await page.keyboard.press('Enter')
    await expect(bills).toHaveAttribute('aria-expanded', 'true')
    const panel = await panelOf(page, 'Bills & due dates')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Mark paid ticks it off for the month you’re viewing.')
    await expect(bills).toBeFocused()
    // Tab moves on to the next row: the panel holds nothing focusable.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Accounts' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Space')
    await expect(bills).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
    await expect(bills).toBeFocused()
  })

  test('the Topics header: Replay opens the welcome and takes focus back; the guide link opens a new tab', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await openHelp(page)

    const guide = page.getByRole('link', { name: 'Complete user guide (opens in a new tab)' })
    await expect(guide).toBeVisible()
    await expect(guide).toHaveText('User guide')
    await expect(guide).toHaveAttribute('href', 'https://github.com/maskit89/AllotJar/blob/main/docs/USER_GUIDE.md')
    await expect(guide).toHaveAttribute('target', '_blank')
    await expect(guide).toHaveAttribute('rel', 'noreferrer')

    const replay = page.getByRole('button', { name: 'Replay welcome tour' })
    await expect(replay).toBeVisible()
    await replay.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Welcome to AllotJar' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(replay).toBeFocused()
    // The replay brought the Getting started checklist back.
    await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible()
  })

  test('on a phone the link reads "Replay tour", and the cards stack: hero, Topics, Privacy', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await authedSetup(page, 'light')
    await withAnalytics(page, 'granted')
    await openHelp(page)

    await expect(page.getByRole('button', { name: 'Replay tour', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Replay welcome tour' })).toHaveCount(0)

    const hero = (await page.getByRole('region', { name: 'Zero-based budgeting' }).boundingBox())!
    const topics = (await page.getByRole('region', { name: 'Topics' }).boundingBox())!
    const privacy = (await page.getByRole('region', { name: 'Privacy' }).boundingBox())!
    expect(hero.height).toBeGreaterThanOrEqual(112)
    expect(topics.y).toBeGreaterThan(hero.y + hero.height)
    expect(privacy.y).toBeGreaterThan(topics.y + topics.height)
    expect(Math.abs(privacy.width - topics.width)).toBeLessThan(2)
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  })

  test('with analytics offered, the Privacy card stands beside the topics and its switch follows the choice', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authedSetup(page, 'light')
    await withAnalytics(page, null)
    await openHelp(page)

    const privacy = page.getByRole('region', { name: 'Privacy' })
    const topics = page.getByRole('region', { name: 'Topics' })
    const privacyBox = (await privacy.boundingBox())!
    const topicsBox = (await topics.boundingBox())!
    expect(Math.abs(privacyBox.y - topicsBox.y)).toBeLessThan(2)
    expect(privacyBox.x).toBeGreaterThan(topicsBox.x + topicsBox.width)

    // Undecided: off, "Not chosen yet", and the frame's consent banner is up too.
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toBeVisible()
    const sw = page.getByRole('switch', { name: 'Google Analytics' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(sw).toHaveAccessibleDescription('Not chosen yet')

    // Accepting on the switch persists the choice; the banner goes.
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(privacy.getByText('Not chosen yet')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('zbb.analyticsConsent'))).toBe('granted')

    // Declining again from the keyboard: off, and stored as declined (the banner stays away).
    await sw.focus()
    await page.keyboard.press('Space')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(privacy.getByText('Not chosen yet')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('zbb.analyticsConsent'))).toBe('denied')
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toHaveCount(0)

    // What is sent sits behind the (i).
    await page.getByRole('button', { name: 'About privacy' }).focus()
    await expect(page.getByRole('tooltip')).toContainText('only anonymous page views and feature-usage events')
  })

  test('the Privacy card stays in view while the topics scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 })
    await authedSetup(page, 'light')
    await withAnalytics(page, 'granted')
    await openHelp(page)
    for (const name of TOPICS) await page.getByRole('button', { name }).click()
    await page.evaluate(() => window.scrollTo(0, 600))
    await page.waitForTimeout(100)
    const privacy = (await page.getByRole('region', { name: 'Privacy' }).boundingBox())!
    expect(privacy.y).toBeGreaterThanOrEqual(80)
    expect(privacy.y).toBeLessThan(120)
  })

  test('on a phone with the choice still open, the consent banner never covers the switch (WCAG 2.4.11)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await authedSetup(page, 'light')
    await withAnalytics(page, null)
    await openHelp(page)
    const banner = page.getByRole('region', { name: 'Analytics consent' })
    await expect(banner).toBeVisible()
    const sw = page.getByRole('switch', { name: 'Google Analytics' })

    // Scrolled to the end, the Privacy card (last in flow) ends above the fixed banner.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(150)
    const bannerBox = (await banner.boundingBox())!
    const swBox = (await sw.boundingBox())!
    expect(swBox.y + swBox.height).toBeLessThanOrEqual(bannerBox.y)
    expect(await sw.evaluate(coveredAtCentre)).toBe(false)

    // Tabbing onto the switch from the top of the page scrolls it clear of the banner too.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByRole('button', { name: 'About privacy' }).focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(sw).toBeFocused()
    await page.waitForTimeout(150)
    const focused = (await sw.boundingBox())!
    expect(focused.y + focused.height).toBeLessThanOrEqual((await banner.boundingBox())!.y)
    expect(await sw.evaluate(coveredAtCentre)).toBe(false)

    // So the switch can be tapped (a covered one would never receive the click); the choice made,
    // the banner goes and the page's end comes back up to the tab bar.
    await sw.click({ timeout: 5000 })
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(banner).toHaveCount(0)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--consent-h'))).toBe('')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`no WCAG A/AA violations with a topic and the hero's hint open (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await authedSetup(page, theme)
      await withAnalytics(page, 'denied')
      await openHelp(page)
      await page.getByRole('button', { name: 'Saving with jars' }).click()
      await expect(await panelOf(page, 'Saving with jars')).toBeVisible()
      await page.getByRole('button', { name: 'About zero-based budgeting' }).focus()
      await expect(page.getByRole('tooltip')).toContainText('Remaining to budget')
      await expectNoViolations(page)
    })
  }
})
