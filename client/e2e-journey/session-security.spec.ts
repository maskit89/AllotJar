import { randomUUID } from 'node:crypto'
import { expect, request, test, type APIRequestContext } from '@playwright/test'
import { JOURNEY_PASSWORD, register, uniqueEmail } from './helpers'

/**
 * Security-functional behaviours that need the whole real stack (the SEC deferred set):
 * account lockout + the failed-attempt counter reset, anti-enumeration, cross-household
 * owner-scoping probes (IDOR), invite-link single-use enforcement, the server-side password
 * composition boundary, and the UI-driven change-password revoke-everywhere flow.
 *
 * Deliberately NOT duplicated here:
 *  - session-expiry.spec.ts owns the revoked-tab bounce and the API-driven password change
 *    (device B changes, the browser is the victim). This file drives the change from the
 *    BROWSER's /account card instead (success copy, client apply(), reload survival) with an
 *    API session as the victim — the two specs cover opposite directions of SEC-017/SESS-040.
 *  - concurrent-refresh.spec.ts owns refresh rotation + the 30s replay grace (SEC-015/016).
 *  - The auth 429 (SEC-005) CANNOT be journey-tested: this harness raises
 *    RateLimiting__AuthPermitLimit to 1000 precisely so serial runs never trip it.
 */

/** Bearer-token header for raw data-endpoint calls (the SPA holds the JWT in memory only). */
function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Register a fresh user over the raw API (no UI) and return their email, token and context. */
async function apiRegister(
  baseURL: string,
  prefix: string,
  opts: { starterBudget?: boolean } = {},
): Promise<{ ctx: APIRequestContext; email: string; token: string }> {
  const ctx = await request.newContext({ baseURL })
  const email = uniqueEmail(prefix)
  const res = await ctx.post('/api/auth/register', {
    data: {
      email,
      password: JOURNEY_PASSWORD,
      firstName: 'Sec',
      lastName: 'Journey',
      acceptedTerms: true,
    },
  })
  expect(res.status()).toBe(200)
  const { token } = (await res.json()) as { token: string }
  if (opts.starterBudget) {
    // Registration seeds nothing (rule 81): build the current month from the Essentials
    // template so the household owns a real month with a "Take-home Pay" line.
    const now = new Date()
    const created = await ctx.post('/api/budget', {
      headers: auth(token),
      data: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, copyFromPrevious: false, templateKey: 'essentials' },
    })
    expect(created.status()).toBe(201)
  }
  return { ctx, email, token }
}

/** POST /auth/login and return the response (no assertions — callers check the outcome). */
function apiLogin(ctx: APIRequestContext, email: string, password: string) {
  return ctx.post('/api/auth/login', { data: { email, password } })
}

test('five wrong passwords lock the account (no correct-password bypass), and a success resets the counter', async ({
  page,
  baseURL,
}) => {
  const { ctx, email } = await apiRegister(baseURL!, 'lockout')

  // SEC-003 — no account enumeration: an unknown email and a wrong password for a real
  // account return byte-identical 401 bodies; the unknown-email path never says "no such
  // account". (This wrong attempt is also recorded as lockout failure #1.)
  const unknown = await apiLogin(ctx, uniqueEmail('ghost'), 'Wrong-Pass1')
  const wrong = await apiLogin(ctx, email, 'Wrong-Pass1')
  expect(unknown.status()).toBe(401)
  expect(wrong.status()).toBe(401)
  expect(await unknown.text()).toBe(await wrong.text())
  expect(((await wrong.json()) as { error: string }).error).toBe('Invalid email or password.')

  // SEC-001 — failures 2-4 are still the generic refusal (under the 5-attempt threshold).
  for (let attempt = 2; attempt <= 4; attempt++) {
    const res = await apiLogin(ctx, email, 'Wrong-Pass1')
    expect(res.status()).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('Invalid email or password.')
  }

  // SEC-001 — the 5th failure crosses MaxFailedAccessAttempts: the login form surfaces the
  // distinct lockout copy, not the generic error.
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('Wrong-Pass1')
  await page.locator('button[type="submit"]').click()
  await expect(page.getByRole('alert')).toContainText(
    'Your account is temporarily locked after too many failed sign-in attempts.',
  )

  // SEC-001 — the CORRECT password does not bypass the lock (IsLockedOut is checked before
  // the password verify) and no token is ever issued while locked: still on /login.
  await page.getByLabel('Password').fill(JOURNEY_PASSWORD)
  const denied = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.status() === 401,
  )
  await page.locator('button[type="submit"]').click()
  await denied
  await expect(page.getByRole('alert')).toContainText('temporarily locked')
  await expect(page).toHaveURL(/\/login/)

  // SEC-002 — a success BEFORE the threshold resets the failed-attempt counter (fresh user:
  // the locked one above stays locked for 15 minutes). 4 failures + success + 4 more failures
  // never lock — if the pre-success failures carried over, the 5th cumulative wrong attempt
  // below would return the lockout copy and the final correct sign-in would be refused.
  const { ctx: ctx2, email: email2 } = await apiRegister(baseURL!, 'counter-reset')
  for (let attempt = 1; attempt <= 4; attempt++) {
    expect((await apiLogin(ctx2, email2, 'Wrong-Pass1')).status()).toBe(401)
  }
  expect((await apiLogin(ctx2, email2, JOURNEY_PASSWORD)).status()).toBe(200)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await apiLogin(ctx2, email2, 'Wrong-Pass1')
    expect(res.status()).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('Invalid email or password.')
  }
  expect((await apiLogin(ctx2, email2, JOURNEY_PASSWORD)).status()).toBe(200)

  await ctx2.dispose()
  await ctx.dispose()
})

test("another household's resources are invisible: 404 on read, 403 on write, and the UI never leaks", async ({
  page,
  baseURL,
}) => {
  // The victim household: given a template month so it owns a real budget month, plus an
  // account created over the API.
  const victim = await apiRegister(baseURL!, 'victim', { starterBudget: true })
  const created = await victim.ctx.post('/api/accounts', {
    headers: auth(victim.token),
    data: { name: 'Secret Savings', type: 1, currency: 'EUR', openingBalance: 1234.56, openingDate: '2026-01-01' },
  })
  expect(created.status()).toBe(201)
  const { id: victimAccountId } = (await created.json()) as { id: string }

  // The month the victim owns (newest first) — probed by exact year/month below.
  const monthsRes = await victim.ctx.get('/api/budget/months', { headers: auth(victim.token) })
  expect(monthsRes.status()).toBe(200)
  const [{ year, month }] = (await monthsRes.json()) as { year: number; month: number }[]

  // The prober: a fresh browser user with an EMPTY budget (so the probed month can only be
  // the victim's), plus a raw API session for the direct probes.
  const { email, password } = await register(page)
  const prober = await request.newContext({ baseURL: baseURL! })
  const login = await apiLogin(prober, email, password)
  expect(login.status()).toBe(200)
  const { token } = (await login.json()) as { token: string }

  // SEC-021 — read probe: the month exists (the victim reads it fine, template income line and
  // all), but for the prober the OwnerId predicate makes it simply not exist → 404, and the
  // response reveals none of the victim's data.
  const victimView = await victim.ctx.get(`/api/budget/${year}/${month}`, {
    headers: auth(victim.token),
  })
  expect(victimView.status()).toBe(200)
  expect(await victimView.text()).toContain('Take-home Pay')

  const read = await prober.get(`/api/budget/${year}/${month}`, { headers: auth(token) })
  expect(read.status()).toBe(404)
  const readBody = await read.text()
  expect(readBody).toContain('No budget found')
  expect(readBody).not.toContain('Take-home Pay')

  // SEC-021 — list scoping: the prober's account list never includes the foreign account.
  const list = await prober.get('/api/accounts', { headers: auth(token) })
  expect(list.status()).toBe(200)
  expect(await list.text()).not.toContain('Secret Savings')

  // SEC-022 — write probes: a real id that exists-but-isn't-yours is 403 (rename AND delete);
  // a truly-nonexistent id is 404. The 403/404 split is by design on the write path.
  const rename = await prober.put(`/api/accounts/${victimAccountId}`, {
    headers: auth(token),
    data: { name: 'Hijacked', type: 1, openingBalance: 0, openingDate: '2026-01-01' },
  })
  expect(rename.status()).toBe(403)
  expect(await rename.text()).not.toContain('Secret Savings')

  const del = await prober.delete(`/api/accounts/${victimAccountId}`, { headers: auth(token) })
  expect(del.status()).toBe(403)

  // (The literal all-zeros GUID is refused earlier still — 400 from the command validator's
  // NotEmpty(Id) rule — so a random unknown id is what exercises the not-found path.)
  const missing = await prober.put(`/api/accounts/${randomUUID()}`, {
    headers: auth(token),
    data: { name: 'Hijacked', type: 1, openingBalance: 0, openingDate: '2026-01-01' },
  })
  expect(missing.status()).toBe(404)

  // SEC-021 — the UI never leaks: deep-linking the foreign account id in the prober's
  // browser renders the not-found empty state, never the account's name or balance.
  await page.goto(`/accounts/${victimAccountId}`)
  await expect(page.getByText('Account not found')).toBeVisible()
  await expect(page.getByText('Secret Savings')).toHaveCount(0)

  // SEC-022 — the probes changed nothing: the victim's account survives, name intact.
  const after = await victim.ctx.get('/api/accounts', { headers: auth(victim.token) })
  expect(after.status()).toBe(200)
  const accounts = (await after.json()) as { id: string; name: string }[]
  expect(accounts.some((a) => a.id === victimAccountId && a.name === 'Secret Savings')).toBe(true)

  await prober.dispose()
  await victim.ctx.dispose()
})

test('an invite link is strictly single-use: the second redemption fails cleanly and reveals nothing', async ({
  page,
  baseURL,
}) => {
  // The owner mints a one-time LINK invite over the API (the UI minting + happy accept flow
  // is invite.spec.ts's — this journey is about what happens AFTER the one allowed use).
  const owner = await apiRegister(baseURL!, 'inviter')
  const inviteeEmail = uniqueEmail('single-use')
  const invite = await owner.ctx.post('/api/access/invite', {
    headers: auth(owner.token),
    data: {
      email: inviteeEmail,
      role: 2, // Limited
      method: 1, // Link
      tempPassword: null,
      displayName: 'Robin',
      memberId: null,
    },
  })
  expect(invite.status()).toBe(200)
  const { inviteToken } = (await invite.json()) as { inviteToken: string }
  expect(inviteToken).toBeTruthy()

  // SEC-025 — the one allowed redemption: an anonymous accept that sets a password. On
  // success the stored token hash is cleared, so nothing matches this link ever again.
  const redeemer = await request.newContext({ baseURL: baseURL! })
  const first = await redeemer.post('/api/auth/accept-invite', {
    data: { token: inviteToken, password: JOURNEY_PASSWORD, displayName: 'Robin', acceptedTerms: true },
  })
  expect(first.status()).toBe(200)

  // SEC-025 — a second redemption of the SAME link through the real accept page fails with
  // the exact catalog copy and leaves the visitor signed out on /accept-invite.
  await page.goto(`/accept-invite?code=${inviteToken}`)
  await expect(page.getByRole('heading', { name: 'Join the household' })).toBeVisible()
  await page.getByLabel('Password').fill(JOURNEY_PASSWORD)
  await page.locator('label', { hasText: 'I agree to the' }).getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Accept invite' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'This invite link is invalid or has already been used.',
  )
  await expect(page).toHaveURL(/\/accept-invite\?code=/)

  // SEC-025 — a used link and a tampered/unknown token are indistinguishable: identical 404
  // bodies, so a replayed link is no oracle for whether the token was ever real.
  const usedAgain = await redeemer.post('/api/auth/accept-invite', {
    data: { token: inviteToken, password: JOURNEY_PASSWORD, acceptedTerms: true },
  })
  const tampered = await redeemer.post('/api/auth/accept-invite', {
    data: { token: `tampered-${inviteToken}`, password: JOURNEY_PASSWORD, acceptedTerms: true },
  })
  expect(usedAgain.status()).toBe(404)
  expect(tampered.status()).toBe(404)
  expect(await usedAgain.text()).toBe(await tampered.text())

  // The failed replays disturbed nothing: the invitee's redeemed login still signs in.
  expect((await apiLogin(redeemer, inviteeEmail, JOURNEY_PASSWORD)).status()).toBe(200)

  await redeemer.dispose()
  await owner.ctx.dispose()
})

test('changing the password from the account page keeps this device signed in and revokes every other session', async ({
  page,
  baseURL,
}) => {
  const { email, password } = await register(page)

  // "Device B": an independent signed-in session (its own cookie jar + bearer token),
  // established BEFORE the change so it holds pre-change credentials.
  const deviceB = await request.newContext({ baseURL: baseURL! })
  const loginB = await apiLogin(deviceB, email, password)
  expect(loginB.status()).toBe(200)
  const { token: tokenB } = (await loginB.json()) as { token: string }
  expect((await deviceB.get('/api/auth/me', { headers: auth(tokenB) })).status()).toBe(200)

  await page.goto('/account')

  // SEC-010 — the SERVER composition policy is the security boundary, not the client's
  // minLength: an 8+-char all-lowercase password passes every client check, is actually
  // sent, and comes back 400 with the Identity errors surfaced in the card.
  await page.getByLabel('Current password').fill(password)
  await page.getByLabel('New password', { exact: true }).fill('sunflowerpasture')
  await page.getByLabel('Confirm new password').fill('sunflowerpasture')
  const rejected = page.waitForResponse(
    (r) => r.url().includes('/api/auth/change-password') && r.status() === 400,
  )
  await page.getByRole('button', { name: 'Change password' }).click()
  await rejected
  await expect(page.getByRole('alert')).toContainText('at least one digit')

  // SEC-010 / SEC-009 (side-effect contract) — a FAILED change revokes nothing: device B's
  // cookie still refreshes and the changing tab is still signed in on /account.
  expect((await deviceB.post('/api/auth/refresh')).status()).toBe(200)
  await expect(page).toHaveURL(/\/account$/)

  // SESS-040 / SEC-017 — now the real change, driven through the UI card (session-expiry.
  // spec.ts covers the API-driven direction). The 200 AuthResponse is applied client-side.
  const newPassword = `${JOURNEY_PASSWORD}-uikeep`
  await page.getByLabel('Current password').fill(password)
  await page.getByLabel('New password', { exact: true }).fill(newPassword)
  await page.getByLabel('Confirm new password').fill(newPassword)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your password has been changed.')).toBeVisible()

  // SESS-040 — the changing device carries on seamlessly: a hard reload drops the in-memory
  // token and rebuilds the session from the ROTATED cookie (a burned family or a missed
  // apply() would bounce to /login), and in-app navigation keeps working.
  await page.reload()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible()

  // SEC-017 — device B died with the change: its refresh token was revoked (401, RevokeAll)
  // and its bearer fails the security-stamp check NOW, not at the JWT's natural expiry.
  expect((await deviceB.post('/api/auth/refresh')).status()).toBe(401)
  expect((await deviceB.get('/api/auth/me', { headers: auth(tokenB) })).status()).toBe(401)

  // SEC-017 — the old password is dead everywhere; only the new one signs in.
  const probe = await request.newContext({ baseURL: baseURL! })
  const oldPw = await apiLogin(probe, email, password)
  expect(oldPw.status()).toBe(401)
  expect(((await oldPw.json()) as { error: string }).error).toBe('Invalid email or password.')
  expect((await apiLogin(probe, email, newPassword)).status()).toBe(200)

  await probe.dispose()
  await deviceB.dispose()
})
