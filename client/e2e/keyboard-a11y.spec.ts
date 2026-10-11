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

  // Tab 2 → the first primary-nav link ("Dashboard").
  await page.keyboard.press('Tab')
  const navRing = await ringOf()
  expect(navRing?.name).toBe('Dashboard')
  expectVisibleRing(navRing)
})

// UX-014 — the month navigator arrows are labelled buttons and keyboard-operable;
// activating them moves the app-wide viewed month (the <h2> label in the top bar's
// "Month" group updates).
test('month navigator arrows are labelled and keyboard-operable (UX-014)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const prev = page.getByRole('button', { name: 'Previous month' })
  const next = page.getByRole('button', { name: 'Next month' })
  const monthLabel = page.getByRole('group', { name: 'Month' }).getByRole('heading', { level: 2 })
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

// UX-017 — every authenticated route exposes exactly one <h1> (the page title in
// the AppShell top bar), never zero or two.
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
  const budget = nav.getByRole('link', { name: 'Dashboard' })
  await expect(budget).toHaveAttribute('aria-current', 'page')
  // A non-active item does not carry the marker.
  await expect(nav.getByRole('link', { name: 'Transactions' })).not.toHaveAttribute('aria-current', 'page')
})

// ---------------------------------------------------------------------------
// aria-pressed toggle controls, keyboard-operated (UX-013 + the bill Paid toggle)
// ---------------------------------------------------------------------------

// UX-013 — the top bar's theme control is one aria-pressed toggle <button> named
// "Dark mode", operable with the keyboard; activating it flips the pressed state
// and applies the .dark class app-wide, and again brings light back.
test('theme toggle exposes aria-pressed and is keyboard-operable (UX-013)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const dark = page.getByRole('button', { name: 'Dark mode', exact: true })
  await expect(dark).toBeVisible()

  // Starts in light: Dark mode not pressed.
  await expect(dark).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // Keyboard-activate it → pressed state flips and the app goes dark.
  await dark.press('Enter')
  await expect(dark).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveClass(/dark/)

  // Space flips it back to light.
  await dark.press(' ')
  await expect(dark).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
})

// The account menu (the sidebar's account button on desktop) is a keyboard menu:
// Enter opens it with focus inside, its Dark mode switch is a menuitemcheckbox in
// step with the top bar's button, Escape closes it and focus returns to the button.
test('the account menu opens, switches the theme and closes from the keyboard', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const trigger = page.getByRole('button', { name: /account menu/i })
  await expect(trigger).toHaveCount(1) // the phone avatar is display:none at desktop width
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Account settings' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  // A single household: no switcher.
  await expect(menu.getByText('Household', { exact: true })).toHaveCount(0)

  // The Dark mode switch: a checkbox item; choosing it keeps the menu open.
  const sw = menu.getByRole('menuitemcheckbox', { name: 'Dark mode' })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await sw.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect(menu).toBeVisible()

  // Escape closes the menu and returns focus to the account button.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  // The top bar's button followed the switch.
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

// The menu's items carry a focus outline for the keyboard only. Pointing at an item with the mouse
// highlights it quietly (Chrome would otherwise count the focus Radix moves there as
// :focus-visible); the first arrow key brings the outline back.
test('the account menu shows its focus outline to the keyboard, not the mouse', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const trigger = page.getByRole('button', { name: /account menu/i })
  const box = (await trigger.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()

  const look = (item: import('@playwright/test').Locator) =>
    item.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { focused: el === document.activeElement, color: cs.outlineColor, bg: cs.backgroundColor }
    })
  const signOut = menu.getByRole('menuitem', { name: 'Sign out' })
  const box2 = (await signOut.boundingBox())!
  await page.mouse.move(box2.x + 60, box2.y + box2.height / 2, { steps: 4 })
  await expect.poll(async () => (await look(signOut)).focused).toBe(true)
  const hovered = await look(signOut)
  expect(hovered.color, 'no outline under the mouse').toBe('rgba(0, 0, 0, 0)')
  expect(hovered.bg, 'the quiet highlight').not.toBe('rgba(0, 0, 0, 0)')

  // (Radix moves focus a tick after the key, hence the poll.)
  const darkMode = menu.getByRole('menuitemcheckbox', { name: 'Dark mode' })
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await look(darkMode)).focused).toBe(true)
  expect((await look(darkMode)).color, 'the ring colour for the keyboard').not.toBe('rgba(0, 0, 0, 0)')
})

// On a phone the More tab opens a modal sheet (a dialog) with the remaining pages,
// the account, a Dark mode switch and Sign out; Escape closes it and focus returns
// to More.
test('the phone More sheet opens and closes from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const tabs = page.getByRole('navigation', { name: 'Primary' })
  await expect(tabs).toHaveCount(1) // the sidebar is display:none on a phone
  for (const name of ['Dashboard', 'Transactions', 'Jars', 'Reports'])
    await expect(tabs.getByRole('link', { name })).toBeVisible()
  await expect(tabs.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')

  const more = tabs.getByRole('button', { name: 'More' })
  await more.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'More' })
  await expect(sheet).toBeVisible()
  // The sheet is modal: the tab bar behind it is hidden from the accessibility tree while it is
  // open, so the trigger is read by its slot here.
  await expect(page.locator('[data-tabbar] [data-slot="sheet-trigger"]')).toHaveAttribute('aria-expanded', 'true')
  const pages = sheet.getByRole('navigation', { name: 'More pages' })
  for (const name of ['Accounts', 'People', 'Allocation', 'Import', 'Help'])
    await expect(pages.getByRole('link', { name })).toBeVisible()
  await expect(sheet.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'false')
  await expect(sheet.getByRole('button', { name: 'Sign out' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(more).toBeFocused()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
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

// UX-013 — marking a bill paid is keyboard-operable: the line's ⋯ menu opens from the
// keyboard, "Mark paid" is a real menu item, and choosing it flips the line's chip to
// Paid and the item to "Mark unpaid" (restyle PR 3 moved the toggle into the ⋯).
test('bill Mark paid is keyboard-operable from the line\'s ⋯ menu (UX-013)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // The Rent line is a bill (dueDay set), so its menu offers Mark paid.
  const more = page.getByRole('button', { name: 'Rent: more actions' })
  const row = more.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " group ")][1]')
  await expect(row.getByText('Paid', { exact: true })).toHaveCount(0)
  await more.focus()
  await page.keyboard.press('Enter')
  const markPaid = page.getByRole('menuitem', { name: 'Mark paid' })
  await expect(markPaid).toBeEnabled()

  // Enter on the item marks it paid (optimistic + stubbed 200 keeps the state): the
  // menu closes, focus returns to the ⋯, the chip reads Paid.
  await markPaid.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()
  await expect(row.getByText('Paid', { exact: true })).toBeVisible()

  // The menu now offers the "unpaid" affordance.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Mark unpaid' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
})

// ---------------------------------------------------------------------------
// Reorder (UX-012 + UX-022)
// ---------------------------------------------------------------------------

// UX-012 + UX-022 — line and group reordering are real menu items in the ⋯ menus
// ("Move up" / "Move down", named by their visible text — no title tooltips),
// disabled at the ends of the list (with the single-group/single-line fixtures
// both ends coincide); the ⋯ buttons are genuine buttons named after their row.
test('reorder items are labelled menu items, disabled at the ends (UX-012, UX-022)', async ({
  page,
}) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  // The group's ⋯. "Housing" is the only expense group, so it is both first and
  // last → both moves are disabled (end-of-list convention).
  const groupMore = page.getByRole('button', { name: 'Housing group: more actions' })
  await groupMore.click()
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveText('Move up')
  await page.keyboard.press('Escape')
  await expect(groupMore).toBeFocused()

  // The line's ⋯. "Rent" is the only line → both disabled too.
  const lineMore = page.getByRole('button', { name: 'Rent: more actions' })
  await lineMore.click()
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveText('Move down')
  await page.keyboard.press('Escape')
  await expect(lineMore).toBeFocused()

  // They are genuine buttons, not click-wired divs.
  for (const b of [groupMore, lineMore]) {
    expect(await b.evaluate((el) => el.tagName)).toBe('BUTTON')
  }
})

// UX-022 / WCAG 2.5.8 (Target Size Minimum, AA) — the ⋯ buttons that hold the
// reorder actions, and the menu items themselves, present a ≥24×24 CSS-px hit area.
test('reorder controls meet the WCAG 2.5.8 24px minimum target size (UX-022)', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  for (const name of ['Rent: more actions', 'Housing group: more actions']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box, name).not.toBeNull()
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(24)
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(24)
  }
  await page.getByRole('button', { name: 'Rent: more actions' }).click()
  for (const name of ['Move up', 'Move down']) {
    const box = await page.getByRole('menuitem', { name }).boundingBox()
    expect(box, name).not.toBeNull()
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(24)
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(24)
  }
})

// Restyle PR 4 — a jar's actions sit behind its ⋯ on the Jars page: a real button named after the
// jar, a menu the arrow keys move through, Escape closing it with focus back on the ⋯, and a
// dialog opened from it giving focus back to the ⋯ when it closes. The ⋯ meets the 24px minimum.
test('a jar\'s ⋯ menu works from the keyboard and gives focus back when its dialog closes', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/jars')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const more = page.getByRole('button', { name: 'Home insurance: more actions' })
  expect(await more.evaluate((el) => el.tagName)).toBe('BUTTON')
  const box = await more.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)

  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Mark paid' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Move money' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(more).toBeFocused()

  // Edit from the menu; Escape closes the form and the focus is back on the ⋯.
  await page.keyboard.press('Enter')
  await menu.getByRole('menuitem', { name: 'Edit' }).click()
  await page.getByRole('dialog').getByLabel('Jar name').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(more).toBeFocused()
})

// Archiving removes the card whose ⋯ the dialog would give focus back to: focus moves on to the
// next card's ⋯ instead of falling to the page.
test('archiving a jar from its ⋯ by keyboard leaves focus on the next card\'s ⋯', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/jars')
  const more = page.getByRole('button', { name: 'Holiday: more actions' })
  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Mark completed' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Confirm archive Holiday' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Holiday', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Home insurance: more actions' })).toBeFocused()
})

// Restyle PR 5 — a transaction's actions sit behind its ⋯, shown while the row is hovered or holds
// focus: keyboard focus reaching the row shows it, Enter opens the menu, the arrows move through it,
// Escape gives focus back to the ⋯, and an inline editor opened from it does the same when it closes.
test('a transaction\'s ⋯ shows to the keyboard, works from it and gives focus back when its editor closes', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/transactions')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.mouse.move(0, 0)

  const more = page.getByRole('button', { name: 'Welbees Supermarket: more actions' })
  const opacity = () => more.evaluate((el) => getComputedStyle(el).opacity)
  await expect.poll(opacity).toBe('0')
  const box = await more.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)

  // Tab from the row's category chip lands on its ⋯, which shows.
  await page.getByRole('button', { name: 'Reassign Welbees Supermarket' }).focus()
  await expect.poll(opacity).toBe('1')
  await page.keyboard.press('Tab')
  await expect(more).toBeFocused()

  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Edit transaction: Welbees Supermarket' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Split transaction: Welbees Supermarket' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(more).toBeFocused()

  // Edit from the menu: the row's form opens with focus in it; Escape closes it, focus back on the ⋯.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Edit date')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Edit date')).toHaveCount(0)
  await expect(more).toBeFocused()
})

// Restyle PR 5 — the list's search: a button that turns into the field, filters as you type, and
// Escape gives focus back to the button with every row back.
test('the transactions search filters from the keyboard and Escape closes it', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/transactions')
  const rows = page.getByTestId('tx-row')
  await expect(rows).toHaveCount(9)

  const search = page.getByRole('button', { name: 'Search transactions' })
  await search.focus()
  await page.keyboard.press('Enter')
  const box = page.getByRole('searchbox', { name: 'Search transactions' })
  await expect(box).toBeFocused()
  await page.keyboard.type('joint') // the account of seven rows
  await expect(rows).toHaveCount(7)
  await page.keyboard.type('zzz')
  await expect(rows).toHaveCount(0)
  await expect(page.getByText('No match for “jointzzz”.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(search).toBeFocused()
  await expect(rows).toHaveCount(9)
})

// Restyle PR 5 — on a phone the whole row is one button that opens the row's actions in a bottom
// sheet titled with the payee; Escape closes it with focus back on the row.
test('a transaction row on a phone opens its sheet from the keyboard and gives focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authedSetup(page, 'light')
  await page.goto('/transactions')
  const row = page.getByRole('button', { name: 'Welbees Supermarket', exact: true })
  await row.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Welbees Supermarket' })
  await expect(sheet.getByRole('button', { name: 'Edit transaction: Welbees Supermarket' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Delete transaction: Welbees Supermarket' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(row).toBeFocused()
})

// Restyle PR 6 — an account's actions sit behind its card's ⋯ on the Accounts page: Enter opens the
// menu with focus on Edit, Escape gives focus back to the ⋯; Edit opens the editor in the card with
// focus on the name, and Escape closes it with focus back on the ⋯; Delete's dialog gives focus back
// to the ⋯ on Escape, and once confirmed focus moves on to the next card's ⋯.
test('an account\'s ⋯ works from the keyboard and gives focus back after the editor and the delete dialog', async ({ page }) => {
  await authedSetup(page, 'light')
  await page.goto('/accounts')
  await page.getByRole('heading', { level: 1 }).first().waitFor()

  const more = page.getByRole('button', { name: 'Joint Current: more actions' })
  expect(await more.evaluate((el) => el.tagName)).toBe('BUTTON')
  const box = await more.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)

  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Edit Joint Current' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Delete Joint Current' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(more).toBeFocused()

  // Edit: the editor opens in the card with focus on the name; Escape closes it, focus on the ⋯.
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitem', { name: 'Edit Joint Current' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Name for Joint Current')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Name for Joint Current')).toHaveCount(0)
  await expect(more).toBeFocused()

  // Delete: the confirm dialog; Escape gives focus back to the ⋯.
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitem', { name: 'Edit Joint Current' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: 'Delete Joint Current' })).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Delete Joint Current?' })
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(more).toBeFocused()

  // Confirmed: the card goes and focus moves on to the next card's ⋯.
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitem', { name: 'Edit Joint Current' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: 'Delete Joint Current' })).toBeFocused()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  const confirm = dialog.getByRole('button', { name: 'Confirm delete Joint Current' })
  await confirm.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: 'View Joint Current', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Savings Joint: more actions' })).toBeFocused()
})

// On a phone an account's ⋯ opens its actions in a bottom sheet titled with the account's name;
// Escape closes it with focus back on the ⋯.
test('an account\'s ⋯ on a phone opens its sheet from the keyboard and gives focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authedSetup(page, 'light')
  await page.goto('/accounts')
  const more = page.getByRole('button', { name: 'Savings Joint: more actions' })
  await more.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Savings Joint' })
  await expect(sheet.getByRole('button', { name: 'Edit Savings Joint' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Delete Savings Joint' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(more).toBeFocused()
})

// Reports on a phone: the Trend header draws the year on the title's line and Chart | Table
// across the card under it, and focus follows what is drawn (title's (i), the year, the switch).
// The Assign chip's name, as the browser computes it (no stray space before the comma).
test('the Reports Trend header on a phone takes focus in the order it is drawn', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authedSetup(page, 'light')
  await page.goto('/reports')
  const trend = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Trend', exact: true }) })
  const about = trend.getByRole('button', { name: 'About trend' })
  await about.focus()
  for (const name of ['Previous year', 'Next year', 'Chart', 'Table']) {
    await page.keyboard.press('Tab')
    await expect(trend.getByRole('button', { name, exact: true })).toBeFocused()
  }
  const year = trend.getByRole('button', { name: 'Previous year' })
  const chart = trend.getByRole('button', { name: 'Chart', exact: true })
  expect((await year.boundingBox())!.y).toBeLessThan((await chart.boundingBox())!.y)
  await expect(
    page.getByRole('link', { name: 'Assign 1, review uncategorised transactions', exact: true }),
  ).toHaveAttribute('href', '/transactions')
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
  const button = page.getByRole('button', { name: 'Dark mode', exact: true })
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
