import { expect, test, type Page } from '@playwright/test'
import { AUTHED_ROUTES, authedSetup, mockApi } from './mocks'

/**
 * Keyboard operation + screen-reader structure sweep (catalog prefix UX in
 * docs/testing/cases/26-ux-states.md, plus the a11y-tagged area cases).
 *
 * The axe WCAG scan lives in a11y.spec.ts and the 375px overflow guard in
 * mobile-layout.spec.ts; this file deliberately covers what those don't —
 * real-keyboard focus management, ARIA landmark/heading structure, the
 * aria-pressed toggle contract, reorder-arrow semantics, the focus-visible ring
 * and the prefers-reduced-motion reset. Everything is driven with page.keyboard /
 * locator.press / .focus() rather than mouse clicks, and asserted via
 * expect-polling — no arbitrary sleeps.
 */

/** Sign out and land on /login (mirrors a11y.spec.ts's login setup). */
async function signedOutLogin(page: Page) {
  await page.addInitScript(() => localStorage.setItem('zbb.theme', 'light'))
  await page.route('**/api/**', mockApi)
  await page.goto('/login')
  await page.getByLabel('Email').waitFor()
}

// ---------------------------------------------------------------------------
// Keyboard navigation & focus management
// ---------------------------------------------------------------------------

// UX-007 + UX-008 — the skip link is the first tab stop and moves focus to the
// programmatically-focusable <main id="main-content" tabIndex={-1}>.
test('skip link is the first tab stop and moves focus into #main-content (UX-007, UX-008)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // First Tab reveals + focuses the skip link (nothing focusable precedes it).
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to main content' })
  await expect(skip).toBeFocused()
  await expect(skip).toHaveAttribute('href', '#main-content')

  // Activating it moves focus to the <main> landmark, which is programmatically
  // focusable via tabIndex -1 (UX-008: the -1 target is a focus destination, not a
  // tab stop) — bypassing the sidebar/topbar per WCAG 2.4.1.
  await page.keyboard.press('Enter')
  const main = page.locator('main#main-content')
  await expect(main).toBeFocused()
  await expect(main).toHaveAttribute('tabindex', '-1')
})

// UX-005 — a keyboard-focused control shows a visible focus ring (WCAG 2.4.7).
// We assert the ring is present (a non-'none' outline of ≥2px in a non-transparent
// colour) rather than pinning exact design values, so the test is robust to the
// browser's fallback rendering of the app's :focus-visible outline.
test('focus-visible ring appears on Tab for the skip link and the first nav link (UX-005)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const ringOf = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return null
      const s = getComputedStyle(el)
      return {
        name: el.textContent?.trim() ?? '',
        matchesFocusVisible: el.matches(':focus-visible'),
        style: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        color: s.outlineColor,
      }
    })

  const expectVisibleRing = (r: Awaited<ReturnType<typeof ringOf>>) => {
    expect(r?.matchesFocusVisible).toBe(true)
    expect(r?.style).not.toBe('none')
    expect(r?.width ?? 0).toBeGreaterThanOrEqual(2)
    expect(['rgba(0, 0, 0, 0)', 'transparent']).not.toContain(r?.color)
  }

  // Tab 1 → the skip link.
  await page.keyboard.press('Tab')
  const skipRing = await ringOf()
  expect(skipRing?.name).toBe('Skip to main content')
  expectVisibleRing(skipRing)

  // Tab 2 → the first primary-nav link ("Budget").
  await page.keyboard.press('Tab')
  const navRing = await ringOf()
  expect(navRing?.name).toBe('Budget')
  expectVisibleRing(navRing)
})

// UX-014 — the month navigator arrows are labelled buttons and keyboard-operable;
// activating them moves the app-wide viewed month (the <h2> label updates).
test('month navigator arrows are labelled and keyboard-operable (UX-014)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const prev = page.getByRole('button', { name: 'Previous month' })
  const next = page.getByRole('button', { name: 'Next month' })
  const monthLabel = page.getByRole('heading', { level: 2 }).first()
  await expect(prev).toBeVisible()
  await expect(next).toBeVisible()

  const before = (await monthLabel.textContent())?.trim() ?? ''
  expect(before).toMatch(/^[A-Z][a-z]+ \d{4}$/)

  // Enter on "Next month" advances the month...
  await next.press('Enter')
  await expect(monthLabel).not.toHaveText(before)

  // ...and "Previous month" brings it back — proving both are keyboard-operable.
  await prev.press('Enter')
  await expect(monthLabel).toHaveText(before)
})

// ---------------------------------------------------------------------------
// Screen-reader structure
// ---------------------------------------------------------------------------

// UX-017 — every authenticated route exposes exactly one <h1> (some rendered
// sr-only by AppShell, some visible via PageHeader), never zero or two.
for (const path of AUTHED_ROUTES) {
  test(`${path} exposes exactly one h1 (UX-017)`, async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto(path)
    const h1 = page.getByRole('heading', { level: 1 })
    await h1.first().waitFor()
    await expect(h1).toHaveCount(1)
    // The single h1 has a non-empty accessible name.
    expect((await h1.first().textContent())?.trim()).not.toBe('')
  })
}

// UX-018 — the primary navigation is a labelled landmark (aria-label="Primary")
// and the active item carries aria-current="page".
test('primary nav is a landmark labelled "Primary" with a current-page marker (UX-018)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // At desktop width only the sidebar nav is visible (the mobile one is display:none),
  // so exactly one Primary landmark is in the accessibility tree.
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav).toHaveCount(1)

  // On "/" the Budget item is active and marks itself for assistive tech.
  const budget = nav.getByRole('link', { name: 'Budget' })
  await expect(budget).toHaveAttribute('aria-current', 'page')
  // A non-active item does not carry the marker.
  await expect(nav.getByRole('link', { name: 'Transactions' })).not.toHaveAttribute('aria-current', 'page')
})

// ---------------------------------------------------------------------------
// aria-pressed toggle controls, keyboard-operated (UX-013 + the bill Paid toggle)
// ---------------------------------------------------------------------------

// UX-013 — the theme control is a role="group" of aria-pressed <button>s (not a
// tablist), operable with the keyboard; activating flips the pressed state and
// applies the .dark class app-wide.
test('theme toggle exposes aria-pressed and is keyboard-operable (UX-013)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const group = page.getByRole('group', { name: 'Theme' })
  await expect(group).toBeVisible()
  const light = group.getByRole('button', { name: 'Light mode' })
  const dark = group.getByRole('button', { name: 'Dark mode' })

  // Starts in light: Light pressed, Dark not.
  await expect(light).toHaveAttribute('aria-pressed', 'true')
  await expect(dark).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // Keyboard-activate Dark → pressed state flips and the app goes dark.
  await dark.press('Enter')
  await expect(dark).toHaveAttribute('aria-pressed', 'true')
  await expect(light).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('html')).toHaveClass(/dark/)
})

// UX-013 — the Sign-in / Create-account segmented control is a labelled group of
// aria-pressed buttons; Space toggles it and swaps in the registration fields.
test('login sign-in/create-account segmented control toggles via keyboard (UX-013)', async ({
  page,
}) => {
  await signedOutLogin(page)

  const group = page.getByRole('group', { name: 'Sign in or create an account' })
  await expect(group).toBeVisible()
  const signIn = group.getByRole('button', { name: 'Sign in' })
  const createAccount = group.getByRole('button', { name: 'Create account' })

  await expect(signIn).toHaveAttribute('aria-pressed', 'true')
  await expect(createAccount).toHaveAttribute('aria-pressed', 'false')
  // Register-only fields are absent in sign-in mode.
  await expect(page.getByLabel('First name')).toHaveCount(0)

  // Space activates the focused segment → register mode.
  await createAccount.press(' ')
  await expect(createAccount).toHaveAttribute('aria-pressed', 'true')
  await expect(signIn).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByLabel('First name')).toBeVisible()
})

// UX-013 — the allocation split SegmentedControls (in the settings modal) each
// expose aria-pressed and toggle from the keyboard; the two groups are labelled
// distinctly ("Split method" / "Savings split method").
test('allocation split controls expose aria-pressed and toggle via keyboard (UX-013)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/allocation')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // Open the settings modal (the profile fixture makes the card + Settings render).
  await page.getByRole('button', { name: 'Allocation settings' }).click()
  // "Split method" is a substring of "Savings split method", so match it exactly.
  const splitGroup = page.getByRole('group', { name: 'Split method', exact: true })
  const savingsGroup = page.getByRole('group', { name: 'Savings split method' })
  await expect(splitGroup).toBeVisible()
  await expect(savingsGroup).toBeVisible()

  // Cost split starts Equally (fixture split = SplitMethod.Equal).
  const equally = splitGroup.getByRole('button', { name: 'Equally' })
  const byIncome = splitGroup.getByRole('button', { name: 'By income' })
  await expect(equally).toHaveAttribute('aria-pressed', 'true')
  await expect(byIncome).toHaveAttribute('aria-pressed', 'false')

  // Keyboard-activate "By income" (scoped to this group; the label also exists in
  // the savings group) → pressed state flips.
  await byIncome.press('Enter')
  await expect(byIncome).toHaveAttribute('aria-pressed', 'true')
  await expect(equally).toHaveAttribute('aria-pressed', 'false')

  // Savings split starts on Balance (fixture savings split = SplitMethod.BalanceTilt).
  await expect(savingsGroup.getByRole('button', { name: 'Balance' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

// UX-013 — the bill "Mark {line} paid" button is an aria-pressed toggle,
// keyboard-operable; activating it flips pressed + relabels to "unpaid".
test('bill Paid button is an aria-pressed toggle, keyboard-operable (UX-013)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // The Rent line is a bill (dueDay set), so its Paid toggle renders.
  const paid = page.getByRole('button', { name: 'Mark Rent paid' })
  await expect(paid).toHaveAttribute('aria-pressed', 'false')
  await expect(paid).toBeEnabled()

  // Enter marks it paid (optimistic + stubbed 200 keeps the state) → pressed flips
  // and the accessible name becomes the "unpaid" affordance.
  await paid.press('Enter')
  const nowPaid = page.getByRole('button', { name: 'Mark Rent unpaid' })
  await expect(nowPaid).toHaveAttribute('aria-pressed', 'true')
})

// ---------------------------------------------------------------------------
// Reorder arrows (UX-012 + UX-022)
// ---------------------------------------------------------------------------

// UX-012 + UX-022 — line and group reorder arrows are real <button>s with unique
// aria-labels ("Move {name} up/down") and title tooltips, disabled at the ends of
// the list (with the single-group/single-line fixtures both ends coincide).
test('reorder arrows are labelled buttons with titles, disabled at the ends (UX-012, UX-022)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // Group arrows (CategoryAccordion). "Housing" is the only expense group, so it
  // is both first and last → both arrows are disabled (end-of-list convention).
  const groupUp = page.getByRole('button', { name: 'Move Housing up' })
  const groupDown = page.getByRole('button', { name: 'Move Housing down' })
  await expect(groupUp).toHaveAttribute('title', 'Move group up')
  await expect(groupDown).toHaveAttribute('title', 'Move group down')
  await expect(groupUp).toBeDisabled()
  await expect(groupDown).toBeDisabled()

  // Line arrows (BudgetItemRow). "Rent" is the only line → both disabled too.
  const lineUp = page.getByRole('button', { name: 'Move Rent up' })
  const lineDown = page.getByRole('button', { name: 'Move Rent down' })
  await expect(lineUp).toHaveAttribute('title', 'Move line up')
  await expect(lineDown).toHaveAttribute('title', 'Move line down')
  await expect(lineUp).toBeDisabled()
  await expect(lineDown).toBeDisabled()

  // They are genuine buttons, not click-wired divs.
  for (const b of [groupUp, groupDown, lineUp, lineDown]) {
    expect(await b.evaluate((el) => el.tagName)).toBe('BUTTON')
  }
})

// UX-022 / WCAG 2.5.8 (Target Size Minimum, AA) — reorder arrows should present a
// ≥24×24 CSS-px hit area. See the BUG skip below: the current arrows are smaller.
test('reorder arrows meet the WCAG 2.5.8 24px minimum target size (UX-022)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  for (const name of ['Move Rent up', 'Move Rent down', 'Move Housing up', 'Move Housing down']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box, name).not.toBeNull()
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(24)
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(24)
  }
})

// ---------------------------------------------------------------------------
// Motion (UX-049)
// ---------------------------------------------------------------------------

// UX-049 — prefers-reduced-motion collapses non-essential motion: the global
// index.css reset forces transition/animation durations to ~0. Proven by flipping
// the emulated media and re-reading a transitioning control's computed duration.
test('prefers-reduced-motion collapses transition durations app-wide (UX-049)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // A control that carries a Tailwind `transition` (non-zero default duration).
  const button = page.getByRole('button', { name: 'Light mode' })
  const durationSeconds = () =>
    button.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))

  // reduce → the media-query reset neutralises the transition (~0.01ms).
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await durationSeconds()).toBeLessThan(0.005)

  // no-preference → the transition runs at its normal (non-zero) duration, proving
  // it is the media query — not a baseline of zero — that collapses it.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await durationSeconds()).toBeGreaterThan(0.05)
})
