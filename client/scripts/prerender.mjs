// Build-time prerender of the public landing page.
//
// After `vite build` emits the SPA into dist/, this script builds a tiny SSR
// bundle of just the landing page, renders it to static HTML with
// renderToStaticMarkup, and injects it into dist/index.html. The result: the
// marketing copy (H1, value props, FAQ) is in the served HTML, so it is
// crawlable and visible without running our JavaScript. On load, the SPA mounts
// with createRoot and replaces the static markup — the static HTML carries no
// React hydration markers, so there is no hydration mismatch.
//
// It is deliberately NON-FATAL: any failure here logs a warning and leaves the
// CSR index.html intact, so a prerender problem can never break the production
// build or deploy. The static <head> SEO (title, description, Open Graph,
// JSON-LD) ships regardless.

import { build } from 'vite'
import { pathToFileURL } from 'node:url'
import { rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd() // client/ (npm runs scripts with the package dir as cwd)
const ssrOutDir = path.join(root, '.prerender')
const distIndex = path.join(root, 'dist', 'index.html')
const ROOT_MARKER = '<div id="root"></div>'

async function main() {
  // 1. Build a browser-less SSR bundle of the landing page, reusing the project's
  //    Vite config so JSX/Tailwind/aliases resolve exactly as in the app build.
  await build({
    root,
    logLevel: 'warn',
    build: {
      ssr: path.join(root, 'src/prerender/landing-entry.tsx'),
      outDir: ssrOutDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'landing-entry.mjs', format: 'esm' } },
    },
  })

  // 2. Render the landing page to a static HTML string.
  const mod = await import(pathToFileURL(path.join(ssrOutDir, 'landing-entry.mjs')).href)
  const appHtml = mod.render()
  if (!appHtml || appHtml.length < 100) {
    throw new Error('rendered landing markup was empty or suspiciously short')
  }

  // 3. Inject it into the built index.html.
  const html = await readFile(distIndex, 'utf8')
  if (!html.includes(ROOT_MARKER)) {
    throw new Error(`could not find "${ROOT_MARKER}" in dist/index.html`)
  }
  await writeFile(distIndex, html.replace(ROOT_MARKER, `<div id="root">${appHtml}</div>`))
  console.log(`prerender: injected landing page (${appHtml.length} chars) into dist/index.html`)
}

await main()
  .catch((err) => {
    console.warn('prerender: skipped, CSR index.html left intact —', err?.message ?? err)
  })
  .finally(() => rm(ssrOutDir, { recursive: true, force: true }).catch(() => {}))
