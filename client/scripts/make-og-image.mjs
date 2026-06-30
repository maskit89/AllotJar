// One-off generator for the social share image (public/og/allotjar-og.png, 1200×630).
// Run with `node scripts/make-og-image.mjs` from the client/ directory; the PNG is
// committed as a static asset, so this is NOT part of the production build.
//
// Uses the Playwright Chromium that the a11y e2e tests already depend on. If the
// browser binary is missing, run `npx playwright install chromium` first.

import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const outDir = path.join(process.cwd(), 'public', 'og')
const outFile = path.join(outDir, 'allotjar-og.png')

// The brand coin-jar mark (viewBox 0 0 64 84), drawn for the dark hero gradient:
// brighter green body + gold lid and coin fill.
const jar = `
<svg width="250" height="328" viewBox="0 0 64 84" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 19L17 25C17 30 9 31 9 39L9 66A13 13 0 0 0 22 79L42 79A13 13 0 0 0 55 66L55 39C55 31 47 30 47 25L47 19Z" fill="#2e8b63"/>
  <path d="M9 48Q32 45 55 48L55 66A13 13 0 0 1 42 79L22 79A13 13 0 0 1 9 66Z" fill="#e8c36a"/>
  <rect x="13" y="14.5" width="38" height="5" rx="2.5" fill="#e8c36a"/>
  <rect x="15" y="3.5" width="34" height="12.5" rx="3.5" fill="#e8c36a"/>
  <rect x="16.5" y="4.8" width="31" height="2.6" rx="1.3" fill="#ffffff" opacity=".28"/>
</svg>`

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
        background: linear-gradient(135deg, #114a32, #1a6347 45%, #247e58);
        display: flex; align-items: center; gap: 56px; padding: 96px;
      }
      .left { flex: 1; }
      .brand { display: flex; align-items: center; gap: 16px; margin-bottom: 40px; }
      .brand-mark {
        width: 56px; height: 73px; display: flex; align-items: center; justify-content: center;
      }
      .brand-mark svg { width: 56px; height: 73px; }
      .wordmark { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; }
      .wordmark .jar { color: #e8c36a; }
      h1 { font-size: 92px; font-weight: 800; line-height: 1.02; letter-spacing: -0.035em; }
      .sub { margin-top: 28px; font-size: 34px; font-weight: 500; color: rgba(255,255,255,0.86); }
      .url {
        margin-top: 44px; display: inline-block; font-size: 26px; font-weight: 700;
        color: #114a32; background: #e8c36a; padding: 12px 22px; border-radius: 999px;
      }
      .right { flex-shrink: 0; filter: drop-shadow(0 24px 48px rgba(0,0,0,0.32)); }
    </style>
  </head>
  <body>
    <div class="left">
      <div class="brand">
        <span class="brand-mark">${jar.replace('width="250" height="328"', 'width="56" height="73"')}</span>
        <span class="wordmark">Allot<span class="jar">Jar</span></span>
      </div>
      <h1>Give every<br />euro a job.</h1>
      <p class="sub">Zero-based budgeting, built for Europe.</p>
      <span class="url">allotjar.com</span>
    </div>
    <div class="right">${jar}</div>
  </body>
</html>`

const browser = await chromium.launch()
try {
  await mkdir(outDir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400) // let the web font paint
  await page.screenshot({ path: outFile })
  console.log(`og image written: ${outFile}`)
} finally {
  await browser.close()
}
