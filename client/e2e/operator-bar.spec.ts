import { expect, test } from '@playwright/test'
import { authedSetup } from './mocks'

/**
 * The calculator keys on a touch screen (OperatorBar): focusing an amount field in a dialog shows
 * + − × ÷; a key types its operator at the caret, the field keeps focus and the dialog stays open
 * (the key's press never reaches the dialog's "pressed outside" check). A computer gets no keys.
 */
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a calculator key types into the amount field and keeps the dialog open', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/transactions')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.getByRole('button', { name: 'Add transaction' }).first().click()
    const dialog = page.getByRole('dialog')
    const amount = dialog.getByRole('textbox', { name: 'Transaction amount' })
    await amount.tap()
    await amount.fill('20')
    const bar = page.getByRole('toolbar', { name: 'Calculator keys' })
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Plus' }).tap()
    await page.keyboard.type('30')
    await expect(amount).toHaveValue('20+30')
    await expect(amount).toBeFocused()
    await expect(dialog).toBeVisible()

    // Another field: the keys go away.
    await dialog.getByRole('textbox', { name: 'Transaction payee' }).tap()
    await expect(bar).toHaveCount(0)
  })
})

test.describe('on a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('no calculator keys', async ({ page }) => {
    await authedSetup(page, 'light')
    await page.goto('/transactions')
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.getByRole('button', { name: 'Add transaction' }).first().click()
    await page.getByRole('dialog').getByRole('textbox', { name: 'Transaction amount' }).click()
    await expect(page.getByRole('toolbar', { name: 'Calculator keys' })).toHaveCount(0)
  })
})
