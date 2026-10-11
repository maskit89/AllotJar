import { randomUUID } from 'node:crypto'
import { expect, type Locator, type Page } from '@playwright/test'

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
 * Picks `item` from one of the Dashboard's row menus (restyle PR 3): a line's ⋯ is named
 * "{line}: more actions" and a group's "{group} group: more actions". On a pointer screen the ⋯
 * shows while its row is hovered or holds focus (clicking it hovers it first), and the menu
 * renders in a portal, so the item is found on the page rather than inside the row. Desktop
 * only: on a phone-sized viewport there is no ⋯ (the line itself opens a bottom sheet).
 *
 * A menu fades out after a choice or Escape, and a click on a ⋯ while one is still fading out
 * opens nothing (seen in the journeys, which run with animations on), so this waits for no menu
 * before it opens one and returns once the menu has gone.
 */
export async function rowAction(page: Page, menu: string, item: string): Promise<void> {
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/**
 * Picks `item` ("Mark paid", "Delete", "Skip this month", …) from the ⋯ menu of the line `line`.
 * In a shared household an income line's name carries its earner: "Take-home pay (Alex)".
 */
export async function lineAction(page: Page, line: string, item: string): Promise<void> {
  await rowAction(page, `${line}: more actions`, item)
}

/** Picks `item` ("Add line", "Add income source", "Move up", …) from the ⋯ menu of the group `group`. */
export async function groupAction(page: Page, group: string, item: string): Promise<void> {
  await rowAction(page, `${group} group: more actions`, item)
}

/**
 * Picks `item` ("Mark paid", "Move money", "Edit", "Archive", …) from the ⋯ menu of the jar card
 * named `jar` on the Jars page (restyle PR 4).
 */
export async function jarAction(page: Page, jar: string, item: string): Promise<void> {
  await rowAction(page, `${jar}: more actions`, item)
}

/**
 * Picks `item` from the ⋯ menu of the account card named `account` on the Accounts page (restyle
 * PR 6). Each item's name says which account it acts on: "Edit Joint", "Make Joint private",
 * "Share Joint with the household", "Delete Joint".
 */
export async function accountAction(page: Page, account: string, item: string): Promise<void> {
  await rowAction(page, `${account}: more actions`, item)
}

/**
 * Picks `item` from the ⋯ menu of the person card named `person` on the People page (restyle
 * PR 8). Each item's name says whom it acts on where the visible text doesn't: "This is me",
 * "This isn't me", "Invite to sign in", "Send the email to Robin again", "Edit Robin",
 * "Archive Robin". Desktop only: on a phone the ⋯ opens a bottom sheet.
 */
export async function personAction(page: Page, person: string, item: string): Promise<void> {
  await rowAction(page, `${person}: more actions`, item)
}

/**
 * The card of the person named `name` on the People page (restyle PR 8): an article named by its
 * heading (the person's name, exact), in the "Your household" list. Replaces the old table's
 * `getByRole('row').filter({ hasText: name })`.
 */
export function personCard(page: Page, name: string): Locator {
  return personCards(page).filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) })
}

/** Every person's card on the People page (the old table's rows, less its header row). */
export function personCards(page: Page): Locator {
  return page.getByRole('region', { name: 'Your household', exact: true }).getByRole('article')
}

/**
 * Opens the ⋯ menu of the jar card named `jar` on the Jars page and returns it. Its note (where
 * the money is held, this month's plan, a missed deadline's date, how the last cycle ended) is
 * the menu's first line; close it with `closeMenu`.
 */
export async function openJarMenu(page: Page, jar: string): Promise<Locator> {
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('button', { name: `${jar}: more actions`, exact: true }).click()
  const menu = page.getByRole('menu')
  await menu.waitFor()
  return menu
}

/**
 * The rows of the Transactions list (restyle PR 5): one card, rows grouped under day headers, each
 * row one element holding its icon, payee, category, account, amount and ⋯ (and, while open, its
 * assign picker and transfer-leg editor). Replaces the old register's `tbody tr`. Filter by payee:
 * rows come newest first, so `.first()` is only safe when one row is on screen.
 */
export function txRows(page: Page): Locator {
  return page.getByTestId('tx-row')
}

/**
 * Opens the ⋯ menu of a Transactions list row and returns it (its note, what the row's chips leave
 * out, is the menu's first line); close it with `closeMenu`. The ⋯ is found inside the row, named
 * "{payee}: more actions" (the date when the row has no payee).
 */
export async function openTxMenu(page: Page, row: Locator): Promise<Locator> {
  await expect(page.getByRole('menu')).toHaveCount(0)
  await row.getByRole('button', { name: /: more actions$/ }).click()
  const menu = page.getByRole('menu')
  await menu.waitFor()
  return menu
}

/**
 * Picks `item` from the ⋯ menu of a Transactions list row. `item` is the action's full name, which
 * says which row it acts on: "Edit transaction: Tesco", "Split transaction: Costco", "Mark as
 * refund: …", "Not a refund: …", "Confirm receipt: …", "Add departure date: …", "Edit transfer: …",
 * "Delete transaction: …" (a RegExp for a payee that comes from a bank). Waits for no menu before
 * and after, as `rowAction` does.
 */
export async function txAction(page: Page, row: Locator, item: string | RegExp): Promise<void> {
  const menu = await openTxMenu(page, row)
  await menu.getByRole('menuitem', typeof item === 'string' ? { name: item, exact: true } : { name: item }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/** Closes the open ⋯ menu with Escape and waits for it to fade out. */
export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/**
 * Add an account through the Accounts page modal (navigates there). A card names its type only
 * on its icon (and in its ⋯ note), so a name like "Savings" no longer collides with visible text;
 * specs still look an account up by role and exact name ("View Savings").
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
 * as a date input wants it. As a jar's date (Needed by / Next due) it plans exactly `monthsAhead`
 * contribution months: the deadline day itself is never a contribution day, and a 1st-of-month
 * deadline leaves the deadline month out (rules 12, 36).
 */
export function firstOfMonthAhead(monthsAhead: number): string {
  const now = new Date()
  const t = now.getFullYear() * 12 + now.getMonth() + monthsAhead
  const year = Math.floor(t / 12)
  const month = (t % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/**
 * Create a Goal jar — one that doesn't repeat — through the one jar form (rule 73) on the Jars
 * page (navigates there). The form asks no type: Repeats "Doesn’t repeat" (a new jar's default)
 * makes it a Goal, which saves by its "Needed by" date or at a fixed monthly amount (rule 17):
 * `monthly` ticks "Set aside a fixed amount each month" (an ongoing pot when `target` is empty,
 * rule 16); otherwise it saves by `deadline`, which defaults to the 1st of the month twelve
 * months out, so twelve contribution months plan (target − set aside) ÷ 12 (rule 35). `heldIn`
 * names the account that holds its money; `setAside` (under "More options") divides money
 * already in that account into the jar (rule 77) as of today.
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
  // A new jar already starts here; said explicitly so the jar's kind never rides on the default.
  // The option's apostrophe is U+2019, as the form writes it.
  await dialog.getByLabel('Repeats').selectOption({ label: 'Doesn\u2019t repeat' })
  await dialog.getByLabel('Target amount').fill(jar.target)
  if (jar.monthly) {
    await dialog.getByLabel('Set aside a fixed amount each month').check()
    await dialog.getByLabel('Monthly amount').fill(jar.monthly)
  } else {
    await dialog.getByLabel('Needed by').fill(jar.deadline ?? firstOfMonthAhead(12))
  }
  await dialog.getByLabel('Funding account').selectOption({ label: jar.heldIn })
  if (jar.setAside) {
    // "Already set aside" is folded under More options (rule 77).
    await dialog.getByRole('button', { name: 'More options' }).click()
    await dialog.getByLabel('Already set aside').fill(jar.setAside)
  }
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/jars') && r.ok(),
  )
  await dialog.getByRole('button', { name: 'Add jar' }).click()
  await posted
  await expect(dialog).toBeHidden()
  // Exact: the page's other headings ("Your jars", "Unallocated") must never match a jar's name.
  await expect(page.getByRole('heading', { name: jar.name, exact: true })).toBeVisible()
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
