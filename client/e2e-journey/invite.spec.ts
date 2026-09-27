import { expect, test } from '@playwright/test'
import { JOURNEY_PASSWORD, register, suppressOnboarding, uniqueEmail } from './helpers'

/**
 * The household invite journey (H1), end-to-end: an owner adds a person, creates a one-time invite
 * link, and a brand-new person redeems it in a fresh (logged-out) browser and lands INSIDE the
 * inviter's household — the coherence fix that the stubbed suites can't exercise (real token,
 * real membership reconcile, the auto-switch into the joined household).
 */
test('an owner invites a new person who accepts and lands in the shared household', async ({
  page,
  browser,
}) => {
  // --- Inviter: register, add a person, create an invite link ---
  // Start the month from a template: the guest below asserts the shared budget renders after
  // joining, which needs the inviter's household to have a budget month.
  await register(page, { firstName: 'Ada', starterBudget: true })

  await page.goto('/people')
  // exact — the dialog's Cancel button is aria-labelled "Cancel add person" (contains "Add person").
  await page.getByRole('button', { name: 'Add person', exact: true }).first().click()
  const addDialog = page.getByRole('dialog')
  await addDialog.getByLabel('Person name').fill('Robin')
  await addDialog.getByRole('button', { name: 'Add person', exact: true }).click()

  // Robin's row is the only one offering a sign-in invite (the owner already has a login).
  await page.getByRole('button', { name: 'Invite to sign in' }).click()
  const inviteDialog = page.getByRole('dialog')
  const robinEmail = uniqueEmail('robin')
  await inviteDialog.getByLabel('Invitee email').fill(robinEmail)
  await inviteDialog.getByRole('button', { name: 'Create invite link' }).click()

  // textbox role — "Invite link" is also a substring of the "Copy invite link" button's name.
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue()
  expect(link).toContain('/accept-invite?code=')

  // --- Invitee: a fresh, logged-out browser redeems the link ---
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await suppressOnboarding(guest, robinEmail) // no first-run modal over the joined dashboard
  await guest.goto(link)

  await expect(guest.getByRole('heading', { name: 'Join the household' })).toBeVisible()
  await guest.getByLabel('Your name (optional)').fill('Robin')
  await guest.getByLabel('Password').fill(JOURNEY_PASSWORD)
  await guest.locator('label', { hasText: 'I agree to the' }).getByRole('checkbox').check()
  await guest.getByRole('button', { name: 'Accept invite' }).click()

  // They land in the inviter's household (H1 auto-switch), seeing its shared budget — not a
  // fresh own budget or the login screen.
  await expect(guest.getByText(/joined this household/)).toBeVisible()
  await expect(guest.getByText('Remaining to budget')).toBeVisible()

  // The accept CREATED their (unverified) login, so the INITIAL verification email must arrive
  // without touching Resend — the banner says "check your inbox", and now something is there.
  // Filter by the /confirm-email link path: the invite flow may send other mail to this address.
  await expect
    .poll(
      async () => {
        const res = await guest.request.get(`/api/dev/emails?to=${encodeURIComponent(robinEmail)}`)
        const messages: Array<{ textBody: string }> = await res.json()
        return messages
          .flatMap((m) => m.textBody.split('\n'))
          .map((l) => l.trim())
          .some((l) => l.startsWith('http') && l.includes('/confirm-email?'))
      },
      { timeout: 15000, message: `no verification email for ${robinEmail}` },
    )
    .toBe(true)

  // --- Invitee leaves again: lands in their own household, explained, with NO sample data ---
  // The leave path materializes a pure invitee's own household without sample figures
  // (seedSampleBudget: false), so the landing is the create-month hero plus the ?left greeting.
  await guest.goto('/account')
  await guest.getByRole('button', { name: 'Leave household' }).click()
  await guest.getByRole('button', { name: 'Yes, leave' }).click()

  await expect(guest.getByText(/left that household/)).toBeVisible()
  await expect(guest.getByText(/No budget for .+ yet/)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  await guestContext.close()
})
