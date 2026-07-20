import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { register, uniqueEmail } from './helpers'

/**
 * Email verification + safe reclaim as whole-stack journeys. The verification/reclaim emails go to
 * the Development mailbox (GET /api/dev/emails); sends are off-request so the mailbox is polled.
 * The unique whole-stack pieces here: the persistent in-app banner while unverified, confirming via
 * the REAL emailed link (token survives URL-encoding + transport), and the reclaim of a squatted
 * unverified account through the register->claim-link->reset chain over a live API.
 */

async function waitForLink(page: Page, email: string, pathMarker: string): Promise<string> {
  let link: string | undefined
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/dev/emails?to=${encodeURIComponent(email)}`)
        const messages: Array<{ textBody: string }> = await res.json()
        link = messages
          .flatMap((m) => m.textBody.split('\n'))
          .map((l) => l.trim())
          .find((l) => l.startsWith('http') && l.includes(pathMarker))
        return link ?? ''
      },
      { message: `email containing ${pathMarker}`, timeout: 10_000 },
    )
    .not.toBe('')
  return link!
}

test('a new registration is unverified with a banner, and the emailed link confirms it', async ({ page }) => {
  const email = uniqueEmail('verify')
  // register() lands on the dashboard (empty account). The banner must be present + persistent.
  await register(page, { email })

  const banner = page.getByText(/please confirm your email/i)
  await expect(banner).toBeVisible()
  // Persists across navigation (it lives in the app shell).
  await page.goto('/account')
  await expect(page.getByText(/please confirm your email/i)).toBeVisible()

  // Follow the REAL confirmation link from the mailbox.
  const link = await waitForLink(page, email, '/confirm-email?')
  await page.goto(link)
  await expect(page.getByText('Email confirmed')).toBeVisible()

  // Back in the app, the banner is gone (a fresh /auth/me now reports confirmed).
  await page.goto('/')
  await expect(page.getByText(/please confirm your email/i)).toHaveCount(0)
})

test('registering an unverified email emails a claim link that takes the account over', async ({ page }) => {
  const email = uniqueEmail('reclaim')

  // A first (unverified) registration — the "squatter". register() signs them in; sign out.
  const { password: squatterPassword } = await register(page, { email })
  await page.request.post('/api/auth/logout')

  // The true owner registers the SAME email → the "check your inbox" claim panel, no session.
  await page.goto('/login?register=1')
  await page.getByLabel('First name').fill('Owner')
  await page.getByLabel('Last name').fill('Real')
  await page.getByLabel('Email').fill(email)
  const ownerPassword = `Aa1-${randomUUID()}`
  await page.getByLabel('Password').fill(ownerPassword)
  await page.locator('label', { hasText: 'I agree to the' }).getByRole('checkbox').check()
  await page.locator('button[type="submit"]').click()
  await expect(page.getByText('Check your inbox')).toBeVisible()

  // Redeem the emailed claim (reset) link → set the owner's password → signed in + confirmed.
  const link = await waitForLink(page, email, '/reset-password?')
  await page.goto(link)
  await page.getByLabel('New password', { exact: true }).fill(ownerPassword)
  await page.getByLabel('Confirm new password').fill(ownerPassword)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  // Reclaim confirmed the email — no banner.
  await expect(page.getByText(/please confirm your email/i)).toHaveCount(0)

  // The squatter is locked out: their password no longer works.
  await page.request.post('/api/auth/logout')
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(squatterPassword)
  await page.locator('button[type="submit"]').click()
  await expect(page.getByRole('alert')).toContainText('Invalid email or password')
})
