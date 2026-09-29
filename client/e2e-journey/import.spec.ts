import { expect, test } from '@playwright/test'
import { register } from './helpers'

/**
 * The flagship journey: a full generic-CSV import round-trip against the real parser, dedup index
 * and commit path — exactly what the three-audit import review could only reason about, now driven
 * end-to-end. Covers upload → auto-detected column mapping → review → commit → honest money tiles,
 * then re-imports the same file to prove the unique-reference dedup (I1) and the all-caught-up
 * state (I2) hold against real SQL Server.
 */
const STATEMENT = [
  'Date,Description,Amount,Currency',
  '2026-06-20,TESCO STORES,-42.50,EUR',
  '2026-06-21,ACME SALARY,2500.00,EUR',
  '2026-06-22,COFFEE HOUSE,-3.80,EUR',
  '',
].join('\n')

async function upload(page: import('@playwright/test').Page) {
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Import transactions' })).toBeVisible()
  await page.getByLabel('Statement file').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(STATEMENT),
  })
  await page.getByRole('button', { name: 'Review transactions' }).click()
}

test('import a CSV end-to-end, then re-import shows all-caught-up (dedup)', async ({ page }) => {
  await register(page)

  // --- First import: three fresh rows ---
  await upload(page)
  await expect(page.getByText(/3 new transactions to review/)).toBeVisible()
  // The generic importer auto-detected the columns; the three rows are in the review grid.
  await expect(page.getByLabel('Include TESCO STORES on 2026-06-20')).toBeVisible()
  await expect(page.getByLabel('Include ACME SALARY on 2026-06-21')).toBeVisible()

  await page.getByRole('button', { name: 'Import 3 transactions' }).click()

  // Success screen shows REAL money sums (I2), not transaction counts.
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  const moneyIn = page.locator('div', { has: page.getByText('Money in', { exact: true }) }).last()
  const moneyOut = page.locator('div', { has: page.getByText('Money out', { exact: true }) }).last()
  await expect(moneyIn).toContainText('2,500.00')
  await expect(moneyOut).toContainText('46.30') // 42.50 + 3.80

  // --- Re-import the identical file: everything is a duplicate ---
  await page.getByRole('button', { name: 'Import another file' }).click()
  await upload(page)

  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
  await expect(page.getByText(/already in AllotJar/)).toBeVisible()
  // No review grid / commit button on the all-caught-up screen.
  await expect(page.getByRole('button', { name: /Import \d+ transaction/ })).toHaveCount(0)
})

