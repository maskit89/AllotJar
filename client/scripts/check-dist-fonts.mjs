// Fails the build if any font ended up as a data: URI in the built CSS: the CSP's font-src is
// 'self' only, so the browser would refuse it and fall back to a system font (see vite.config.ts).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'dist', 'assets')
const bad = readdirSync(dir)
  .filter((f) => f.endsWith('.css'))
  .filter((f) => /url\(\s*["']?data:(font|application\/(font|x-font|vnd\.ms-fontobject))/i.test(readFileSync(join(dir, f), 'utf8')))
if (bad.length > 0) {
  console.error(`Inlined data: font in ${bad.join(', ')}; the CSP (font-src 'self') would block it.`)
  process.exit(1)
}
console.log('check-dist-fonts: no inlined fonts')
