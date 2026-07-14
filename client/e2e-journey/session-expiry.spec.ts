import { expect, request, test } from '@playwright/test'
import { JOURNEY_PASSWORD, register } from './helpers'

/**
 * Mid-session expiry — the one flow no stubbed suite can exercise: a signed-in tab whose session
 * dies server-side must be bounced to /login with a clear reason and brought back to where it
 * was after signing in again. Covers the real 401 → refresh → sessionExpired() chain, the
 * security-stamp rotation on logout, and the revoke-all-on-password-change behaviour.
 */

test('a tab whose session was revoked is prompted to sign in and returns to where it was', async ({ page }) => {
  const { email, password } = await register(page)

  // Kill the session server-side exactly as expiry/revocation would: revoke the refresh token
  // AND rotate the security stamp (the new logout behaviour), so the tab's in-memory access
  // token is dead too — not just quietly waiting out its 15-minute lifetime.
  const logout = await page.request.post('/api/auth/logout')
  expect(logout.status()).toBe(204)

  // The tab still LOOKS signed in (in-memory state). Its next data-bearing navigation must
  // discover the dead session and bounce to /login, keeping the destination in returnUrl.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page).toHaveURL(/\/login\?reason=expired&returnUrl=%2Ftransactions/)
  await expect(page.getByText('Your session has expired')).toBeVisible()

  // Signing back in lands on the page they were headed to, not the dashboard.
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/transactions$/)
  await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible()
})

test('changing the password signs out other devices but keeps the changing device signed in', async ({ page, baseURL }) => {
  const { email, password } = await register(page)
  const newPassword = `${JOURNEY_PASSWORD}-rot8`

  // "Another device": a separate cookie jar that signs in over the raw API and changes the
  // password. This must end the session everywhere else (all refresh tokens revoked + stamp
  // rotated) while its own session carries on with the fresh cookie from the response.
  const deviceB = await request.newContext({ baseURL })
  const loginB = await deviceB.post('/api/auth/login', { data: { email, password } })
  expect(loginB.status()).toBe(200)
  const { token: tokenB } = (await loginB.json()) as { token: string }

  const change = await deviceB.post('/api/auth/change-password', {
    data: { currentPassword: password, newPassword },
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  expect(change.status()).toBe(200)

  // Device A (the browser tab): its access token died with the stamp rotation and its refresh
  // token was revoked — the next navigation must prompt sign-in, not fail silently.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page).toHaveURL(/\/login\?reason=expired/)
  await expect(page.getByText('Your session has expired')).toBeVisible()

  // A's stale cookie checking back in must NOT have tripped the theft response against B:
  // device B's rotated cookie still refreshes fine.
  const refreshB = await deviceB.post('/api/auth/refresh')
  expect(refreshB.status()).toBe(200)

  // And device A signs back in with the NEW password.
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(newPassword)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/transactions$/)

  await deviceB.dispose()
})
