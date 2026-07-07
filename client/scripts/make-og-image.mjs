// One-off generator for the social share image (public/og/allotjar-og.png, 1200×630).
// Run with `node scripts/make-og-image.mjs` from the client/ directory; the PNG is
// committed as a static asset, so this is NOT part of the production build.
//
// Brand rule (brand/README §2): the OG card is a large feature moment, so it uses
// the **realistic** mark (`allotjar-mark.svg`) as the showpiece and the ready-made
// **reversed lockup** (`allotjar-lockup-reversed.svg`) for the brand row — both read
// straight from brand/, never hand-drawn. The gradient + gold pill use brand tokens.
//
// Uses the Playwright Chromium that the a11y e2e tests already depend on. If the
// browser binary is missing, run `npx playwright install chromium` first.

import { chromium } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const brandDir = path.resolve(here, '..', '..', 'brand')
const outDir = path.join(process.cwd(), 'public', 'og')
const outFile = path.join(outDir, 'allotjar-og.png')

// Pull the actual production brand assets — do not redraw the jar here.
const [realisticMark, reversedLockup] = await Promise.all([
  readFile(path.join(brandDir, 'allotjar-mark.svg'), 'utf8'),
  readFile(path.join(brandDir, 'allotjar-lockup-reversed.svg'), 'utf8'),
])

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
      /* Reversed lockup (flat mark + "AllotJar" wordmark, paper + #5FC093). */
      .brand { margin-bottom: 40px; }
      .brand svg { height: 46px; width: auto; display: block; }
      h1 { font-size: 92px; font-weight: 800; line-height: 1.02; letter-spacing: -0.035em; }
      .sub { margin-top: 28px; font-size: 34px; font-weight: 500; color: rgba(255,255,255,0.86); }
      .url {
        margin-top: 44px; display: inline-block; font-size: 26px; font-weight: 700;
        color: #15533A; background: #D7A93E; padding: 12px 22px; border-radius: 999px;
      }
      /* Realistic mark — the showpiece. Sized by height so the drop coin + cast
         shadow (viewBox 0 -13 64 101) stay in frame; CSS overrides its width/height. */
      .right { flex-shrink: 0; filter: drop-shadow(0 22px 44px rgba(0,0,0,0.34)); }
      .right svg { height: 404px; width: auto; display: block; }
    </style>
  </head>
  <body>
    <div class="left">
      <div class="brand">${reversedLockup}</div>
      <h1>Give every<br />euro a job.</h1>
      <p class="sub">Zero-based budgeting, in your currency.</p>
      <span class="url">allotjar.com</span>
    </div>
    <div class="right">${realisticMark}</div>
  </body>
</html>`

const browser = await chromium.launch()
try {
  await mkdir(outDir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400) // let the web font paint (wordmark + drop-coin €)
  await page.screenshot({ path: outFile })
  console.log(`og image written: ${outFile}`)
} finally {
  await browser.close()
}
