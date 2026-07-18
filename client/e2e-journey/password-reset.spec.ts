import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { register, uniqueEmail } from './helpers'

/**
 * REG-063 as a whole-stack journey: forgot-password → the actual emailed link (read back from the
 * Development mailbox, GET /api/dev/emails) → reset form → signed straight in — then the old
 * password is dead and the new one signs in. Only this layer proves the emailed link itself works:
 * the real token survives URL-encoding, email transport and the query-string round-trip into
 * POST /auth/reset-password over a live API.
 */
test('a forgotten password is recovered via the emailed link', async ({ page }) => {
  const email = uniqueEmail('reset')
  const { password: oldPassword } = await register(page, { email })
  const newPassword = `Aa1-${randomUUID()}`

  // Sign out server-side (revokes + clears the refresh cookie in the shared jar), then a full
  // navigation drops the in-memory token — a genuinely signed-out browser, like a user who
  // forgot their password would have.
  await page.request.post('/api/auth/logout')
  await page.goto('/login')

  // The login page's escape hatch → request a reset link.
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  await expect(page.getByRole('status')).toContainText('If an account exists')

  // Read the email a real recipient would have received and follow its link verbatim.
  const mailbox = await page.request.get(`/api/dev/emails?to=${encodeURIComponent(email)}`)
  const messages: Array<{ subject: string; textBody: string }> = await mailbox.json()
  expect(messages.length).toBeGreaterThan(0)
  expect(messages[0].subject).toContain('password')
  const link = messages[0].textBody
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('http') && l.includes('/reset-password?'))
  expect(link, 'the text body carries the reset link').toBeTruthy()

  await page.goto(link!)
  await expect(page.getByText(email)).toBeVisible() // the page names the account being reset
  await page.getByLabel('New password', { exact: true }).fill(newPassword)
  await page.getByLabel('Confirm new password').fill(newPassword)
  await page.getByRole('button', { name: 'Set new password' }).click()

  // A successful reset signs this device in — the empty-account dashboard renders.
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  // The reset revoked everything: sign out, then the old password is refused...
  await page.request.post('/api/auth/logout')
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(oldPassword)
  await page.locator('button[type="submit"]').click() // "Sign in" also names the segmented tab
  await expect(page.getByRole('alert')).toContainText('Invalid email or password')

  // ...and the new one signs in.
  await page.getByLabel('Password').fill(newPassword)
  await page.locator('button[type="submit"]').click()
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
})

/** The redeemed link is dead on arrival for a second visitor (single-use token). */
test('a redeemed reset link cannot be replayed', async ({ page }) => {
  const email = uniqueEmail('replay')
  await register(page, { email })
  await page.request.post('/api/auth/logout')

  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  await expect(page.getByRole('status')).toContainText('If an account exists')

  const mailbox = await page.request.get(`/api/dev/emails?to=${encodeURIComponent(email)}`)
  const messages: Array<{ textBody: string }> = await mailbox.json()
  const link = messages[0].textBody
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('http') && l.includes('/reset-password?'))!

  // First redemption succeeds and signs in.
  await page.goto(link)
  const firstNew = `Aa1-${randomUUID()}`
  await page.getByLabel('New password', { exact: true }).fill(firstNew)
  await page.getByLabel('Confirm new password').fill(firstNew)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  // Replaying the same link: generic invalid-link message + the way to a fresh one.
  await page.request.post('/api/auth/logout')
  await page.goto(link)
  const replayNew = `Aa1-${randomUUID()}`
  await page.getByLabel('New password', { exact: true }).fill(replayNew)
  await page.getByLabel('Confirm new password').fill(replayNew)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect(page.getByRole('alert')).toContainText('invalid or has expired')
  await expect(page.getByRole('button', { name: 'Request a new link' })).toBeVisible()
})
