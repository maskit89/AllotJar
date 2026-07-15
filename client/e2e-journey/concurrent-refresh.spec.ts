import { expect, request, test } from '@playwright/test'
import { JOURNEY_PASSWORD, uniqueEmail } from './helpers'

/**
 * Concurrent cold-load refresh — a browser restoring several app tabs fires simultaneous
 * /api/auth/refresh calls with the SAME cookie (the client single-flight is per-tab only).
 * The losers present a just-rotated token; the server must treat that as a race, not theft:
 * no family burn, and the loser's 401 must not carry a cookie deletion that would wipe the
 * winner's fresh cookie out of the browser's shared jar.
 */

/** The zbb_rt value a response sets, or null when it doesn't touch the refresh cookie. */
function refreshCookieFrom(headers: { name: string; value: string }[]): string | null {
  const header = headers.find(
    (h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('zbb_rt='),
  )
  return header ? header.value.slice('zbb_rt='.length).split(';', 1)[0] : null
}

/** POST /auth/refresh from a pristine cookie jar, presenting exactly the given cookie value. */
async function postRefresh(baseURL: string, cookie: string) {
  const ctx = await request.newContext({ baseURL })
  try {
    const res = await ctx.post('/api/auth/refresh', { headers: { cookie: `zbb_rt=${cookie}` } })
    return { status: res.status(), setCookie: refreshCookieFrom(res.headersArray()) }
  } finally {
    await ctx.dispose()
  }
}

test('two tabs racing refresh with one cookie: loser refused, winner survives, no burn', async () => {
  const baseURL = test.info().project.use.baseURL!

  // Register API-side — all this journey needs is the session cookie, not the UI.
  const ctx = await request.newContext({ baseURL })
  const reg = await ctx.post('/api/auth/register', {
    data: {
      email: uniqueEmail('refresh-race'),
      password: JOURNEY_PASSWORD,
      firstName: 'Refresh',
      lastName: 'Race',
      acceptedTerms: true,
    },
  })
  expect(reg.status()).toBe(200)
  const original = refreshCookieFrom(reg.headersArray())
  expect(original).toBeTruthy()
  await ctx.dispose()

  // Tab 1 wins the race: the cookie rotates to a fresh value.
  const winner = await postRefresh(baseURL, original!)
  expect(winner.status).toBe(200)
  expect(winner.setCookie).toBeTruthy()
  expect(winner.setCookie).not.toBe(original)

  // Tab 2 presents the same, now-rotated cookie moments later. It is refused — but the 401
  // must NOT touch the cookie: a deletion here would evict tab 1's fresh cookie from the
  // shared jar and sign tab 1 out too when its access token expires.
  const loser = await postRefresh(baseURL, original!)
  expect(loser.status).toBe(401)
  expect(loser.setCookie).toBeNull()

  // And no theft response fired: the winner's rotated cookie still refreshes fine.
  const stillAlive = await postRefresh(baseURL, winner.setCookie!)
  expect(stillAlive.status).toBe(200)
})
