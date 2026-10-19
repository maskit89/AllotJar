// AllotJar's service worker. It makes the site installable as an app and shows /offline.html
// when a page can't be reached. It deliberately does nothing else: it never answers or stores
// /api requests (every figure comes from the server), the app's scripts and styles, or other
// sites (fonts, analytics, Google sign-in), so no stale copy of the app is ever served from a cache.
// The worker's own fetches would also fall under the site's CSP, whose connect-src doesn't
// list Google Fonts, which is one more reason to leave other sites' requests alone.
//
// Rolling back: don't just delete this file. Browsers keep the worker they have when /sw.js
// stops being a script (IIS would answer it with index.html), so replace its body with
//   self.addEventListener('install', () => self.skipWaiting())
//   self.addEventListener('activate', (event) => event.waitUntil(self.registration.unregister()))
// and deploy; each browser drops the worker on its next visit.

// Bump the version when offline.html or theme-init.js changes: an unchanged sw.js is never
// reinstalled, so its copies of them are only fetched again when this file changes.
const CACHE = 'allotjar-offline-v1'
const OFFLINE_PAGE = '/offline.html'
// The offline page's own copy of the theme script (the saved light or dark choice), under an
// address of its own so the app's normal /theme-init.js requests never touch the worker.
const OFFLINE_THEME = '/theme-init.js?offline'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([new Request(OFFLINE_PAGE, { cache: 'reload' }), new Request(OFFLINE_THEME, { cache: 'reload' })]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (url.pathname + url.search === OFFLINE_THEME) {
    event.respondWith(caches.match(OFFLINE_THEME).then((cached) => cached || fetch(request)))
    return
  }

  // A page load: always from the network; the offline page only when the network fails.
  if (request.mode !== 'navigate') return
  event.respondWith(
    (async () => {
      // No navigation preload: it would also run for the /api navigations skipped above, and
      // the browser would then fetch those twice.
      try {
        return await fetch(request)
      } catch {
        return (await caches.match(OFFLINE_PAGE)) || Response.error()
      }
    })(),
  )
})
