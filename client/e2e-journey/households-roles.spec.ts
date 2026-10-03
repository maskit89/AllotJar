import { expect, test, type Page } from '@playwright/test'
import { JOURNEY_PASSWORD, register, suppressOnboarding, uniqueEmail, waitForEmailLink } from './helpers'

/**
 * People & roles against the live stack (the PPL/ROLE deferred set): the owner-as-member-#1
 * invariant and the solo→shared gating flip when a 2nd person is added; a direct
 * temp-password invite that mints a Limited login (its first sign-in asks for its own password,
 * then consent); the Limited
 * chrome (banner + hidden Admin+ controls) TOGETHER WITH real server enforcement — a Limited
 * write succeeds, then a mid-session demotion makes the very next write 403 while the stale
 * UI still offers the button, and the chrome catches up on reload; a pure invitee starting
 * their own budget (never seeded with samples, PR #170), the multi-household switcher with
 * per-household role resolution and data isolation, and leaving the joined household.
 *
 * Each test registers its own fresh owner + invitee so the specs stay isolated.
 */

/** Add a budget person through the People page modal (waits for the refreshed table). */
async function addPerson(page: Page, name: string, income: string): Promise<void> {
  // exact — the modal's Cancel button is aria-labelled "Cancel add person" (a superstring).
  await page.getByRole('button', { name: 'Add person', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Person name').fill(name)
  await dialog.getByLabel('Default income').fill(income)
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click()
  // The modal closes only after the POST + table & household refreshes complete.
  await expect(dialog).toBeHidden()
}

/**
 * PPL-044 / PPL-049: from a person's row, create a DIRECT login (temp password) with the
 * Limited access level. The membership is Active immediately — no link redemption step.
 */
async function directInviteLimited(page: Page, personName: string, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Invite to sign in' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `Invite ${personName} to sign in` })).toBeVisible()
  await dialog.getByLabel('Invitee email').fill(email)
  // PPL-049: the grantable list never offers Owner, and the hint tracks the chosen role.
  await dialog.getByLabel('Access level', { exact: true }).selectOption({ label: 'Limited' })
  await expect(
    dialog.getByText('Day-to-day entry: transactions, mark bills paid, run allocation.'),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Set a temporary password' }).click()
  await dialog.getByLabel('Temporary password').fill(JOURNEY_PASSWORD)
  await dialog.getByRole('button', { name: 'Create login' }).click()
  // PPL-044: the success box confirms the login exists NOW and that its password link was emailed.
  await expect(dialog.getByText('Login created')).toBeVisible()
  await expect(dialog.getByText(email)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
}

/** Sign an existing login in through the real /login form. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.locator('button[type="submit"]').click()
}

/**
 * S-P2-3: a login created with a temporary password must choose its own before anything else;
 * the server refuses every other call until it does. Then the consent prompt follows.
 */
async function chooseOwnPassword(page: Page, email: string, temporary: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Choose your own password' })
  await expect(dialog).toBeVisible()
  // The prompt offers no password fields: the new one is chosen through the link emailed to the
  // login's own address, so whoever set the temporary password can't choose it for them.
  await expect(dialog).toContainText(email)
  const link = await waitForEmailLink(page, email, '/reset-password?')
  await page.goto(link)
  await page.getByLabel('New password', { exact: true }).fill(`${temporary}-own`)
  await page.getByLabel('Confirm new password').fill(`${temporary}-own`)
  const [reset] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/reset-password')),
    page.getByRole('button', { name: 'Set new password' }).click(),
  ])
  expect(reset.status(), await reset.text()).toBe(200)
  // The reset signs this device in and leaves the reset page, with the prompt gone.
  await expect(page).not.toHaveURL(/\/reset-password/)
  await expect(dialog).toBeHidden()
}

/**
 * PPL-044 (consent leg): a login created FOR someone (ConsentedUtc null) is blocked by the
 * ConsentModal on first sign-in until they agree themselves.
 */
async function agreeToTerms(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'One thing before you start' })).toBeVisible()
  await page.getByRole('button', { name: 'I agree' }).click()
  await expect(page.getByRole('heading', { name: 'One thing before you start' })).toBeHidden()
}

test('adding a 2nd person flips solo→shared live, and a temp-password Limited login is enforced by the server mid-session', async ({
  page,
  browser,
}) => {
  // The Essentials template gives the shared household a real current month for the invitee to see.
  await register(page, { firstName: 'Ivy', starterBudget: true })

  // --- Owner: solo state on /people ---
  await page.goto('/people')
  // PPL-027: registration materialized the owner as member #1 — exactly one row ("You").
  await expect(page.getByRole('row').filter({ hasText: 'Ivy' })).toBeVisible()
  await expect(page.getByText('You', { exact: true })).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(2) // header + the owner
  // PPL-002 / PPL-032: solo (1 member) — People nav shown, Allocation nav hidden.
  await expect(page.getByRole('link', { name: 'People' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Allocation' })).toHaveCount(0)

  // --- Owner: add a 2nd person → shared, live ---
  // PPL-007: POST /members through the modal; the person appears with their income.
  await addPerson(page, 'Robin', '1000')
  const robinRow = page.getByRole('row').filter({ hasText: 'Robin' })
  await expect(robinRow).toContainText('1,000.00')
  // PPL-030: refreshHousehold() after the add flips isShared — the Allocation nav item
  // appears WITHOUT any reload.
  await expect(page.getByRole('link', { name: 'Allocation' })).toBeVisible()

  // --- Owner: direct temp-password invite, Limited role (PPL-044 / PPL-049) ---
  const robinEmail = uniqueEmail('robin')
  await directInviteLimited(page, 'Robin', robinEmail)
  // PPL-034: the linked person's row now shows the login email and an editable role select
  // (value 2 = Limited) for the owner.
  await expect(robinRow).toContainText(robinEmail)
  await expect(robinRow.getByRole('combobox', { name: 'Access level for Robin' })).toHaveValue('2')

  // PPL-062 / PPL-067: an owner viewing their OWN household gets neither the start-own card
  // nor the leave card on /account.
  await page.goto('/account')
  await expect(page.getByRole('button', { name: 'Start my own budget' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Leave household' })).toHaveCount(0)

  // --- Invitee: first sign-in in a fresh browser (consent-gated) ---
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await suppressOnboarding(guest, robinEmail)
  await signIn(guest, robinEmail, JOURNEY_PASSWORD)
  await chooseOwnPassword(guest, robinEmail, JOURNEY_PASSWORD)
  await agreeToTerms(guest)

  // ROLE-040 (direct variant): the invite-assigned Limited role governs the very first
  // session — they land inside the owner's household seeing its real budget…
  await expect(guest.getByText('Remaining to budget')).toBeVisible()
  // …with the Limited banner (ROLE-007).
  await expect(guest.getByText(/You have limited access/)).toBeVisible()

  // --- Limited chrome: Admin+ write controls are hidden, day-to-day entry stays ---
  // ROLE-009: no budget-structure editing — no "Add a group", names are static text.
  await expect(guest.getByRole('button', { name: 'Add a group' })).toHaveCount(0)
  await expect(guest.getByRole('textbox', { name: 'Rename group Housing' })).toHaveCount(0)
  await expect(guest.getByText('Housing')).toBeVisible()
  // ROLE-013 / ROLE-016: transaction entry offered, but the Import link (Admin+) is not.
  await guest.goto('/transactions')
  await expect(guest.getByRole('button', { name: 'Add transaction' })).toBeVisible()
  await expect(guest.getByRole('link', { name: 'Import' })).toHaveCount(0)
  // PPL-017 / PPL-026 / PPL-040: People renders read-only for Limited — no member CRUD, no
  // access controls (canAccess is owner-only), just static role labels.
  await guest.goto('/people')
  await expect(guest.getByRole('row')).toHaveCount(3) // household still fully visible
  await expect(guest.getByRole('button', { name: 'Add person', exact: true })).toHaveCount(0)
  await expect(guest.getByRole('combobox', { name: /Access level for/ })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: /Remove sign-in for/ })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Invite to sign in' })).toHaveCount(0)
  await expect(guest.getByText('Owner', { exact: true })).toBeVisible()
  await expect(guest.getByText('Limited', { exact: true })).toBeVisible()

  // --- ROLE-013 (Limited leg): a real transaction write succeeds against the live API ---
  await guest.goto('/transactions')
  await guest.getByRole('button', { name: 'Add transaction' }).click()
  const txDialog = guest.getByRole('dialog')
  await txDialog.getByLabel('Transaction payee').fill('Tesco')
  await txDialog.getByLabel('Transaction amount').fill('12.34')
  const txCreated = guest.waitForResponse(
    (r) => r.url().includes('/api/transactions') && r.request().method() === 'POST' && r.ok(),
  )
  await txDialog.getByRole('button', { name: 'Add transaction' }).click()
  await txCreated
  await expect(txDialog).toBeHidden()
  await expect(guest.getByText('Tesco')).toBeVisible()

  // The write landed in the SHARED household — the owner's register shows it too.
  await page.goto('/transactions')
  await expect(page.getByText('Tesco')).toBeVisible()

  // --- PPL-035: the owner demotes Robin to Read-only mid-session ---
  await page.goto('/people')
  const roleChanged = page.waitForResponse(
    (r) => r.url().includes('/role') && r.request().method() === 'PUT' && r.ok(),
  )
  await page
    .getByRole('row')
    .filter({ hasText: 'Robin' })
    .getByRole('combobox', { name: 'Access level for Robin' })
    .selectOption({ label: 'Read-only' })
  await roleChanged

  // --- ROLE-038 / ROLE-003: the server refuses Robin's NEXT write immediately, while the
  // stale SPA still shows the entry button (role is re-resolved per request, never cached
  // in the JWT) ---
  await guest.getByRole('button', { name: 'Add transaction' }).click()
  const staleDialog = guest.getByRole('dialog')
  await staleDialog.getByLabel('Transaction payee').fill('Blocked latte')
  await staleDialog.getByLabel('Transaction amount').fill('5')
  const denied = guest.waitForResponse(
    (r) =>
      r.url().includes('/api/transactions') && r.request().method() === 'POST' && r.status() === 403,
  )
  await staleDialog.getByRole('button', { name: 'Add transaction' }).click()
  await denied
  await expect(staleDialog.getByText('Could not add that transaction.')).toBeVisible()
  await staleDialog.getByRole('button', { name: 'Close' }).click()
  await expect(guest.getByText('Blocked latte')).toHaveCount(0) // nothing was written

  // --- ROLE-038 (UI catches up on next load) + ROLE-007 / ROLE-015 ---
  await guest.reload()
  await expect(guest.getByText(/You have read-only access/)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Add transaction' })).toHaveCount(0)
  await expect(guest.getByText('Tesco')).toBeVisible() // full view parity, zero controls
  // PPL-070: the Account details card reflects the new access level.
  await guest.goto('/account')
  await expect(guest.getByText('Read-only', { exact: true })).toBeVisible()

  await guestContext.close()
})

test('a pure invitee starts their own budget (nothing seeded), switches households with isolated data, and leaves the joined one', async ({
  page,
  browser,
}) => {
  // The owner's display name becomes the joined household's label in the switcher.
  await register(page, { firstName: 'Olive', starterBudget: true })
  await page.goto('/people')
  await addPerson(page, 'Robin', '1000')
  const robinEmail = uniqueEmail('robin')
  await directInviteLimited(page, 'Robin', robinEmail)

  // --- Invitee signs in: lands inside the shared household as Limited ---
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await suppressOnboarding(guest, robinEmail)
  await signIn(guest, robinEmail, JOURNEY_PASSWORD)
  await chooseOwnPassword(guest, robinEmail, JOURNEY_PASSWORD)
  await agreeToTerms(guest)
  await expect(guest.getByText('Remaining to budget')).toBeVisible()
  await expect(guest.getByText(/You have limited access/)).toBeVisible()

  // PPL-070 + PPL-061 preconditions: a pure invitee's /account offers BOTH the start-own
  // card (ownsHousehold=false) and the leave card (viewing a joined household).
  await guest.goto('/account')
  await expect(guest.getByText('Limited', { exact: true })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Leave household' })).toBeVisible()

  // --- PPL-061 / ROLE-033: start their own budget (available regardless of Limited role) ---
  const startOwn = guest.waitForResponse(
    (r) => r.url().includes('/households/start-own') && r.ok(),
  )
  await guest.getByRole('button', { name: 'Start my own budget' }).click()
  await startOwn
  // Full re-bootstrap into the new own household with the ?started=1 greeting…
  await expect(guest.getByText(/This is your own budget — set up your first month below/)).toBeVisible()
  // …landing on the create-month flow with nothing seeded (start-own never seeds).
  await expect(guest.getByText(/No budget for .+ yet/)).toBeVisible()
  await expect(guest.getByText('Remaining to budget')).toHaveCount(0)
  // ROLE-035: in their OWN household the same login is Owner — the create buttons render
  // (a non-writer would be told to ask an admin) and the Limited banner is gone.
  await expect(guest.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  await expect(guest.getByText(/You have limited access/)).toHaveCount(0)

  // PPL-058 (own side): the own household is solo — just the invitee, none of Olive's data.
  await expect(guest.getByRole('link', { name: 'Allocation' })).toHaveCount(0)
  await guest.goto('/people')
  await expect(guest.getByRole('row')).toHaveCount(2) // header + the new owner member
  await expect(guest.getByText('Olive')).toHaveCount(0)

  // PPL-062 / PPL-067: now that they own a household (and are viewing it), both cards go.
  await guest.goto('/account')
  await expect(guest.getByRole('button', { name: 'Start my own budget' })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Leave household' })).toHaveCount(0)

  // --- PPL-057: the account-menu switcher lists both households; switching re-bootstraps ---
  await guest.getByRole('button', { name: 'Account menu' }).first().click()
  const menu = guest.getByRole('menu')
  await expect(menu.getByText('Household', { exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Your household' })).toBeVisible()
  const switched = guest.waitForResponse((r) => r.url().includes('/households/switch') && r.ok())
  await menu.getByRole('menuitem', { name: 'Olive Tester' }).click()
  await switched
  // ROLE-036 + PPL-058: after the full reload the app re-scopes to the shared household —
  // its budget is back, the role re-resolves to Limited, and People shows both members.
  await expect(guest.getByText('Remaining to budget')).toBeVisible()
  await expect(guest.getByText(/You have limited access/)).toBeVisible()
  await guest.goto('/people')
  await expect(guest.getByRole('row')).toHaveCount(3)
  await expect(guest.getByText('Olive', { exact: true })).toBeVisible()

  // --- PPL-065 (variant) / ROLE-033: leave the joined household from /account ---
  await guest.goto('/account')
  await guest.getByRole('button', { name: 'Leave household' }).click()
  const left = guest.waitForResponse((r) => r.url().endsWith('/households/leave') && r.request().method() === 'POST' && r.ok())
  await guest.getByRole('button', { name: 'Yes, leave' }).click()
  await left
  // Lands back in their own budget, explained — and STILL never seeded (PR #170).
  await expect(guest.getByText(/left that household/)).toBeVisible()
  await expect(guest.getByText(/No budget for .+ yet/)).toBeVisible()
  await expect(guest.getByText(/You have limited access/)).toHaveCount(0)

  // PPL-057 (single-household side): with one household left, the switcher section is gone.
  await guest.getByRole('button', { name: 'Account menu' }).first().click()
  const menuAfter = guest.getByRole('menu')
  await expect(menuAfter.getByRole('menuitem', { name: 'Account settings' })).toBeVisible()
  await expect(menuAfter.getByText('Household', { exact: true })).toHaveCount(0)
  await expect(menuAfter.getByRole('menuitem', { name: 'Olive Tester' })).toHaveCount(0)

  await guestContext.close()
})
