import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImportPreviewResult } from '../types'

// Mirror ImportPage.test.tsx + ImportPage.catalog.test.tsx harness exactly: the shared api mock
// plus hoisted previewImport/commitImport spies, same AuthProvider/MemoryRouter tree. This file
// only ADDS the remaining jsdom-observable catalog cases that neither sibling file already covers
// (the cheap P2 tail: include-all header toggle, amount colour/direction, header-toggle re-scan,
// transfer undo, full reset, and graceful reference-data degradation).
const { mockPreview, mockCommit } = vi.hoisted(() => ({
  mockPreview: vi.fn(),
  mockCommit: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    previewImport: mockPreview,
    commitImport: mockCommit,
  }),
)

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ImportPage } from './ImportPage'
import { accounts, committed, csvPreview, members, month, preview, previewWithTransfer } from '../test/fixtures/import'
import { menuItems } from '../test/rowMenu'
import { categoryChip, rowAction, rowItems, rowOf } from '../test/importReview'

// One credit + one debit, both EUR, non-transfer — for the amount colour/direction case.
function previewCreditAndDebit(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'x:s#0', date: '2026-06-25', payee: 'SALARY', amount: 250, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'x:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

const renderPage = () => renderWithProviders(<ImportPage />)

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(await screen.findByLabelText(/^Statement file/), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

describe('ImportPage (catalog supplemental)', () => {
  beforeEach(() => {
    // Keep the default Owner role — never let a stray zbb.role from another suite drop canWrite.
    localStorage.clear()
    resetApiMocks()
    mockPreview.mockReset()
    mockCommit.mockReset()
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(preview())
    mockCommit.mockResolvedValue(committed())
  })

  // IMP-041 — the header "Include all rows" checkbox unticks every row (Import disabled at zero)
  // and re-ticks them all; it reads checked only when every row is included.
  it('include-all header checkbox toggles every row and gates the import', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    const headerBox = screen.getByLabelText('Include all rows')
    // Both rows start included, so the header box is checked.
    expect(headerBox).toBeChecked()
    expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).toBeChecked()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).toBeChecked()

    // Untick the header → every row unticks and Import is disabled at zero included.
    await user.click(headerBox)
    await waitFor(
      () => expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).not.toBeChecked(),
      { timeout: 5000 },
    )
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).not.toBeChecked()
    expect(headerBox).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()

    // Re-tick the header → every row re-includes and the box reads checked again.
    await user.click(headerBox)
    await waitFor(
      () => expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17')).toBeChecked(),
      { timeout: 5000 },
    )
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).toBeChecked()
    expect(headerBox).toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
  })

  // IMP-044 — a credit renders "+€X" in emerald, a debit "−€X" in slate, each in its own currency.
  it('renders credit amounts +emerald and debit amounts −slate', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewCreditAndDebit())
    const user = userEvent.setup()
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('SALARY')

    // The amount sits at the row's right (data-import-amount), in the Transactions list's colours.
    const creditAmt = rowOf('Include SALARY on 2026-06-25').querySelector('[data-import-amount]')!
    expect(creditAmt).toHaveTextContent('+€250.00')
    expect(creditAmt.textContent?.trim().startsWith('+')).toBe(true)
    expect(creditAmt).toHaveClass('text-ok')

    const debitAmt = rowOf('Include AUTOMARKET on 2026-06-17').querySelector('[data-import-amount]')!
    expect(debitAmt).toHaveTextContent('€35.00')
    // The sign is the true minus glyph U+2212, not a hyphen, and the cell is slate (not emerald).
    expect(debitAmt.textContent?.trim().charCodeAt(0)).toBe(0x2212)
    expect(debitAmt).toHaveClass('text-slate-900')
    expect(debitAmt).not.toHaveClass('text-ok')

    // An unticked row steps back to the muted colour.
    await user.click(screen.getByLabelText('Include SALARY on 2026-06-25'))
    expect(creditAmt).toHaveClass('text-slate-500')
    expect(creditAmt).not.toHaveClass('text-ok')
  })

  // IMP-023 (+ the clean-state re-scan label of IMP-066/IMP-020) — the "First row is a header" toggle
  // marks the mapping dirty and its flipped value is sent on the re-scan.
  it('generic CSV: the "first row is a header" toggle is sent on re-scan', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(csvPreview())
    renderPage()

    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    // Clean mapping: the Columns dialog's re-scan button is the plain "Re-scan" (no dirty warning).
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    expect(screen.getByRole('button', { name: 'Re-scan' })).toBeInTheDocument()
    expect(screen.queryByText(/changed the column mapping/)).not.toBeInTheDocument()
    await user.click(screen.getByText('More options'))
    const headerToggle = screen.getByLabelText('First row is a header')
    expect(headerToggle).toBeChecked() // detected layout had hasHeader: true

    // Toggling it off marks the mapping dirty (button flips to the primary "Apply changes" action).
    await user.click(headerToggle)
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Apply changes & re-scan' })).toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.getByText(/changed the column mapping/)).toBeInTheDocument()

    mockPreview.mockClear()
    mockPreview.mockResolvedValue(csvPreview())
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))

    await waitFor(() => expect(mockPreview).toHaveBeenCalled(), { timeout: 5000 })
    const [, wire, opts] = mockPreview.mock.calls[0]
    expect(wire).toBe('GenericCsv')
    expect(opts.mapping.hasHeader).toBe(false)
  })

  // IMP-055 — "Undo" on a transfer row returns it to a normal categorised row: the Category select
  // and the "Mark as a transfer" control come back, and the transfer account picker is gone.
  it('undo returns a transfer row to a normal categorised row', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()

    // An import account is required for the per-row transfer control to appear.
    await user.selectOptions(await screen.findByLabelText(/Add to account/), 'acc1')
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('E-BANKING PAYMENT')

    // Mark it a transfer → the Transfer dialog (the account select + Undo); the category chip is gone.
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    expect(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Assign|Reassign) E-BANKING PAYMENT on 2026-06-16$/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Looks like a transfer')).not.toBeInTheDocument()

    // Undo (the dialog's foot) → back to a plain categorised row: the chip returns, the transfer
    // picker is gone, and the "looks like a transfer" hint + "Mark as transfer" are offered again.
    await user.click(screen.getByRole('button', { name: 'Undo transfer for E-BANKING PAYMENT on 2026-06-16' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer' })).not.toBeInTheDocument())
    expect(categoryChip('E-BANKING PAYMENT on 2026-06-16')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Looks like a transfer')).toBeInTheDocument()
    expect((await rowItems(user, 'E-BANKING PAYMENT on 2026-06-16')).map((i) => i.name)).toContain('Mark as transfer')

    // Marked again, the row's ⋯ offers Edit transfer and Undo transfer instead; Undo from there too.
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark as transfer: E-BANKING PAYMENT on 2026-06-16')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect((await rowItems(user, 'E-BANKING PAYMENT on 2026-06-16')).map((i) => i.name)).toEqual(['Edit transfer', 'Undo transfer'])
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Undo transfer for E-BANKING PAYMENT on 2026-06-16')
    expect(categoryChip('E-BANKING PAYMENT on 2026-06-16')).toBeInTheDocument()
  })

  // IMP-083 — both restart controls fully reset to the upload phase: "Choose a different file" from
  // review, and "Import another file" from the done screen.
  it('"Choose a different file" and "Import another file" reset to the upload phase', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    // "Choose a different file" (review) → back to a blank upload form.
    await user.click(screen.getByRole('button', { name: 'Choose a different file' }))
    expect(await screen.findByLabelText(/^Statement file/)).toBeInTheDocument()
    // File state cleared → submit disabled again, and no review grid remains.
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()
    expect(screen.queryByLabelText('Include AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()

    // Import to reach the done screen, then "Import another file" → upload phase again.
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    await screen.findByText('Import complete')

    await user.click(screen.getByRole('button', { name: 'Import another file' }))
    expect(await screen.findByLabelText(/^Statement file/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeDisabled()
    expect(screen.queryByText('Import complete')).not.toBeInTheDocument()
  })

  // IMP-089 — when the reference-data fetches (/accounts, /budget/current, /members) fail, the page
  // degrades gracefully: no error banner, no account options, category selects offer only
  // "Unassigned", the bulk buttons disable, and the upload → review flow still completes.
  it('degrades gracefully when the reference-data fetches fail', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts' || url === '/budget/current' || url === '/members') {
        return Promise.reject(new Error('network'))
      }
      return Promise.resolve({ data: [] })
    })
    const user = userEvent.setup()
    renderPage()

    // The account picker renders but offers only the "no account" option (accounts defaulted to []).
    const accountSelect = await screen.findByLabelText(/Add to account/)
    expect(within(accountSelect).getAllByRole('option')).toHaveLength(1)
    expect(within(accountSelect).getByRole('option', { name: "Don't link to an account" })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'HSBC Current' })).not.toBeInTheDocument()

    // The upload → review flow still works despite the missing reference data.
    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByText('AUTOMARKET')

    // Month defaulted to null → the category select (behind the row's chip) offers only "Unassigned".
    await user.click(categoryChip('AUTOMARKET on 2026-06-17'))
    const categorySelect = screen.getByLabelText('Category for AUTOMARKET on 2026-06-17')
    const categoryOptions = within(categorySelect).getAllByRole('option')
    expect(categoryOptions).toHaveLength(1)
    expect(categoryOptions[0]).toHaveTextContent('Unassigned')
    await user.keyboard('{Escape}')
    expect(screen.queryByLabelText('Category for AUTOMARKET on 2026-06-17')).not.toBeInTheDocument()

    // No expense lines / no members → both bulk actions are disabled, and the row offers no Member.
    expect(await menuItems(user, 'Bulk actions')).toEqual([
      { name: 'Member for included rows', disabled: true },
      { name: 'Category for included expenses', disabled: true },
    ])
    await user.keyboard('{Escape}')
    expect((await rowItems(user, 'AUTOMARKET on 2026-06-17')).find((i) => i.name === 'Member')?.disabled).toBe(true)

    // Swallowed failures never surface an error banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
