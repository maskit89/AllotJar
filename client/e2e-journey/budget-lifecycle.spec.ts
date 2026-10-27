import { expect, test, type Page } from '@playwright/test'
import {
  addAccount,
  createGoalJar as createJarHeldIn,
  groupAction,
  jarAction,
  lineAction,
  register,
  suppressOnboarding,
} from './helpers'

/**
 * Month lifecycle through the real stack (the BUDG/DASH deferred set): creating the
 * viewed month blank / from a template / by copying the previous month against live
 * SQL, the exact copy semantics (planned carried flat, DueDay carried + IsPaid reset,
 * archived-jar lines dropped, seedable jars re-seeded from the accrual calculator),
 * the PR #172 hero states (empty month prompts for income and never celebrates; a
 * jar-owning household's blank month is born over-budgeted), the friendly
 * duplicate-create recovery, TopBar month navigation moving every month-scoped screen
 * together, the month-scoped jars shelf (W05), and optimistic rename/delete/bill
 * round-trips that must survive a full reload (i.e. really persisted server-side).
 *
 * Each test registers its own fresh user so the specs stay isolated.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The month `offset` months away from the real current month (the app's clock). */
function monthAt(offset: number): { year: number; month: number; label: string } {
  const now = new Date()
  const t = now.getFullYear() * 12 + now.getMonth() + offset
  const year = Math.floor(t / 12)
  const month = (t % 12) + 1
  return { year, month, label: `${MONTH_NAMES[month - 1]} ${year}` }
}

/**
 * Run a mutation and wait for its API response to land (2xx). Optimistic UI makes the
 * DOM update before the server confirms, so without this a later full-stack assertion
 * (navigate away / reload) could race the in-flight write.
 */
async function committed(
  page: Page,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string | ((u: string) => boolean),
  action: () => Promise<void>,
): Promise<void> {
  const matches = typeof url === 'string' ? (u: string) => u.includes(url) : url
  const done = page.waitForResponse(
    (r) => r.request().method() === method && matches(r.url()) && r.ok(),
  )
  await action()
  await done
}

/** The month-create POST is exactly /api/budget (…/categories etc. must not match). */
const createMonthUrl = (u: string) => u.endsWith('/api/budget')

/**
 * Commit an inline planned-amount edit: the at-rest formatted button opens the raw
 * editor; Enter blurs, which commits (React maps onBlur→focusout). A row freshly added
 * in this session can be reconciled (temp id → server id) between our click and the
 * editor appearing, which unmounts the editor — reopen once if that race hits.
 */
async function setPlanned(page: Page, lineName: string, value: string): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`^Planned amount for ${lineName}: `) })
  const input = page.getByRole('textbox', { name: `Planned amount for ${lineName}` })
  await button.click()
  try {
    await input.waitFor({ state: 'visible', timeout: 2_000 })
  } catch {
    await button.click() // the add-line reconcile swapped the row out mid-click
    await input.waitFor({ state: 'visible' })
  }
  await input.fill(value)
  await committed(page, 'PUT', '/api/budget/items/', () => input.press('Enter'))
}

/**
 * Create a Goal jar (Repeats "Doesn’t repeat") through the one jar form: saving by a "Needed by"
 * date twelve months out (so twelve contribution months plan target ÷ 12), or — with `monthly` —
 * ticking "Set aside a fixed amount each month" (an ongoing pot when `target` is empty, rule 16).
 * Every jar is held in an account (rule 73), so the household's "Pot" account is created on
 * first use.
 */
async function createGoalJar(
  page: Page,
  name: string,
  target: string,
  plan: { setAside?: string; monthly?: string } = {},
): Promise<void> {
  await page.getByRole('link', { name: 'Accounts', exact: true }).click()
  // The list renders only after its fetch; counting before that would add a second Pot.
  await expect(page.getByRole('heading', { name: 'Your accounts', exact: true })).toBeVisible()
  if ((await page.getByRole('link', { name: 'View Pot', exact: true }).count()) === 0) {
    await addAccount(page, { name: 'Pot', opening: '5000' })
  }
  await createJarHeldIn(page, { name, target, heldIn: 'Pot', ...plan })
}

test('a jar-less blank month prompts for income, and a duplicate create fails friendly', async ({
  page,
}) => {
  const { email } = await register(page)

  // BUDG-055 / DASH-006: the first-ever month offers blank + templates, and no Start button
  // that would continue an earlier month (none exists).
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  await expect(page.getByText('Or start from a template')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Start (?!a blank)/ })).toHaveCount(0)

  // A second tab (same session via the shared refresh cookie) parks on the same
  // create card — it will lose the create race below (BUDG-048 / DASH-012).
  const tabB = await page.context().newPage()
  await suppressOnboarding(tabB, email)
  await tabB.goto('/')
  await expect(tabB.getByText(/No budget for .+ yet/)).toBeVisible()

  // BUDG-001 / DASH-008: blank create for a jar-less household lands on a real,
  // truly-empty month — Income group only.
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(page.getByText('No income yet', { exact: true })).toBeVisible()
  // BUDG-002: exactly the Income group — no expense group, no Savings group. Every group has
  // a ⋯ named after it; only Income's is there, and no group can be renamed (Income can't).
  await expect(page.getByRole('button', { name: / group: more actions$/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Income group: more actions', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: /^Rename group / })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Rename group Savings' })).toHaveCount(0)

  // DASH-016 / BUDG-001 (PR #172): remaining €0.00 reads as the neutral
  // plan-your-income prompt — never the gold "Every euro has a job" badge.
  await expect(page.getByLabel('Remaining to budget: €0.00')).toBeVisible()
  await expect(page.getByText('Plan your income, then give every euro a job')).toBeVisible()
  await expect(page.getByText('Every euro has a job')).toHaveCount(0)

  // BUDG-048 / DASH-012: tab B's stale create card now posts a duplicate month. The
  // server's friendly 400 is swallowed into the fixed strip; the create UI survives.
  await tabB.getByRole('button', { name: 'Start a blank budget' }).click()
  await expect(tabB.getByText('Could not create that budget.')).toBeVisible()
  await expect(tabB.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()

  // No duplicate/corrupt month: a reload lands tab B on the one real (empty) month.
  await tabB.reload()
  await expect(tabB.getByText('Remaining to budget')).toBeVisible()
  await expect(tabB.getByRole('heading', { name: 'Income' })).toBeVisible()
  await tabB.close()
})

test('creating from the Essentials template builds its catalogue structure with no savings lines', async ({
  page,
}) => {
  await register(page)

  // DASH-009 / BUDG-021: the real /api/budget/templates catalogue renders the three
  // cards; Essentials carries its exact description and groups·lines count.
  const essentials = page.getByRole('button', { name: /^Start from the template: Essentials/ })
  await expect(essentials).toContainText(
    'A clean starting point covering the bills most households share.',
  )
  await expect(essentials).toContainText('5 groups · 12 lines')
  await expect(page.getByRole('button', { name: /^Start from the template: Student/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Start from the template: Family/ })).toBeVisible()

  // BUDG-020 / DASH-010: Essentials builds Income / Housing / Food / Transport /
  // Lifestyle with the template's named lines, every planned amount zero. Rule 81:
  // templates carry no savings lines — jars come only from the jar form.
  await committed(page, 'POST', createMonthUrl, () => essentials.click())
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Take-home Pay')
  for (const group of ['Housing', 'Food', 'Transport', 'Lifestyle']) {
    await expect(page.getByRole('textbox', { name: `Rename group ${group}` })).toBeVisible()
  }
  await expect(page.getByRole('textbox', { name: 'Rename Rent / Mortgage' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Savings' })).toHaveCount(0)
  await expect(page.getByText('avail.')).toHaveCount(0)

  // BUDG-020 hero: all-zero planned + zero income = the empty prompt, no gold badge.
  await expect(page.getByLabel('Remaining to budget: €0.00')).toBeVisible()
  await expect(page.getByText('Plan your income, then give every euro a job')).toBeVisible()
  await expect(page.getByText('Every euro has a job')).toHaveCount(0)

  // BUDG-022 / JAR-060: the template minted NO jar. A reload refetches /jars — no shelf,
  // and the first-run checklist still asks for an account and a jar.
  await page.reload()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Jars', exact: true })).toHaveCount(0)
  await expect(page.getByText('Emergency Fund')).toHaveCount(0)
  const setup = page.getByRole('region', { name: 'Set up your budget' })
  await expect(setup.getByRole('link', { name: 'Go to accounts' })).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Add jar' })).toBeDisabled()
})

test('a jar-owning household’s blank month is born over-budgeted with an accrual-planned savings line', async ({
  page,
}) => {
  await register(page)

  // Own a jar before any month exists: one that doesn't repeat (a Goal), target 1,200.00, needed
  // by the 1st of the month twelve months out → twelve contribution months plan 1,200 ÷ 12 =
  // 100.00/mo (rules 12, 35, 36).
  // (Held in the Pot account, rule 73.)
  await createGoalJar(page, 'Holiday', '1200')

  await page.getByRole('link', { name: 'Dashboard' }).click()

  // BUDG-028 / BUDG-056 / DASH-020 (PR #172): blank create appends the jar's line at
  // its accrual requirement, so the month is born OVER-BUDGETED — income €0.00,
  // allotted €100.00 — with the rose trim-a-line footnote, NOT the income prompt and
  // NOT the gold badge.
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  // The overrun is the hero's gold number; its chip says what to do without repeating the amount.
  await expect(page.getByLabel('Remaining to budget: -€100.00')).toHaveText('-€100.00')
  await expect(page.getByText('Over-budgeted — trim a line')).toBeVisible()
  await expect(page.getByText('Plan your income, then give every euro a job')).toHaveCount(0)
  await expect(page.getByText('Every euro has a job')).toHaveCount(0)

  // BUDG-031: the append step created a "Savings" group (blank makes only Income);
  // the Holiday fund line is planned at the accrual figure with €0.00 available.
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Savings' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename Holiday' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Planned amount for Holiday:/ })).toHaveText(
    'Planned amount for Holiday: €100.00',
  )

  // JAR-060 / DASH-027: the current-month shelf (the Jars card) shows the jar with its monthly
  // set-aside (no status chip for a healthy OnTrack jar — chip and +/mo are exclusive). The
  // line's name is an input's value and its planned amount's screen-reader text only contains it,
  // so the only text that is exactly "Holiday" is the jar on the shelf.
  await expect(page.getByRole('heading', { name: 'Jars', exact: true })).toBeVisible()
  await expect(page.getByText('Holiday', { exact: true })).toBeVisible()
  await expect(page.getByText('+€100.00/mo')).toBeVisible()
})

test('copy-from-previous: planned carried, DueDay carried with IsPaid reset, archived jar dropped, seedable jar re-seeded; edits persist', async ({
  page,
}) => {
  const next = monthAt(1)
  await register(page)

  // --- Fixture: two Goal jars (held in the Pot account), then a current-month budget built through the UI ---
  // Holiday holds 100.00 set aside today (rule 77). Money set aside counts as the balance the
  // month opened with, not as this month's saving (SC-P2-1): (1,200 − 100) ÷ 12 = 91.66/mo.
  await createGoalJar(page, 'Holiday', '1200', { setAside: '100' })
  await createGoalJar(page, 'Old Boiler', '600') // 600 ÷ 12 = 50.00/mo — archived below

  await page.getByRole('link', { name: 'Dashboard' }).click()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  // Both jars were appended into the fresh month at their accrual requirements.
  await expect(page.getByRole('button', { name: /^Planned amount for Holiday:/ })).toHaveText(
    'Planned amount for Holiday: €91.66',
  )
  await expect(page.getByRole('button', { name: /^Planned amount for Old Boiler:/ })).toHaveText(
    'Planned amount for Old Boiler: €50.00',
  )

  // Income: Salary planned 2,500.00 (the add row reconciles from the POST response). The add
  // row opens from the Income group's ⋯.
  await groupAction(page, 'Income', 'Add income source')
  const addIncome = page.getByRole('textbox', { name: 'New income source name' })
  await addIncome.fill('Salary')
  await committed(page, 'POST', '/items', () => addIncome.press('Enter'))
  await setPlanned(page, 'Salary', '2500')

  // Expense group Housing with a Rent line planned 1,000.00.
  await page.getByRole('button', { name: 'Add a group' }).click()
  const addGroup = page.getByRole('textbox', { name: 'New category group name' })
  await addGroup.fill('Housing')
  await committed(page, 'POST', '/api/budget/categories', () => addGroup.press('Enter'))
  await groupAction(page, 'Housing', 'Add line')
  const addLine = page.getByRole('textbox', { name: 'Add a line to Housing' })
  await addLine.fill('Rent')
  await committed(page, 'POST', '/items', () => addLine.press('Enter'))
  await setPlanned(page, 'Rent', '1000')

  // Raise Holiday's plan for this month to 200.00 — a hand edit the copy must re-plan, not carry.
  await setPlanned(page, 'Holiday', '200')

  // DASH-053: track Rent as a bill due day 1 (from the line's ⋯) — the Bills left tile appears.
  await lineAction(page, 'Rent', 'Bill due day')
  // The due-day editor is a text input (inputMode=numeric) — type=number has no selection APIs,
  // which select-on-focus needs — so its role is textbox, not spinbutton.
  await page.getByRole('textbox', { name: 'Due day for Rent' }).fill('1')
  await committed(page, 'PUT', '/bill', () =>
    page.getByRole('button', { name: 'Save due day for Rent' }).click(),
  )
  const bills = page.getByRole('group', { name: 'Bills left', exact: true })
  await expect(bills).toContainText('0/1 paid')

  // DASH-056: mark it paid from the line's ⋯ — optimistic toggle; the line reads Paid, its ⋯
  // now offers Mark unpaid, and the Bills left tile reads all paid (its ok tone).
  await committed(page, 'PUT', '/paid', () => lineAction(page, 'Rent', 'Mark paid'))
  await page.getByRole('button', { name: 'Rent: more actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Mark unpaid', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bills).toContainText('1/1 paid')
  await expect(bills.locator('[data-tone="ok"]')).toHaveText('1/1 paid')

  // Archive Old Boiler (two-step confirm, in its edit form from the jar's ⋯) — copying must now
  // drop its line.
  await page.getByRole('link', { name: 'Jars' }).click()
  await jarAction(page, 'Old Boiler', 'Edit')
  await page.getByRole('button', { name: 'Archive jar' }).click()
  await committed(page, 'PUT', '/archive', () =>
    page.getByRole('button', { name: 'Really archive?' }).click(),
  )
  await expect(page.getByRole('heading', { name: 'Old Boiler' })).toHaveCount(0)

  // --- Copy the current month into the next one (BUDG-038/040: ‹› + real source name) ---
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label, exact: true })).toBeVisible()
  await expect(page.getByText(`No budget for ${next.label} yet.`)).toBeVisible()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: `Start ${MONTH_NAMES[next.month - 1]}` }).click(),
  )

  // BUDG-005: structure + planned amounts copied flat; actuals reset (no transactions).
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Salary')
  await expect(page.getByRole('button', { name: /^Planned amount for Salary:/ })).toHaveText(
    'Planned amount for Salary: €2,500.00',
  )
  await expect(page.getByRole('group', { name: 'Income', exact: true })).toContainText('€0.00 received')
  await expect(page.getByRole('textbox', { name: 'Rename group Housing' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Planned amount for Rent:/ })).toHaveText(
    'Planned amount for Rent: €1,000.00',
  )

  // BUDG-008: the due day carried (Rent is still a bill) but paid state did NOT —
  // the new month starts unpaid.
  await expect(page.getByRole('group', { name: 'Bills left', exact: true })).toContainText('0/1 paid')
  await page.getByRole('button', { name: 'Rent: more actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Mark paid', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // BUDG-015: Holiday is scheduled, so its line is RE-PLANNED for the new month rather than
  // copied flat at the 200.00 hand edit. The balance entering next month is projected through
  // this month's saved plan (rule 13 / HANDOVER P27): the 100.00 set aside (the month's
  // opening, SC-P2-1) + 200.00 planned. (1,200 − 300) over the eleven remaining contribution
  // months = 81.81 (rule 35 floors to the cent; the remainder lands in the final month).
  await expect(page.getByRole('button', { name: /^Planned amount for Holiday:/ })).toHaveText(
    'Planned amount for Holiday: €81.81',
  )

  // BUDG-017 / BUDG-032: the archived jar's line was dropped and not re-appended.
  await expect(page.getByRole('textbox', { name: 'Rename Old Boiler' })).toHaveCount(0)

  // The hero locks the whole copy in one figure: 2,500 − (1,000 + 81.81) = 1,418.19.
  await expect(page.getByLabel('Remaining to budget: €1,418.19')).toBeVisible()
  await expect(page.getByText('€1,081.81 allotted')).toBeVisible()

  // --- Optimistic round-trips on the copied month (DASH-032 / DASH-043 / DASH-048) ---
  const incomeName = page.getByRole('textbox', { name: 'Income source name', exact: true })
  await incomeName.fill('Consulting')
  await committed(page, 'PUT', '/api/budget/items/', () => incomeName.press('Enter'))

  const groupName = page.getByRole('textbox', { name: 'Rename group Housing' })
  await groupName.fill('Home')
  await committed(page, 'PUT', '/api/budget/categories/', () => groupName.press('Enter'))

  // DASH-048: deleting the Rent line (its ⋯ Delete) needs no confirm; the Bills left tile (its
  // only bill) vanishes and the pool recovers the €1,000.00 instantly.
  await committed(page, 'DELETE', '/api/budget/items/', () => lineAction(page, 'Rent', 'Delete'))
  await expect(page.getByRole('textbox', { name: 'Rename Rent' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Bills left', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Remaining to budget: €2,418.19')).toBeVisible()

  // --- Full reload: every optimistic edit must have really landed server-side ---
  await page.reload()
  await expect(page.getByText('Remaining to budget')).toBeVisible() // current month loads
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label, exact: true })).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Consulting')
  await expect(page.getByRole('textbox', { name: 'Rename group Home' })).toBeVisible()
  await expect(page.getByLabel('Remaining to budget: €2,418.19')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Planned amount for Holiday:/ })).toHaveText(
    'Planned amount for Holiday: €81.81',
  )
  await expect(page.getByRole('textbox', { name: 'Rename Rent' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Bills left', exact: true })).toHaveCount(0)
})

test('month navigation moves every screen together; the jars shelf follows the month; year boundaries roll', async ({
  page,
}) => {
  const prev = monthAt(-1)
  const next = monthAt(1)

  // Nothing is seeded (rule 81): build a real current month from the Essentials template, then
  // add an ongoing pot — a Goal with no target that sets aside a fixed 250.00 each month
  // (rule 16), held in the Pot account — whose line lands in the month.
  await register(page, { starterBudget: true })
  await createGoalJar(page, 'Emergency Fund', '', { monthly: '250' })
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  // A jar created while the month exists plants its contribution line there at its plan
  // (rule 46); hand-edit this month's line to 300.00.
  await expect(page.getByRole('textbox', { name: 'Rename Emergency Fund' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^Planned amount for Emergency Fund:/ }),
  ).toHaveText('Planned amount for Emergency Fund: €250.00')
  await setPlanned(page, 'Emergency Fund', '300')
  // Income 3,000 so the copied month has 800.00 left to budget after the 2,200 below.
  await groupAction(page, 'Income', 'Add income source')
  const addIncome = page.getByRole('textbox', { name: 'New income source name' })
  await addIncome.fill('Salary')
  await committed(page, 'POST', '/items', () => addIncome.press('Enter'))
  await setPlanned(page, 'Salary', '3000')
  await setPlanned(page, 'Rent / Mortgage', '1950')

  // JAR-060 / DASH-028: on the current calendar month the Jars card's shelf renders with
  // today's figures and no "as of" caption.
  await expect(page.getByRole('heading', { name: 'Jars', exact: true })).toBeVisible()
  await expect(page.getByText(/balances as of today|saved as of/)).toHaveCount(0)

  // BUDG-038: ‹ moves to the previous month — no budget there for this fresh user,
  // and nothing to continue (no month exists strictly before it): only a blank start, and no
  // templates, which are for a household's first budget.
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.getByRole('heading', { name: prev.label, exact: true })).toBeVisible()
  await expect(page.getByText(`No budget for ${prev.label} yet.`)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Start (?!a blank)/ })).toHaveCount(0)
  await expect(page.getByText('Or start from a template')).toHaveCount(0)

  // BUDG-042: the viewed month is app-wide MonthContext state — Transactions opens
  // on the same (previous) month, and Budget still shows it on the way back.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByLabel(new RegExp(`^Income for ${prev.label}:`))).toBeVisible()
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByText(`No budget for ${prev.label} yet.`)).toBeVisible()

  // BUDG-040: › twice reaches the (creatable) next month, which continues the current one.
  await page.getByRole('button', { name: 'Next month' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label, exact: true })).toBeVisible()
  await expect(page.getByText(`No budget for ${next.label} yet.`)).toBeVisible()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: `Start ${MONTH_NAMES[next.month - 1]}` }).click(),
  )

  // BUDG-016: the Emergency Fund pot is re-planned at its fixed 250.00 (rule 16) — the 300.00
  // hand edit is not carried flat. Remaining = 3,000 − (1,950 + 250).
  await expect(
    page.getByRole('button', { name: /^Planned amount for Emergency Fund:/ }),
  ).toHaveText('Planned amount for Emergency Fund: €250.00')
  await expect(page.getByLabel('Remaining to budget: €800.00')).toBeVisible()

  // DASH-028 / DASH-074 / JAR-061 (W05, rule 48): a loaded month that has not begun keeps the
  // shelf, read for that month — today's balances, labelled so, with the month's own plan
  // (the re-planned 250.00, not this month's 300.00 hand edit).
  await expect(page.getByRole('heading', { name: 'Jars', exact: true })).toBeVisible()
  await expect(page.getByText('balances as of today')).toBeVisible()
  await expect(page.getByText('+€250.00/mo')).toBeVisible()

  // BUDG-039: December → January rolls the year forward; ‹ rolls it back.
  for (let m = next.month; m < 12; m += 1) {
    await page.getByRole('button', { name: 'Next month' }).click()
  }
  const decYear = next.year
  await expect(page.getByRole('heading', { name: `December ${decYear}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: `January ${decYear + 1}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.getByRole('heading', { name: `December ${decYear}`, exact: true })).toBeVisible()
})
