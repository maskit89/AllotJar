import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { suppressOnboarding, uniqueEmail } from './helpers'

/**
 * Google sign-in as a whole-stack journey. Real Google needs an interactive consent screen no
 * harness can automate, so the API runs the Development-only fake validator
 * (Google__UseFakeValidator, set in playwright.journey.config.ts) which accepts
 * fake-google:{json} credentials. The credential is POSTed via page.request — sharing the
 * browser's cookie jar, the same idiom the password-reset journey uses — so this exercises the
 * ONE thing only this layer can: the real zbb_rt cookie issued by /auth/google surviving a full
 * page load through the client's cold-boot session restore, the deferred-consent ConsentModal,
 * and the passwordless account page. (The button's own rendering is covered at the Vitest layer.)
 */

function fakeCredential(sub: string, email: string, opts: { emailVerified?: boolean } = {}): string {
  return `fake-google:${JSON.stringify({
    sub,
    email,
    emailVerified: opts.emailVerified ?? true,
    givenName: 'Journey',
    familyName: 'Google',
  })}`
}

test('a first Google sign-in creates a passwordless account and must accept terms', async ({ page }) => {
  const email = uniqueEmail('google')
  const sub = `g-${randomUUID()}`
  await suppressOnboarding(page, email)

  // Exchange a Google credential for a session (sets the zbb_rt cookie in the shared jar).
  const res = await page.request.post('/api/auth/google', { data: { credential: fakeCredential(sub, email) } })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  expect(body.isNewAccount).toBe(true)

  // A full navigation drops any in-memory token; the client must restore the session from the
  // cookie alone (the real cold-boot path) and land signed in.
  await page.goto('/')

  // Deferred consent: a Google-created account never saw the Terms checkbox, so the blocking
  // ConsentModal must appear before the app is usable.
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Accept the terms')).toBeVisible()
  await dialog.getByRole('button', { name: 'I agree' }).click()
  await expect(dialog).toBeHidden()

  // Signed in on an empty account: the create-month hero is the landing (no sample budget).
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  // The account is passwordless: the account page offers "add a password", not "change password".
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Password', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0)
  // The Sign-in card's Password row offers "Set a password", a link to the forgot-password flow
  // (which sets one for a passwordless login). The Google row's Disconnect, behind its ⋯, is
  // disabled with the reason, and holds no link.
  const setPassword = page.getByRole('link', { name: 'Set a password' })
  await expect(setPassword).toBeVisible()
  await expect(setPassword).toHaveAttribute('href', '/forgot-password')
})

test('a returning Google user keys on the sub and skips consent the second time', async ({ page }) => {
  const email = uniqueEmail('google-return')
  const sub = `g-${randomUUID()}`
  await suppressOnboarding(page, email)

  // First sign-in + accept terms.
  const first = await page.request.post('/api/auth/google', { data: { credential: fakeCredential(sub, email) } })
  const firstUserId = (await first.json()).userId as string
  await page.goto('/')
  await page.getByRole('dialog').getByRole('button', { name: 'I agree' }).click()
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  // Sign out, then sign in again with the SAME Google sub but a CHANGED email (as after a
  // Google-side address change) — must land in the same account, no fresh consent.
  await page.request.post('/api/auth/logout')
  const second = await page.request.post('/api/auth/google', {
    data: { credential: fakeCredential(sub, uniqueEmail('google-changed')) },
  })
  const secondBody = await second.json()
  expect(secondBody.isNewAccount).toBe(false)
  expect(secondBody.userId).toBe(firstUserId)

  await page.goto('/')
  // Consent was already given — no modal this time.
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
})
