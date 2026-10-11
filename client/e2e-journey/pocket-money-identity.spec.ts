import { expect, test, type Page } from '@playwright/test'
import { personAction, personCard, register } from './helpers'

/**
 * Rules 53/54 through the REAL stack: a person's pocket-money budget line is linked to the
 * person, not their name. Renaming them on the People page renames the line; a second sync
 * reuses it (no duplicate, same total). Archiving them removes their planned pocket money
 * from months already created after this one, and asks whether to keep or cancel this
 * month's remainder — keeping it leaves the line as it is, and payments are never touched.
 *
 * The archive runs through the People page's archive-preview dialog (PR #268): "Keep this
 * month" sends `pocketMoneyThisMonth: 0` and leaves this month's line as it is.
 *
 * The sync itself is invoked through its endpoint with the SPA's own bearer token (the
 * Allocation page's "Add pocket money" button needs a profile, which a fresh household
 * cannot set up through the UI — see allocation-commit.spec.ts); everything the rules
 * are about (rename, archive, the dialog) runs through the real People and Budget pages.
 */

const RULE = { FundEnvelopes: 0, FundJars: 1, FixedPerMember: 2, SplitRemainderToMembers: 3 }
const SPLIT = { Equal: 0, BalanceTilt: 2 }

function currentPeriod() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function nextPeriod() {
  const { year, month } = currentPeriod()
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

function captureAuth(page: Page): () => string | undefined {
  let header: string | undefined
  page.on('request', (r) => {
    const h = r.headers()['authorization']
    if (h && r.url().includes('/api/')) header = h
  })
  return () => header
}

async function committed(page: Page, method: 'POST' | 'PUT', url: string, action: () => Promise<void>) {
  const done = page.waitForResponse((r) => r.request().method() === method && r.url().includes(url) && r.ok())
  await action()
  await done
}

async function addPerson(page: Page, name: string, income: string): Promise<void> {
  await page.getByRole('button', { name: 'Add person', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Person name').fill(name)
  await dialog.getByLabel('Default income').fill(income)
  await dialog.getByRole('button', { name: 'Add person', exact: true }).click()
  await expect(dialog).toBeHidden()
}

type Line = { id: string; name: string; plannedAmount: number; memberId: string | null }
type Month = { categories: Array<{ name: string; kind: string; items: Line[] }> }

async function pocketLines(page: Page, headers: Record<string, string>, year: number, month: number): Promise<Line[]> {
  const res = await page.request.get(`/api/budget/${year}/${month}`, { headers })
  expect(res.ok()).toBeTruthy()
  const dto = (await res.json()) as Month
  const pocket = dto.categories.find((c) => c.name === 'Pocket Money')
  return pocket ? pocket.items : []
}

test('rename reuses the linked pocket-money line; archive stops next month and asks about this one', async ({ page }) => {
  const auth = captureAuth(page)
  await register(page, { firstName: 'Ivy', starterBudget: true })
  await expect.poll(auth).toBeTruthy()
  const headers = { Authorization: auth()! }
  const now = currentPeriod()
  const next = nextPeriod()

  // A 2-person household with 200.00 pocket money each.
  await page.goto('/people')
  await addPerson(page, 'Robin', '1000')
  const put = await page.request.put('/api/allocation/profile', {
    headers,
    data: {
      id: null,
      name: 'Household allocation',
      sourceAccountId: null,
      balanceLeanPercent: 25,
      rules: [
        { order: 0, type: RULE.FundEnvelopes, split: SPLIT.Equal, fixedAmountPerMember: 0 },
        { order: 1, type: RULE.FundJars, split: SPLIT.Equal, fixedAmountPerMember: 0 },
        { order: 2, type: RULE.FixedPerMember, split: SPLIT.Equal, fixedAmountPerMember: 200 },
        { order: 3, type: RULE.SplitRemainderToMembers, split: SPLIT.BalanceTilt, fixedAmountPerMember: 0 },
      ],
    },
  })
  expect(put.ok()).toBeTruthy()

  // Sync: one linked line per person (rule 53).
  const sync = await page.request.post(`/api/allocation/pocket-lines/${now.year}/${now.month}`, { headers, data: {} })
  expect(sync.ok()).toBeTruthy()
  const members = (await (await page.request.get('/api/members', { headers })).json()) as Array<{ id: string; name: string }>
  const robin = members.find((m) => m.name === 'Robin')!
  let lines = await pocketLines(page, headers, now.year, now.month)
  expect(lines.map((l) => [l.name, l.plannedAmount, l.memberId])).toEqual(
    expect.arrayContaining([['Ivy', 200, expect.any(String)], ['Robin', 200, robin.id]]),
  )
  expect(lines).toHaveLength(2)

  // Next month, copied from this one, carries both linked lines.
  const created = await page.request.post('/api/budget', {
    headers,
    data: { year: next.year, month: next.month, copyFromPrevious: true },
  })
  expect(created.ok()).toBeTruthy()
  expect((await pocketLines(page, headers, next.year, next.month)).map((l) => l.name).sort()).toEqual(['Ivy', 'Robin'])

  // --- Rule 53: rename Robin → Robyn on the People page; the line follows, no duplicate ---
  await page.reload()
  // Edit and Archive are in the person's ⋯ menu.
  await personAction(page, 'Robin', 'Edit Robin')
  await page.getByRole('textbox', { name: 'Name for Robin' }).fill('Robyn')
  await committed(page, 'PUT', `/api/members/${robin.id}`, () =>
    page.getByRole('button', { name: 'Save Robin' }).click(),
  )
  await expect(personCard(page, 'Robyn')).toBeVisible()

  lines = await pocketLines(page, headers, now.year, now.month)
  expect(lines.map((l) => l.name).sort()).toEqual(['Ivy', 'Robyn'])
  expect(lines.find((l) => l.memberId === robin.id)!.name).toBe('Robyn')

  // A second sync reuses the linked line: still two lines, still 400.00 in total.
  const resync = await page.request.post(`/api/allocation/pocket-lines/${now.year}/${now.month}`, { headers, data: {} })
  expect(resync.ok()).toBeTruthy()
  lines = await pocketLines(page, headers, now.year, now.month)
  expect(lines).toHaveLength(2)
  expect(lines.reduce((sum, l) => sum + l.plannedAmount, 0)).toBe(400)

  // The Budget page shows the renamed line.
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: 'Rename Robyn', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename Robin', exact: true })).toHaveCount(0)

  // --- Rule 54: archive Robyn; this month still plans 200.00 for them → the dialog asks ---
  await page.goto('/people')
  await personAction(page, 'Robyn', 'Archive Robyn')
  const dialog = page.getByRole('dialog', { name: 'Archive Robyn' })
  // Symbol-agnostic: the currency symbol follows the registration locale.
  await expect(dialog).toContainText(/Robyn still has .*200\.00.* of pocket money planned for/)
  await expect(dialog).toContainText('is cancelled.') // the next month already holds a line
  await committed(page, 'PUT', `/api/members/${robin.id}/archive`, () =>
    dialog.getByRole('button', { name: 'Keep this month’s pocket money and archive' }).click(),
  )
  await expect(dialog).toBeHidden()
  await expect(personCard(page, 'Robyn')).toHaveCount(0)

  // Kept: this month's line is untouched; next month's is gone; Ivy's lines stay.
  lines = await pocketLines(page, headers, now.year, now.month)
  expect(lines.map((l) => [l.name, l.plannedAmount])).toEqual(
    expect.arrayContaining([['Ivy', 200], ['Robyn', 200]]),
  )
  expect(lines).toHaveLength(2)
  expect((await pocketLines(page, headers, next.year, next.month)).map((l) => [l.name, l.plannedAmount])).toEqual([['Ivy', 200]])
})
