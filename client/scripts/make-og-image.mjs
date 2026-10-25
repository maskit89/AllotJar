// One-off generator for the social share image (public/og/allotjar-og.png, 1200×630).
// Run with `node scripts/make-og-image.mjs` from the client/ directory; the PNG is
// committed as a static asset, so this is NOT part of the production build.
//
// The jar is the app icon's glass jar (`allotjar-app-icon.svg`, the Dashboard shelf's
// drawing), read straight from brand/, never redrawn: the showpiece is that jar without
// its tile, and the brand row is the favicon beside the wordmark, so the card matches
// the home-screen and tab icons. The gradient + gold pill use brand tokens.
//
// Bump ?v= on og:image and twitter:image in index.html whenever this picture changes:
// the PNG keeps its name and share previews cache it by URL.
//
// Uses the Playwright Chromium that the a11y e2e tests already depend on. If the
// browser binary is missing, run `npx playwright install chromium` first, or set
// PW_CHROMIUM to a Chromium executable to use instead.

import { chromium } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const brandDir = path.resolve(here, '..', '..', 'brand')
const outDir = path.join(process.cwd(), 'public', 'og')
const outFile = path.join(outDir, 'allotjar-og.png')

// Pull the actual production brand asset — do not redraw the jar here.
const [appIcon, favicon] = await Promise.all([
  readFile(path.join(brandDir, 'allotjar-app-icon.svg'), 'utf8'),
  readFile(path.join(brandDir, 'allotjar-favicon.svg'), 'utf8'),
])

// The jar alone: drop the app icon's two 160×160 tile rects (the green and its glow) and crop the
// view box to the jar group (translate(43.5,30) scale(1.14) of the 64×84 jar, shadow included).
const tile = /<rect x="0" y="0" width="160" height="160" rx="37" fill="url\(#(t|glow)\)"\/>/g
if ((appIcon.match(tile) ?? []).length !== 2) {
  throw new Error('allotjar-app-icon.svg changed: expected two 160×160 tile rects')
}
const jar = appIcon
  .replace(tile, '')
  .replace('viewBox="0 0 160 160" width="512" height="512"', 'viewBox="50 33 60 96"')
  .replace('aria-label="AllotJar app icon"', 'aria-hidden="true"')
// The brand row uses the favicon (the same jar, bigger on a tighter tile, so it reads at
// 56 px), as an image so its gradient ids don't clash with the jar's.
const iconSrc = `data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}`

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;700;800&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        width: 1200px; height: 630px; overflow: hidden;
        font-family: 'Hanken Grotesk', system-ui, sans-serif;
        color: #fff;
        /* Brand hero gradient — tokens: deep #15533A → green #1C6B49 → light #2C8059. */
        background: linear-gradient(135deg, #15533A, #1C6B49 45%, #2C8059);
        display: flex; align-items: center; gap: 56px; padding: 96px;
      }
      .left { flex: 1; min-width: 0; }
      /* Brand row: the favicon + the reversed wordmark (paper + #5FC093, brand/README §4). */
      .brand { margin-bottom: 40px; display: flex; align-items: center; gap: 16px; }
      .brand img { width: 56px; height: 56px; display: block; box-shadow: 0 0 0 1.5px rgba(255,255,255,0.18); border-radius: 12px; }
      .brand span { font-size: 40px; font-weight: 800; letter-spacing: -0.035em; color: #F4F6F3; }
      .brand span b { font-weight: 800; color: #5FC093; }
      h1 { font-size: 92px; font-weight: 800; line-height: 1.02; letter-spacing: -0.035em; }
      .sub { margin-top: 28px; font-size: 34px; font-weight: 500; color: rgba(255,255,255,0.86); }
      .url {
        margin-top: 44px; display: inline-block; font-size: 26px; font-weight: 700;
        color: #15533A; background: #D7A93E; padding: 12px 22px; border-radius: 999px;
      }
      /* The glass jar — the showpiece, with a soft gold glow behind it like the icon's. */
      .right {
        flex-shrink: 0; padding: 20px 28px;
        background: radial-gradient(closest-side, rgba(232,195,106,0.24), rgba(232,195,106,0));
        filter: drop-shadow(0 22px 40px rgba(0,0,0,0.28));
      }
      .right svg { height: 420px; width: auto; display: block; }
    </style>
  </head>
  <body>
    <div class="left">
      <div class="brand"><img src="${iconSrc}" alt="" /><span>Allot<b>Jar</b></span></div>
      <h1>Give every<br />euro a job.</h1>
      <p class="sub">Zero-based budgeting, in your currency.</p>
      <span class="url">allotjar.com</span>
    </div>
    <div class="right">${jar}</div>
  </body>
</html>`

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
try {
  await mkdir(outDir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400) // let the web font paint (wordmark)
  await page.screenshot({ path: outFile })
  console.log(`og image written: ${outFile}`)
} finally {
  await browser.close()
}
