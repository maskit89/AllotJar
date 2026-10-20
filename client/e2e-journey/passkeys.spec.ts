import { expect, test, type Page } from '@playwright/test'
import { register, uniqueEmail } from './helpers'

/**
 * Two-factor sign-in with passkeys (fix 14) through the real UI, API and database, with Chromium's
 * virtual authenticator standing in for a phone's fingerprint or face unlock: turning a passkey on
 * from Account settings (the recovery codes show once), the passkey step after a password, a
 * passkey alone, and a recovery code standing in for a lost passkey.
 */

async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

async function signOut(page: Page) {
  await page.request.post('/api/auth/logout')
  await page.goto('/login')
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.locator('button[type="submit"]').click()
}

test('a passkey turns on the second step, signs in alone, and a recovery code stands in for it', async ({ page }) => {
  await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey')
  const { password } = await register(page, { email })

  // Turn it on just after signing in: no extra proof asked; the codes show once.
  await page.goto('/account')
  const signIn = page.getByRole('region', { name: 'Sign-in' })
  await signIn.getByRole('button', { name: 'Add a passkey' }).click()
  const codesDialog = page.getByRole('dialog', { name: 'Save your recovery codes' })
  await expect(codesDialog).toBeVisible()
  const codes = await codesDialog.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents()
  expect(codes).toHaveLength(10)
  await codesDialog.getByRole('button', { name: 'Done' }).click()
  await expect(signIn.getByText('On', { exact: true })).toBeVisible()
  await expect(signIn.getByText('10 left')).toBeVisible()

  // A right password now asks for the passkey before signing in.
  await signOut(page)
  await signInWithPassword(page, email, password)
  await expect(page.getByRole('heading', { name: 'Confirm with your passkey' })).toBeVisible()
  await page.getByRole('button', { name: 'Use passkey' }).click()
  await expect(page.getByText(/No budget for .+ yet/)).toBeVisible()

  // A passkey alone signs in.
  await signOut(page)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByText(/No budget for .+ yet/)).toBeVisible()

  // A recovery code stands in, once.
  await signOut(page)
  await signInWithPassword(page, email, password)
  await page.getByRole('button', { name: 'Use a recovery code' }).click()
  await page.getByLabel('Recovery code').fill(codes[0])
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/No budget for .+ yet/)).toBeVisible()
  await page.goto('/account')
  await expect(page.getByRole('region', { name: 'Sign-in' }).getByText('9 left')).toBeVisible()
})
