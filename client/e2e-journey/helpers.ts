import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'

/**
 * A password that satisfies the Identity policy (≥8, digit + upper + lower) AND is guaranteed not to
 * be in the Have I Been Pwned breach corpus that registration screens against — a fixed common
 * password like "Journey123!" is rejected as breached, so it must be random per run.
 */
export const JOURNEY_PASSWORD = `Aa1-${randomUUID()}`

let seq = 0

/** A unique email per registration so re-runs against a persistent DB never collide. */
export function uniqueEmail(prefix = 'journey'): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}@e2e.allotjar.test`
}

/**
 * Pre-seed the per-user onboarding record as fully-seen so the first-run WelcomeDialog (a modal
 * whose backdrop intercepts clicks) and the getting-started checklist never appear for this email.
 * Deterministic — no modal to race or dismiss. Must be called before the app first loads.
 */
export async function suppressOnboarding(page: Page, email: string): Promise<void> {
  await page.addInitScript((em) => {
    window.localStorage.setItem(
      `zbb.onboarding:${em}`,
      JSON.stringify({ v: 1, welcomeSeen: true, tourDone: true, checklistDismissed: true }),
    )
  }, email)
}

/**
 * Register a brand-new user through the real UI and land on the dashboard. Returns the email.
 * The register build has no staging-consent checkbox (VITE_APP_ENV is unset for the journey run),
 * so only the Terms checkbox is required. Registration seeds nothing (rule 81: no sample data),
 * so the landing is the create-month empty state; pass `starterBudget: true` to then start the
 * current month from the Essentials template (Take-home Pay, Housing, Food, …) for specs that
 * need a real month with named lines.
 */
export async function register(
  page: Page,
  opts: {
    email?: string
    password?: string
    firstName?: string
    starterBudget?: boolean
    /** ISO currency code to register with (default EUR — see the comment below). */
    currency?: string
  } = {},
): Promise<{ email: string; password: string }> {
  const email = opts.email ?? uniqueEmail()
  const password = opts.password ?? JOURNEY_PASSWORD
  const firstName = opts.firstName ?? 'Journey'

  await suppressOnboarding(page, email)
  await page.goto('/login?register=1')
  await page.getByLabel('First name').fill(firstName)
  await page.getByLabel('Last name').fill('Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  // Pin the home currency: the form's default is locale-derived (GBP under this suite's
  // en-GB locale), the first budget month adopts it, and the suite's money assertions
  // are written in €. Registering in EUR keeps months, accounts and transactions
  // coherent in one currency regardless of the runner's locale. A spec that exercises the
  // non-EUR path (first-month-currency.spec.ts) overrides this explicitly.
  await page.getByLabel('Currency').selectOption(opts.currency ?? 'EUR')
  // Terms checkbox has no id/aria-label — reach it through its wrapping label text.
  await page.locator('label', { hasText: 'I agree to the' }).getByRole('checkbox').check()
  // "Create account" also names a segmented tab, so target the form's submit button.
  await page.locator('button[type="submit"]').click()

  // Registration lands on the dashboard (onboarding was suppressed) at the create-month empty
  // state — nothing is seeded.
  await expect(page.getByText(/No budget for .+ yet/)).toBeVisible()
  if (opts.starterBudget) await startFromEssentialsTemplate(page)
  return { email, password }
}

/** From the create-month hero, build the viewed month from the Essentials template. */
export async function startFromEssentialsTemplate(page: Page): Promise<void> {
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/budget') && r.ok(),
  )
  await page.getByRole('button', { name: 'Start from the Essentials template' }).click()
  await created
  await expect(page.getByText('Remaining to budget')).toBeVisible()
}

/**
 * Add an account through the Accounts page modal (navigates there). Account names should
 * avoid the type-chip labels (Current/Savings/Cash/…) where a spec relies on plain text
 * lookups — a name like "Savings" collides with every card's type chip in strict mode, so
 * such specs must use role/exact locators.
 */
export async function addAccount(
  page: Page,
  acc: { name: string; opening: string; openingDate?: string; type?: 'Current' | 'Savings' | 'Cash' | 'Other' },
): Promise<void> {
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(acc.name)
  if (acc.type) await dialog.getByLabel('Account type').selectOption({ label: acc.type })
  await dialog.getByLabel('Opening balance').fill(acc.opening)
  await dialog.getByLabel('Opening date').fill(acc.openingDate ?? '2026-01-01')
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await expect(dialog).toBeHidden() // closes only on a successful POST
  await expect(page.getByRole('link', { name: `View ${acc.name}`, exact: true })).toBeVisible()
}

/**
 * The first day of the month `monthsAhead` months from the real current month (the app's clock),
 * as a date input wants it. As a jar deadline it plans exactly `monthsAhead` contribution months:
 * the deadline day itself is never a contribution day, and a 1st-of-month deadline leaves the
 * deadline month out (rules 12, 36).
 */
export function firstOfMonthAhead(monthsAhead: number): string {
  const now = new Date()
  const t = now.getFullYear() * 12 + now.getMonth() + monthsAhead
  const year = Math.floor(t / 12)
  const month = (t % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/**
 * Create a Goal jar through the one jar form (rule 73) on the Jars page (navigates there).
 * A goal saves by a deadline or at a fixed monthly amount (rule 17): `monthly` makes it a fixed
 * monthly plan (an ongoing pot when `target` is empty, rule 16); otherwise it saves by `deadline`,
 * which defaults to the 1st of the month twelve months out, so twelve contribution months plan
 * (target − set aside) ÷ 12 (rule 35). `heldIn` names the account that holds its money;
 * `setAside` divides money already in that account into the jar (rule 77) as of today.
 */
export async function createGoalJar(
  page: Page,
  jar: {
    name: string
    target: string
    heldIn: string
    setAside?: string
    deadline?: string
    monthly?: string
  },
): Promise<void> {
  await page.getByRole('link', { name: 'Jars' }).click()
  await page.getByRole('button', { name: 'New jar' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Jar name').fill(jar.name)
  // exact — the adjacent InfoHint is aria-labelled "About jar types" (a superstring).
  await dialog.getByLabel('Jar type', { exact: true }).selectOption({ label: 'Goal' })
  await dialog.getByLabel('Target amount').fill(jar.target)
  if (jar.monthly) {
    await dialog.getByLabel('How to save').selectOption({ label: 'A fixed amount each month' })
    await dialog.getByLabel('Monthly amount').fill(jar.monthly)
  } else {
    await dialog.getByLabel('Deadline').fill(jar.deadline ?? firstOfMonthAhead(12))
  }
  await dialog.getByLabel('Funding account').selectOption({ label: jar.heldIn })
  if (jar.setAside) await dialog.getByLabel('Already set aside').fill(jar.setAside)
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/jars') && r.ok(),
  )
  await dialog.getByRole('button', { name: 'Add jar' }).click()
  await posted
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: jar.name })).toBeVisible()
}

/**
 * Read a link from the Development mailbox (GET /api/dev/emails). Emails are sent off the request
 * path, so the mailbox is polled until a line starting with http and containing `pathMarker`
 * (e.g. '/confirm-email?' or '/reset-password?') lands, then that link is returned.
 */
export async function waitForEmailLink(
  page: Page,
  email: string,
  pathMarker: string,
  timeout = 10_000,
): Promise<string> {
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
      { message: `email to ${email} containing ${pathMarker}`, timeout },
    )
    .not.toBe('')
  return link!
}
