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
 * The register build has no beta-consent checkbox (VITE_APP_ENV is unset for the journey run),
 * so only the Terms checkbox is required.
 */
export async function register(
  page: Page,
  opts: { email?: string; password?: string; firstName?: string } = {},
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
  // Terms checkbox has no id/aria-label — reach it through its wrapping label text.
  await page.locator('label', { hasText: 'I agree to the' }).getByRole('checkbox').check()
  // "Create account" also names a segmented tab, so target the form's submit button.
  await page.locator('button[type="submit"]').click()

  // Registration lands on the dashboard with the seeded starter budget (onboarding was suppressed).
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  return { email, password }
}
