import { describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from './serviceWorker'
import swSource from '../../public/sw.js?raw'

// --- registerServiceWorker ---------------------------------------------------------------

function fakeNavigator(register = vi.fn(() => Promise.resolve({}))) {
  return { nav: { serviceWorker: { register } } as unknown as Navigator, register }
}

function fakeWindow(readyState: DocumentReadyState) {
  const listeners: Record<string, () => void> = {}
  const win = {
    document: { readyState },
    addEventListener: vi.fn((type: string, cb: () => void) => (listeners[type] = cb)),
  } as unknown as Window
  return { win, fireLoad: () => listeners.load?.() }
}

describe('registerServiceWorker', () => {
  it('registers /sw.js once the page has loaded', () => {
    const { nav, register } = fakeNavigator()
    const { win, fireLoad } = fakeWindow('interactive')

    registerServiceWorker(true, nav, win)
    expect(register).not.toHaveBeenCalled()

    fireLoad()
    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('registers straight away when the page has already loaded', () => {
    const { nav, register } = fakeNavigator()
    registerServiceWorker(true, nav, fakeWindow('complete').win)
    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing outside a production build (the dev server and the e2e suites)', () => {
    const { nav, register } = fakeNavigator()
    registerServiceWorker(false, nav, fakeWindow('complete').win)
    expect(register).not.toHaveBeenCalled()
  })

  it('does nothing in a browser without service workers', () => {
    const { win } = fakeWindow('complete')
    expect(() => registerServiceWorker(true, {} as Navigator, win)).not.toThrow()
    expect(win.addEventListener).not.toHaveBeenCalled()
  })

  it('swallows a refused registration: the site works as before', async () => {
    const { nav } = fakeNavigator(vi.fn(() => Promise.reject(new Error('blocked'))))
    registerServiceWorker(true, nav, fakeWindow('complete').win)
    await Promise.resolve() // the rejection is handled, so nothing surfaces as unhandled
  })
})

// --- public/sw.js -------------------------------------------------------------------------
// The worker runs in the browser's service-worker scope; here it runs against stand-ins for
// that scope (self, caches, fetch, Request, Response), so its rules are checked one by one.

const ORIGIN = 'https://www.allotjar.com'

class FakeRequest {
  url: string
  method: string
  mode: string
  cache?: string
  constructor(input: string, init: { method?: string; mode?: string; cache?: string } = {}) {
    this.url = new URL(input, ORIGIN).href
    this.method = init.method ?? 'GET'
    this.mode = init.mode ?? 'cors'
    this.cache = init.cache
  }
}

function loadWorker({ online = true } = {}) {
  const handlers: Record<string, (event: unknown) => void> = {}
  const stored = new Map<string, unknown>()
  const deleted: string[] = []
  const cache = {
    addAll: vi.fn(async (requests: FakeRequest[]) => {
      for (const r of requests) stored.set(new URL(r.url).pathname + new URL(r.url).search, `copy of ${r.url}`)
    }),
  }
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['allotjar-offline-v0', 'allotjar-offline-v1', 'something-else']),
    delete: vi.fn(async (name: string) => deleted.push(name)),
    match: vi.fn(async (key: string) => stored.get(key)),
  }
  const network = vi.fn(async (request: FakeRequest) => {
    if (!online) throw new TypeError('Failed to fetch')
    return `network response for ${request.url}`
  })
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, cb: (event: unknown) => void) => (handlers[type] = cb),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
  }
  const ResponseStub = { error: () => 'network error response' }
  new Function('self', 'caches', 'fetch', 'Request', 'Response', swSource)(self, caches, network, FakeRequest, ResponseStub)

  async function lifecycle(type: 'install' | 'activate') {
    let pending: Promise<unknown> = Promise.resolve()
    handlers[type]({ waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
  }

  /** Dispatches a fetch; resolves to what the worker answered, or 'not handled'. */
  async function request(path: string, init: { method?: string; mode?: string; preload?: unknown } = {}) {
    let answer: Promise<unknown> | undefined
    handlers.fetch({
      request: new FakeRequest(path, init),
      preloadResponse: Promise.resolve(init.preload),
      respondWith: (p: Promise<unknown>) => (answer = p),
    })
    return answer ? await answer : 'not handled'
  }

  return { lifecycle, request, network, caches, stored, deleted, self }
}

describe('public/sw.js: what the service worker answers', () => {
  it('keeps the offline page and its theme script when it installs', async () => {
    const sw = loadWorker()
    await sw.lifecycle('install')
    expect([...sw.stored.keys()]).toEqual(['/offline.html', '/theme-init.js?offline'])
    expect(sw.self.skipWaiting).toHaveBeenCalled()
  })

  it('drops older caches, turns on navigation preload and takes over open pages when it activates', async () => {
    const sw = loadWorker()
    await sw.lifecycle('activate')
    expect(sw.deleted).toEqual(['allotjar-offline-v0', 'something-else'])
    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalled()
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })

  it('never answers an /api request, whatever kind it is', async () => {
    const sw = loadWorker()
    await sw.lifecycle('install')
    expect(await sw.request('/api/budget/2026/10')).toBe('not handled')
    expect(await sw.request('/api/transactions', { method: 'POST' })).toBe('not handled')
    expect(await sw.request('/api/auth/confirm?token=t', { mode: 'navigate' })).toBe('not handled')
  })

  it("leaves other sites and the app's own scripts and styles to the browser", async () => {
    const sw = loadWorker()
    await sw.lifecycle('install')
    expect(await sw.request('https://fonts.googleapis.com/css2?family=Hanken+Grotesk')).toBe('not handled')
    expect(await sw.request('https://accounts.google.com/gsi/client', { mode: 'navigate' })).toBe('not handled')
    expect(await sw.request('/assets/index-abc123.js')).toBe('not handled')
    expect(await sw.request('/theme-init.js')).toBe('not handled')
  })

  it('loads every page from the network while online', async () => {
    const sw = loadWorker()
    await sw.lifecycle('install')
    expect(await sw.request('/jars', { mode: 'navigate' })).toBe(`network response for ${ORIGIN}/jars`)
  })

  it('uses the navigation preload when the browser started one', async () => {
    const sw = loadWorker()
    expect(await sw.request('/', { mode: 'navigate', preload: 'preloaded page' })).toBe('preloaded page')
    expect(sw.network).not.toHaveBeenCalled()
  })

  it('shows the offline page only when the network fails', async () => {
    const sw = loadWorker({ online: false })
    await sw.lifecycle('install')
    expect(await sw.request('/accounts/acc1', { mode: 'navigate' })).toBe(`copy of ${ORIGIN}/offline.html`)
  })

  it('never answers a form post', async () => {
    const sw = loadWorker({ online: false })
    await sw.lifecycle('install')
    expect(await sw.request('/login', { mode: 'navigate', method: 'POST' })).toBe('not handled')
  })

  it("serves the offline page's theme script from its copy", async () => {
    const sw = loadWorker({ online: false })
    await sw.lifecycle('install')
    expect(await sw.request('/theme-init.js?offline')).toBe(`copy of ${ORIGIN}/theme-init.js?offline`)
  })
})
