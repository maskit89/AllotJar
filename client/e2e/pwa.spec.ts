import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mocks'

// The installable app (PWA): the manifest, its icons, and the service worker (public/sw.js).
// The app registers the worker in production builds only, so these specs register it by hand
// on the dev server; the worker file is the same one a build ships.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

test('the manifest names the app, opens at sign-in, and every icon it lists loads', async ({ page, request }) => {
  await page.route('**/api/**', mockApi)
  await page.goto('/login')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')

  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ id: '/', name: 'AllotJar', short_name: 'AllotJar', start_url: '/login', scope: '/', display: 'standalone' })
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]),
  )
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  for (const src of [...manifest.icons.map((i: { src: string }) => i.src), touchIcon]) {
    const icon = await request.get(src)
    expect(icon.status(), src).toBe(200)
    expect(icon.headers()['content-type'], src).toBe('image/png')
  }
})

async function withWorker(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('zbb.theme', t), theme)
  await page.route('**/api/**', mockApi)
  await page.goto('/login')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
}

test('the service worker never answers an /api request', async ({ page }) => {
  const answered: string[] = []
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.fromServiceWorker()) answered.push(r.url())
  })
  await withWorker(page, 'light')
  const features = page.waitForResponse('**/api/features')
  await page.reload()
  await features
  expect(answered).toEqual([])
})

for (const theme of ['light', 'dark'] as const) {
  test(`the offline page shows when the network fails, and has no WCAG A/AA violations — ${theme}`, async ({ page, context }) => {
    await withWorker(page, theme)

    await context.setOffline(true)
    const response = await page.goto('/jars')
    expect(response?.fromServiceWorker()).toBe(true)
    await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible()
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
    expect(violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}`)).toEqual([])

    // "Try again" goes back to the page that failed, now that the network is back.
    await context.setOffline(false)
    await page.getByRole('link', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/(jars|login)/)
    await expect(page.getByRole('heading', { name: "You're offline" })).toHaveCount(0)
  })
}
