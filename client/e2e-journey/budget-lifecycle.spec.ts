import { expect, test, type Page } from '@playwright/test'
import { addAccount, createGoalJar as createJarHeldIn, register, suppressOnboarding } from './helpers'

/**
 * Month lifecycle through the real stack (the BUDG/DASH deferred set): creating the
 * viewed month blank / from a template / by copying the previous month against live
 * SQL, the exact copy semantics (planned carried flat, DueDay carried + IsPaid reset,
 * archived-jar lines dropped, seedable jars re-seeded from the accrual calculator),
 * the PR #172 hero states (empty month prompts for income and never celebrates; a
 * jar-owning household's blank month is born over-budgeted), the friendly
 * duplicate-create recovery, TopBar month navigation moving every month-scoped screen
 * together, the current-month-only jars shelf, and optimistic rename/delete/bill
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
  const button = page.getByRole('button', { name: `Planned amount for ${lineName}` })
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
 * Create a Goal jar (no due date needed) through the one jar form. Every jar is held in an
 * account (rule 73), so the household's "Pot" account is created on first use.
 */
async function createGoalJar(page: Page, name: string, target: string): Promise<void> {
  await page.getByRole('link', { name: 'Accounts' }).click()
  if ((await page.getByRole('link', { name: 'View Pot', exact: true }).count()) === 0) {
    await addAccount(page, { name: 'Pot', opening: '5000' })
  }
  await createJarHeldIn(page, { name, target, heldIn: 'Pot' })
}

test('a jar-less blank month prompts for income, and a duplicate create fails friendly', async ({
  page,
}) => {
  const { email } = await register(page)

  // BUDG-055 / DASH-006: the first-ever month offers blank + templates but NO Copy
  // button (no strictly-earlier month exists) and no jar-append note (no jars).
  await expect(page.getByRole('button', { name: 'Start a blank budget' })).toBeVisible()
  await expect(page.getByText('Or start from a template')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Copy / })).toHaveCount(0)
  await expect(page.getByText(/existing jars? (is|are) added/)).toHaveCount(0)

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
  await expect(page.getByText('No income yet — add your first source below.')).toBeVisible()
  // BUDG-002: exactly the Income group — no expense panel, no Savings group.
  await expect(page.getByRole('heading', { name: 'Everyday spending' })).toHaveCount(0)
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
  const essentials = page.getByRole('button', { name: 'Start from the Essentials template' })
  await expect(essentials).toContainText(
    'A clean starting point covering the bills most households share.',
  )
  await expect(essentials).toContainText('5 groups · 12 lines')
  await expect(page.getByRole('button', { name: 'Start from the Student template' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start from the Family template' })).toBeVisible()

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
  await expect(page.getByRole('heading', { name: 'Your jars' })).toHaveCount(0)
  await expect(page.getByText('Emergency Fund')).toHaveCount(0)
  const setup = page.getByRole('region', { name: 'Set up your budget' })
  await expect(setup.getByRole('link', { name: 'Go to accounts' })).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Add a jar from an account' })).toBeDisabled()
})

test('a jar-owning household’s blank month is born over-budgeted with an accrual-planned savings line', async ({
  page,
}) => {
  await register(page)

  // Own a jar before any month exists: Goal, target 1,200.00, no date → the accrual
  // calculator wants (1,200 − 0) ÷ 12 = 100.00/mo. (Held in the Pot account, rule 73.)
  await createGoalJar(page, 'Holiday', '1200')

  // BUDG-029 / JAR-063: the create card tells the user their jar will be appended
  // (singular form for exactly one jar).
  await page.getByRole('link', { name: 'Budget' }).click()
  await expect(
    page.getByText(/Your 1 existing jar is added to any new budget automatically/),
  ).toBeVisible()

  // BUDG-028 / BUDG-056 / DASH-020 (PR #172): blank create appends the jar's line at
  // its accrual requirement, so the month is born OVER-BUDGETED — income €0.00,
  // allotted €100.00 — with the rose trim-a-line footnote, NOT the income prompt and
  // NOT the gold badge.
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  await expect(page.getByLabel('Remaining to budget: -€100.00')).toBeVisible()
  await expect(page.getByText('€100.00 over-budgeted — trim a line')).toBeVisible()
  await expect(page.getByText('Plan your income, then give every euro a job')).toHaveCount(0)
  await expect(page.getByText('Every euro has a job')).toHaveCount(0)

  // BUDG-031: the append step created a "Savings" group (blank makes only Income);
  // the Holiday fund line is planned at the accrual figure with €0.00 available.
  await expect(page.getByRole('heading', { name: 'Income' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Savings' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename Holiday' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Planned amount for Holiday' })).toHaveText(
    '€100.00',
  )

  // JAR-060 / DASH-027: the current-month shelf shows the jar with its monthly
  // set-aside (no status chip for a healthy OnTrack jar — chip and +/mo are exclusive).
  await expect(page.getByRole('heading', { name: 'Your jars' })).toBeVisible()
  await expect(page.getByText('Holiday')).toBeVisible()
  await expect(page.getByText('+€100.00/mo')).toBeVisible()
})

test('copy-from-previous: planned carried, DueDay carried with IsPaid reset, archived jar dropped, seedable jar re-seeded; edits persist', async ({
  page,
}) => {
  const current = monthAt(0)
  const next = monthAt(1)
  await register(page)

  // --- Fixture: two Goal jars (held in the Pot account), then a current-month budget built through the UI ---
  await createGoalJar(page, 'Holiday', '1200') // seedable: 1,200 ÷ 12 = 100.00/mo
  await createGoalJar(page, 'Old Boiler', '600') // 600 ÷ 12 = 50.00/mo — archived below

  // BUDG-029: plural jar-append note for two jars.
  await page.getByRole('link', { name: 'Budget' }).click()
  await expect(
    page.getByText(/Your 2 existing jars are added to any new budget automatically/),
  ).toBeVisible()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: 'Start a blank budget' }).click(),
  )
  // Both jars were appended into the fresh month at their accrual requirements.
  await expect(page.getByRole('button', { name: 'Planned amount for Holiday' })).toHaveText(
    '€100.00',
  )
  await expect(page.getByRole('button', { name: 'Planned amount for Old Boiler' })).toHaveText(
    '€50.00',
  )

  // Income: Salary planned 2,500.00 (the add row reconciles from the POST response).
  const addIncome = page.getByRole('textbox', { name: 'New income source name' })
  await addIncome.fill('Salary')
  await committed(page, 'POST', '/items', () => addIncome.press('Enter'))
  await setPlanned(page, 'Salary', '2500')

  // Expense group Housing with a Rent line planned 1,000.00.
  await page.getByRole('button', { name: 'Add a group' }).click()
  const addGroup = page.getByRole('textbox', { name: 'New category group name' })
  await addGroup.fill('Housing')
  await committed(page, 'POST', '/api/budget/categories', () => addGroup.press('Enter'))
  await page.getByRole('button', { name: 'Add a line to Housing' }).click()
  const addLine = page.getByRole('textbox', { name: 'Add a line to Housing' })
  await addLine.fill('Rent')
  await committed(page, 'POST', '/items', () => addLine.press('Enter'))
  await setPlanned(page, 'Rent', '1000')

  // DASH-053: track Rent as a bill due day 1 — the Bill tag and strip appear.
  await page.getByRole('textbox', { name: 'Rename Rent' }).hover()
  await page.getByRole('button', { name: 'Add a due date to Rent' }).click()
  // The due-day editor is a text input (inputMode=numeric) — type=number has no selection APIs,
  // which select-on-focus needs — so its role is textbox, not spinbutton.
  await page.getByRole('textbox', { name: 'Due day for Rent' }).fill('1')
  await committed(page, 'PUT', '/bill', () =>
    page.getByRole('button', { name: 'Save due day for Rent' }).click(),
  )
  await expect(page.getByText(/Bills: 0\/1 paid/)).toBeVisible()

  // DASH-056: mark it paid — optimistic toggle + strip flip to the celebration.
  await committed(page, 'PUT', '/paid', () =>
    page.getByRole('button', { name: 'Mark Rent paid' }).click(),
  )
  await expect(page.getByRole('button', { name: 'Mark Rent unpaid' })).toBeVisible()
  await expect(page.getByText(/Bills: 1\/1 paid/)).toBeVisible()
  await expect(page.getByText('All bills paid 🎉')).toBeVisible()

  // Archive Old Boiler (two-step confirm) — copying must now drop its line.
  await page.getByRole('link', { name: 'Jars' }).click()
  await page.getByRole('button', { name: 'Edit Old Boiler' }).click()
  await page.getByRole('button', { name: 'Archive Old Boiler' }).click()
  await committed(page, 'PUT', '/archive', () =>
    page.getByRole('button', { name: 'Confirm archive Old Boiler' }).click(),
  )
  await expect(page.getByRole('heading', { name: 'Old Boiler' })).toHaveCount(0)

  // --- Copy the current month into the next one (BUDG-038/040: ‹› + real source name) ---
  await page.getByRole('link', { name: 'Budget' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label })).toBeVisible()
  await expect(page.getByText(`No budget for ${next.label} yet.`)).toBeVisible()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: `Copy ${current.label}` }).click(),
  )

  // BUDG-005: structure + planned amounts copied flat; actuals reset (no transactions).
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Salary')
  await expect(page.getByRole('button', { name: 'Planned amount for Salary' })).toHaveText(
    '€2,500.00',
  )
  await expect(page.getByText('€0.00 received')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename group Housing' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Planned amount for Rent' })).toHaveText(
    '€1,000.00',
  )

  // BUDG-008: the due day carried (Rent is still a bill) but paid state did NOT —
  // the new month starts unpaid.
  await expect(page.getByText(/Bills: 0\/1 paid/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark Rent paid' })).toBeVisible()

  // BUDG-015: Holiday is seedable, so its line is RE-SEEDED from the accrual
  // calculator using the as-of balance — (1,200 − 100 already planned last month)
  // ÷ 12 = 91.67 — not copied flat at 100.00.
  await expect(page.getByRole('button', { name: 'Planned amount for Holiday' })).toHaveText(
    '€91.67',
  )

  // BUDG-017 / BUDG-032: the archived jar's line was dropped and not re-appended.
  await expect(page.getByRole('textbox', { name: 'Rename Old Boiler' })).toHaveCount(0)

  // The hero locks the whole copy in one figure: 2,500 − (1,000 + 91.67) = 1,408.33.
  await expect(page.getByLabel('Remaining to budget: €1,408.33')).toBeVisible()
  await expect(page.getByText('€1,408.33 still to assign')).toBeVisible()

  // --- Optimistic round-trips on the copied month (DASH-032 / DASH-043 / DASH-048) ---
  const incomeName = page.getByRole('textbox', { name: 'Income source name', exact: true })
  await incomeName.fill('Consulting')
  await committed(page, 'PUT', '/api/budget/items/', () => incomeName.press('Enter'))

  const groupName = page.getByRole('textbox', { name: 'Rename group Housing' })
  await groupName.fill('Home')
  await committed(page, 'PUT', '/api/budget/categories/', () => groupName.press('Enter'))

  // DASH-048: deleting the Rent line needs no confirm; the bills strip (its only
  // bill) vanishes and the pool recovers the €1,000.00 instantly.
  await page.getByRole('textbox', { name: 'Rename Rent' }).hover()
  await committed(page, 'DELETE', '/api/budget/items/', () =>
    page.getByRole('button', { name: 'Delete Rent' }).click(),
  )
  await expect(page.getByRole('textbox', { name: 'Rename Rent' })).toHaveCount(0)
  await expect(page.getByText(/Bills:/)).toHaveCount(0)
  await expect(page.getByLabel('Remaining to budget: €2,408.33')).toBeVisible()

  // --- Full reload: every optimistic edit must have really landed server-side ---
  await page.reload()
  await expect(page.getByText('Remaining to budget')).toBeVisible() // current month loads
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label })).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Income source name', exact: true }),
  ).toHaveValue('Consulting')
  await expect(page.getByRole('textbox', { name: 'Rename group Home' })).toBeVisible()
  await expect(page.getByLabel('Remaining to budget: €2,408.33')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Planned amount for Holiday' })).toHaveText(
    '€91.67',
  )
  await expect(page.getByRole('textbox', { name: 'Rename Rent' })).toHaveCount(0)
  await expect(page.getByText(/Bills:/)).toHaveCount(0)
})

test('month navigation moves every screen together; the jars shelf is current-month-only; year boundaries roll', async ({
  page,
}) => {
  const current = monthAt(0)
  const prev = monthAt(-1)
  const next = monthAt(1)

  // Nothing is seeded (rule 81): build a real current month from the Essentials template,
  // then add a target-less Goal jar (held in the Pot account) whose line lands in the month.
  await register(page, { starterBudget: true })
  await createGoalJar(page, 'Emergency Fund', '0')
  await page.getByRole('link', { name: 'Budget' }).click()
  await expect(page.getByText('Remaining to budget')).toBeVisible()
  // A jar created while the month exists plants its contribution line there; plan 250.00 on it.
  await expect(page.getByRole('textbox', { name: 'Rename Emergency Fund' })).toBeVisible()
  await setPlanned(page, 'Emergency Fund', '250')
  // Income 3,000 so the copied month reads "800.00 still to assign" after the 2,200 below.
  const addIncome = page.getByRole('textbox', { name: 'New income source name' })
  await addIncome.fill('Salary')
  await committed(page, 'POST', '/items', () => addIncome.press('Enter'))
  await setPlanned(page, 'Salary', '3000')
  await setPlanned(page, 'Rent / Mortgage', '1950')

  // JAR-060 / DASH-028: on the current calendar month the "Your jars" shelf renders.
  await expect(page.getByRole('heading', { name: 'Your jars' })).toBeVisible()

  // BUDG-038: ‹ moves to the previous month — no budget there for this fresh user,
  // and no Copy button either (no month exists strictly before it).
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.getByRole('heading', { name: prev.label })).toBeVisible()
  await expect(page.getByText(`No budget for ${prev.label} yet.`)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Copy / })).toHaveCount(0)

  // BUDG-042: the viewed month is app-wide MonthContext state — Transactions opens
  // on the same (previous) month, and Budget still shows it on the way back.
  await page.getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByText(`Money in · ${prev.label}`)).toBeVisible()
  await page.getByRole('link', { name: 'Budget' }).click()
  await expect(page.getByText(`No budget for ${prev.label} yet.`)).toBeVisible()

  // BUDG-040: › twice reaches the (creatable) next month; the copy button names the
  // real most-recent prior month — the current one.
  await page.getByRole('button', { name: 'Next month' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: next.label })).toBeVisible()
  await expect(page.getByText(`No budget for ${next.label} yet.`)).toBeVisible()
  await committed(page, 'POST', createMonthUrl, () =>
    page.getByRole('button', { name: `Copy ${current.label}` }).click(),
  )

  // BUDG-016: the Emergency Fund jar has target 0 → NOT seedable → its planned
  // amount copies flat (250.00), no accrual recompute. Remaining = 3,000 − (1,950 + 250).
  await expect(
    page.getByRole('button', { name: 'Planned amount for Emergency Fund' }),
  ).toHaveText('€250.00')
  await expect(page.getByText('€800.00 still to assign')).toBeVisible()

  // DASH-028 / JAR-061: a loaded NON-current month hides the shelf even though the
  // household owns a jar — today's all-time balances would contradict month-scoped lines.
  await expect(page.getByRole('heading', { name: 'Your jars' })).toHaveCount(0)

  // BUDG-039: December → January rolls the year forward; ‹ rolls it back.
  for (let m = next.month; m < 12; m += 1) {
    await page.getByRole('button', { name: 'Next month' }).click()
  }
  const decYear = next.year
  await expect(page.getByRole('heading', { name: `December ${decYear}` })).toBeVisible()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('heading', { name: `January ${decYear + 1}` })).toBeVisible()
  await page.getByRole('button', { name: 'Previous month' }).click()
  await expect(page.getByRole('heading', { name: `December ${decYear}` })).toBeVisible()
})
