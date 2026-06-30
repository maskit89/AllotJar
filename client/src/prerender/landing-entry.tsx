import { renderToStaticMarkup } from 'react-dom/server'
import { LandingPage } from '../pages/LandingPage'

/**
 * Build-time entry for prerendering the public landing page to static HTML
 * (see scripts/prerender.mjs). Runs in Node — no browser — so LandingPage must
 * stay self-contained and SSR-safe (no router context, browser globals or effects).
 */
export function render(): string {
  return renderToStaticMarkup(<LandingPage />)
}
