/**
 * Registers the service worker (public/sw.js), which makes the site installable as an app and
 * shows /offline.html when a page can't load. It never touches /api, so figures always come
 * from the server. Production builds only: the dev server, and the e2e suites that run on it
 * and stub /api with Playwright routes, keep working without a worker in the way.
 */
export function registerServiceWorker(
  enabled: boolean = import.meta.env.PROD,
  nav: Navigator = navigator,
  win: Window = window,
): void {
  if (!enabled || !('serviceWorker' in nav)) return
  // After the page has loaded, so the worker's first install never competes with the app's
  // own first requests.
  const register = () => {
    nav.serviceWorker.register('/sw.js').catch(() => {
      // No worker (private mode, an old browser, a blocked script): the site works as before.
    })
  }
  if (win.document.readyState === 'complete') register()
  else win.addEventListener('load', register, { once: true })
}
