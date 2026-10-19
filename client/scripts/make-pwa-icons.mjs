// One-off generator for the installed-app icons the web app manifest and index.html use.
// Run with `node scripts/make-pwa-icons.mjs` from the client/ directory; the PNGs are
// committed as static assets (public/brand/png/ and brand/png/), so this is NOT part of
// the production build.
//
// Both come straight from brand/allotjar-app-icon.svg, never redrawn:
//   * allotjar-app-icon-192.png: the app icon as it is (the green squircle), for browsers
//     that show the icon unmasked. The 512 px one already exists.
//   * allotjar-app-icon-maskable-512.png / -maskable-180.png: the same art with the tile's
//     corners squared off, for platforms that cut their own shape out of it (Android's
//     "maskable" icons, the iPhone home screen). The jar already sits inside the central
//     safe zone (a circle 80% of the icon wide), so nothing else moves.
//
// Uses the Playwright Chromium the e2e tests already depend on. If the browser binary is
// missing, run `npx playwright install chromium` first.

import { chromium } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const brandDir = path.resolve(here, '..', '..', 'brand')
const outDirs = [path.join(process.cwd(), 'public', 'brand', 'png'), path.join(brandDir, 'png')]

const appIcon = await readFile(path.join(brandDir, 'allotjar-app-icon.svg'), 'utf8')

// The tile and its gloss are the two 160×160 rects with rx="37"; square both.
const tileCorners = /(<rect x="0" y="0" width="160" height="160") rx="37"/g
const squared = appIcon.replace(tileCorners, '$1 rx="0"')
if ((appIcon.match(tileCorners) ?? []).length !== 2) {
  throw new Error('allotjar-app-icon.svg changed: expected two 160×160 tile rects with rx="37"')
}

const icons = [
  { file: 'allotjar-app-icon-192.png', svg: appIcon, size: 192 },
  { file: 'allotjar-app-icon-maskable-512.png', svg: squared, size: 512 },
  { file: 'allotjar-app-icon-maskable-180.png', svg: squared, size: 180 },
]

const browser = await chromium.launch()
try {
  for (const dir of outDirs) await mkdir(dir, { recursive: true })
  for (const { file, svg, size } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const sized = svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`,
    )
    for (const dir of outDirs) {
      const out = path.join(dir, file)
      await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
      console.log(`icon written: ${out}`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
