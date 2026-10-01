import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Fix plan C (TX-P3-5, client CL-P2-1): the review keys its rows by their place in the preview, and
// a commit's held and skipped rows are matched by their position in the request, so rows sharing a
// bank reference (or, from statements imported before content references, none) stay apart.
const { mockPreview, mockCommit } = vi.hoisted(() => ({ mockPreview: vi.fn(), mockCommit: vi.fn() }))
vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    previewImport: mockPreview,
    commitImport: mockCommit,
  }),
)

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ImportPage } from './ImportPage'
import { accounts, committed, members, month } from '../test/fixtures/import'
import type { ImportPreviewResult } from '../types'

/** Two CAMT debits with no bank reference at all, as the server sends them. */
function noReferencePreview(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 0, debits: 2,
    items: [
      { reference: '', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: '', date: '2026-06-15', payee: 'WOLT', amount: 80.9, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
    ],
  }
}

const csv = () => new File(['x'], 'stmt.xml', { type: 'text/xml' })

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('File format'), 'camt')
  await user.upload(await screen.findByLabelText('Statement file'), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

describe('ImportPage: rows sharing a reference stay apart', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPreview.mockReset()
    mockCommit.mockReset()
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: accounts })
      if (url === '/budget/current') return Promise.resolve({ data: month })
      if (url === '/members') return Promise.resolve({ data: members })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(noReferencePreview())
  })

  it('holds only the row the server held, by its position', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockCommit.mockResolvedValue(
      committed({ imported: 1, held: [{ reference: '', index: 0, message: 'HSBC Current would be -10.00 EUR on 17 Jun 2026.' }] }),
    )
    renderWithProviders(<ImportPage />)
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: /^Import 2 transactions$/ }))
    await screen.findByRole('status')

    expect(await screen.findAllByText('Held')).toHaveLength(1)
    expect(screen.getByText('AUTOMARKET')).toBeInTheDocument()
    expect(screen.queryByText('WOLT')).not.toBeInTheDocument()
  })

  it('leaves only the skipped row out of the done screen money sums', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockCommit.mockResolvedValue(committed({ imported: 1, skippedDuplicates: 1, skippedReferences: [''], skippedIndexes: [1] }))
    renderWithProviders(<ImportPage />)
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: /^Import 2 transactions$/ }))
    await screen.findByRole('heading', { name: 'Import complete' })

    const moneyOut = screen.getByText('Money out').parentElement as HTMLElement
    expect(moneyOut).toHaveTextContent('€35.00')
  })

  it('names one row per entry when the server sends references only', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    mockCommit.mockResolvedValue(committed({ imported: 1, held: [{ reference: '', message: 'Would go below zero.' }] }))
    renderWithProviders(<ImportPage />)
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: /^Import 2 transactions$/ }))
    await screen.findByRole('status')

    expect(await screen.findAllByText('Held')).toHaveLength(1)
  })

  it('gives each row its own React key', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<ImportPage />)
    await goToReview(user)
    await waitFor(() => expect(screen.getByText('WOLT')).toBeInTheDocument())
    const duplicateKey = consoleError.mock.calls.some((c) => String(c[0]).includes('same key'))
    consoleError.mockRestore()
    expect(duplicateKey).toBe(false)
  })

  it('holds the review still while Import is out, so no answer is given to a row already on its way (client P3-4)', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    let answer: (value: ReturnType<typeof committed>) => void = () => {}
    mockCommit.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderWithProviders(<ImportPage />)
    await goToReview(user)

    await user.click(screen.getByRole('button', { name: /^Import 2 transactions$/ }))
    // The commit is still out: the rows can't be re-answered.
    expect(screen.getByLabelText('Category for AUTOMARKET on 2026-06-17')).toBeDisabled()
    expect(screen.getByLabelText('Category for WOLT on 2026-06-15')).toBeDisabled()
    expect(screen.getByLabelText('Bulk category')).toBeDisabled()

    answer(committed({ imported: 1, held: [{ reference: '', index: 0, message: 'Would go below zero.' }] }))
    await screen.findByRole('status')

    // The held row is open again for its answer.
    await waitFor(() => expect(screen.getByLabelText('Category for AUTOMARKET on 2026-06-17')).toBeEnabled())
  })
})
