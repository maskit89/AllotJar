import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AccountDto, BudgetMonthDto, ImportPreviewResult, JarAccountLedgerDto } from '../types'

/*
 * The Import page's restyle (PR 14): what is new in how the page is driven — the row ⋯ menus and the
 * phone's action sheet, the sheet dialogs (focus, Escape, the (i) inside them), the page action
 * pinned above a phone's tab bar, the (i) hints, the jar fields' toggle, and the keyboard. What
 * the page sends is ImportPage.requests.test.tsx; the review's rules are the sibling test files.
 */
const { mockPreview, mockCommit } = vi.hoisted(() => ({ mockPreview: vi.fn(), mockCommit: vi.fn() }))
vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, { previewImport: mockPreview, commitImport: mockCommit }),
)

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ImportPage } from './ImportPage'
import { account, accounts, committed, csvPreview, members, month, preview, previewWithTransfer } from '../test/fixtures/import'
import { categoryChip, chooseMatch, closeHint, done, openHint, openJars, rowAction, rowItems, rowOf } from '../test/importReview'
import { menuItems } from '../test/rowMenu'

function screenMatching(...queries: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}
const asPhone = () => screenMatching('(max-width: 699.98px)')
const asDesktop = () => screenMatching('(min-width: 900px)')

const csv = () => new File(['x'], 'tx.csv', { type: 'text/csv' })
const renderPage = () => renderWithProviders(<ImportPage />)
type User = ReturnType<typeof userEvent.setup>

async function goToReview(user: User, accountId?: string) {
  if (accountId) await user.selectOptions(await screen.findByLabelText(/Add to account/), accountId)
  await user.upload(await screen.findByLabelText(/^Statement file/), csv())
  await user.click(screen.getByRole('button', { name: 'Review transactions' }))
  await screen.findByText('AUTOMARKET')
}

// A jar-backed account (as ImportPage.jars.test.tsx): HSBC Current backs Holiday and Car.
const jarAccounts: AccountDto[] = [account({ currentBalance: 550 }), account({ id: 'acc2', name: 'Joint Savings', type: 1, displayOrder: 1 })]
const ledgers: JarAccountLedgerDto[] = [
  {
    accountId: 'acc1', accountName: 'HSBC Current', currency: 'EUR', asOf: '2026-06-30',
    accountBalance: 550, unallocated: 300, positiveAllocations: 250, hasBackingDeficit: false,
    unreconciledAllocations: 0, requiresReview: false,
    jars: [
      { jarId: 'j1', name: 'Holiday', balance: 200, isArchived: false },
      { jarId: 'j2', name: 'Car', balance: 50, isArchived: false },
    ],
  },
]
const jarMonth = {
  ...month,
  categories: [
    { id: 'c0', name: 'Income', kind: 'Income', displayOrder: 0, totalPlanned: 0, totalActual: 0,
      items: [{ id: 'bi0', name: 'Salary', displayOrder: 0, plannedAmount: 0, actualAmount: 0, remaining: 0, savingsId: null, savingsAvailable: null, dueDay: null, isPaid: false }] },
    ...month.categories,
  ],
} as unknown as BudgetMonthDto
function jarPreview(): ImportPreviewResult {
  return {
    totalEntries: 2, newCount: 2, skippedDuplicates: 0, credits: 1, debits: 1,
    items: [
      { reference: 'camt:s#0', date: '2026-06-01', payee: 'SALARY', amount: 2500, currency: 'EUR', isCredit: true, suggestedBudgetItemId: null, suggestedBudgetItemName: null, likelyTransfer: false },
      { reference: 'camt:a#0', date: '2026-06-17', payee: 'AUTOMARKET', amount: 35, currency: 'EUR', isCredit: false, suggestedBudgetItemId: null, suggestedBudgetItemName: 'Groceries', likelyTransfer: false },
    ],
  }
}

describe('ImportPage restyle (PR 14)', () => {
  beforeEach(() => {
    resetApiMocks()
    localStorage.clear()
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
  afterEach(() => vi.unstubAllGlobals())

  // ---- Step 1: the upload card --------------------------------------------------------------

  it('the drop zone is the file chooser: it reads the file chosen, and the help sits behind two (i)s', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    const input = await screen.findByLabelText(/^Statement file/)
    const zone = input.closest('[data-drop-zone]') as HTMLElement
    // Its name carries the words on screen (2.5.3): "click Choose a file" finds it.
    expect(input).toHaveAccessibleName('Statement file: choose a file or drop it here')
    expect(zone).toHaveTextContent('Choose a file')
    expect(zone).toHaveTextContent('or drop it here')
    expect(screen.getByRole('heading', { name: 'Upload a statement' })).toBeInTheDocument()
    // No helper sentences on the card: both explanations are (i)s.
    expect(screen.queryByText(/Most banks/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Stamps each transaction/)).not.toBeInTheDocument()
    const formats = await openHint(user, 'About file formats')
    expect(formats).toHaveTextContent(/Most banks/)
    expect(formats).toHaveTextContent(/Re-importing the same file won't create duplicates\./)
    await closeHint(user, 'About file formats')
    expect(await openHint(user, 'About the account')).toHaveTextContent(
      'Optional. Stamps each transaction onto this account so its balance reflects the import. Pick one to record transfers between your accounts.',
    )
    await closeHint(user, 'About the account')

    await user.upload(screen.getByLabelText(/^Statement file/), csv())
    expect(zone).toHaveTextContent('tx.csv')
    expect(zone).toHaveTextContent('Choose a different file')
    expect(zone).not.toHaveTextContent('or drop it here')
    expect(input).toHaveAccessibleName('Statement file: choose a different file')
    // One primary action on the screen.
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeEnabled()
  })

  // ---- The row ⋯ menus and the phone's sheet ---------------------------------------------------

  it('a row’s ⋯ offers Split, Mark as transfer (with an account) and Member, each named for its row; an unticked row’s are held back', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    expect(await rowItems(user, 'E-BANKING PAYMENT on 2026-06-16')).toEqual([
      { name: 'Split', disabled: false },
      { name: 'Mark as transfer', disabled: false },
      { name: 'Member', disabled: false },
    ])
    // The items' accessible names say which row they act on.
    await user.click(screen.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Split AUTOMARKET on 2026-06-17' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Mark AUTOMARKET on 2026-06-17 as a transfer' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Member for AUTOMARKET on 2026-06-17' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' })).toHaveFocus()

    // Unticked: the row keeps its ⋯ but nothing in it applies, and its chip is held back too.
    await user.click(screen.getByLabelText('Include AUTOMARKET on 2026-06-17'))
    expect((await rowItems(user, 'AUTOMARKET on 2026-06-17')).map((i) => i.disabled)).toEqual([true, true, true])
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toBeDisabled()
    // Its line, drawn in the muted colour, stays readable: nothing fades on an unticked row.
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveTextContent('Groceries')
    expect(categoryChip('AUTOMARKET on 2026-06-17')).not.toHaveClass('disabled:opacity-60')
  })

  it('a transfer row’s ⋯ offers Edit transfer and Undo transfer; a split row’s Edit split and Clear split', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    await done(user)
    expect(await rowItems(user, 'E-BANKING PAYMENT on 2026-06-16')).toEqual([
      { name: 'Edit transfer', disabled: false },
      { name: 'Undo transfer', disabled: false },
    ])
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Edit transfer for E-BANKING PAYMENT on 2026-06-16')
    expect(screen.getByRole('dialog', { name: 'Transfer' })).toBeInTheDocument()
    await done(user)

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Split AUTOMARKET on 2026-06-17')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '35')
    // An empty line reads "Unassigned", as the row's own picker and the split summary do.
    expect(screen.getByLabelText('Split line 2 category for AUTOMARKET')).toHaveDisplayValue('Unassigned')
    await done(user)
    expect(await rowItems(user, 'AUTOMARKET on 2026-06-17')).toEqual([
      { name: 'Edit split', disabled: false },
      { name: 'Clear split', disabled: false },
    ])
    // The row's split chip opens the editor too.
    await user.click(screen.getByRole('button', { name: 'Edit split for AUTOMARKET on 2026-06-17' }))
    expect(screen.getByRole('dialog', { name: 'Split' })).toBeInTheDocument()
    await done(user)
    // Clear split from the ⋯ (no dialog) puts the chip back.
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Clear split')
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toBeInTheDocument()
  })

  it('on a phone the row itself opens a bottom sheet with the same actions, and the page action is pinned', { timeout: 15000 }, async () => {
    asPhone()
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    // No ⋯ on a phone: the payee is the trigger.
    expect(screen.queryByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' })).not.toBeInTheDocument()
    const trigger = within(rowOf('Include AUTOMARKET on 2026-06-17')).getByRole('button', { name: 'AUTOMARKET' })
    expect(trigger).toHaveAttribute('data-row-trigger')
    // The include box sits above the trigger's full-row overlay, so a tap on it ticks the row (the e2e checks the tap).
    expect(screen.getByLabelText('Include AUTOMARKET on 2026-06-17').closest('div')).toHaveClass('relative', 'z-10')
    await user.click(trigger)
    const sheet = await screen.findByRole('dialog', { name: 'AUTOMARKET' })
    expect(sheet).toHaveTextContent('Jun 17')
    expect(within(sheet).getByRole('button', { name: 'Split AUTOMARKET on 2026-06-17' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Mark AUTOMARKET on 2026-06-17 as a transfer' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Member for AUTOMARKET on 2026-06-17' })).toBeInTheDocument()
    // Picking an action closes the sheet and opens its dialog (a phone's bottom sheet: the grab handle is its Close).
    await user.click(within(sheet).getByRole('button', { name: 'Mark AUTOMARKET on 2026-06-17 as a transfer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'AUTOMARKET' })).not.toBeInTheDocument())
    const close = within(dialog).getAllByRole('button', { name: 'Close' })
    expect(close).toHaveLength(1)
    expect(close[0]).not.toHaveTextContent(/./)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // The one Import button sits in the dock pinned above the tab bar (never a second copy).
    const dock = document.querySelector('[data-import-dock]') as HTMLElement
    expect(dock).toHaveClass('fixed', 'bottom-[var(--tabbar-h)]')
    expect(screen.getAllByRole('button', { name: 'Import 2 transactions' })).toHaveLength(1)
    expect(dock.contains(screen.getByRole('button', { name: 'Import 2 transactions' }))).toBe(true)
  })

  it('on a wide screen the page action sits in the top bar, once, and there is no dock', { timeout: 15000 }, async () => {
    asDesktop()
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    expect(document.querySelector('[data-import-dock]')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Import 2 transactions' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Import 2 transactions' }).closest('header')).not.toBeNull()
  })

  // ---- The dialogs: focus, Escape, the (i) inside ----------------------------------------------

  it('the Transfer dialog: named by its title, the row summed up, focus on Close, Escape closes it back to the row’s ⋯', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    const dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    // The row: payee, date and account, amount.
    expect(dialog).toHaveTextContent('E-BANKING PAYMENT')
    expect(dialog).toHaveTextContent('Jun 16 · HSBC Current')
    expect(dialog).toHaveTextContent('+€234.24')
    expect(within(dialog).getByText('From')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'E-BANKING PAYMENT on 2026-06-16: more actions' })).toHaveFocus()
    // Escape keeps the row a transfer (Undo is the way back).
    expect(screen.getByRole('button', { name: 'Edit transfer for E-BANKING PAYMENT on 2026-06-16' })).toBeInTheDocument()
  })

  it('the fee’s (i) inside the Transfer dialog closes alone on Escape; a second Escape closes the dialog', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark AUTOMARKET on 2026-06-17 as a transfer')
    const dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    await user.selectOptions(within(dialog).getByLabelText('Transfer account for AUTOMARKET on 2026-06-17'), 'acc2')
    await user.type(within(dialog).getByLabelText('Fee for AUTOMARKET on 2026-06-17'), '2')
    const about = within(dialog).getByRole('button', { name: 'About the fee' })
    act(() => about.focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('A transfer of €33.00 plus a fee of €2.00.')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('the Member dialog: a row’s member, shown on the row once chosen', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    await rowAction(user, 'WOLT on 2026-06-15', 'Member for WOLT on 2026-06-15')
    const dialog = await screen.findByRole('dialog', { name: 'Member' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    // The field's visible word is in its name ("Member for …"), for voice control.
    expect(within(dialog).getByText('Member', { selector: 'span' })).toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Member for WOLT on 2026-06-15'), 'm1')
    await done(user)
    expect(within(rowOf('Include WOLT on 2026-06-15')).getByText('Alex')).toBeInTheDocument()
  })

  it('the Columns dialog: Escape is Cancel (the mapping goes back, Import unblocks) and focus returns to Columns; a failed re-scan is told in the dialog', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(csvPreview())
    const user = userEvent.setup()
    renderPage()
    await user.upload(await screen.findByLabelText(/^Statement file/), csv())
    await user.click(screen.getByRole('button', { name: 'Review transactions' }))
    await screen.findByLabelText('Include TESCO on 2026-06-20')

    const columns = screen.getByRole('button', { name: 'Columns' })
    await user.click(columns)
    const dialog = await screen.findByRole('dialog', { name: 'Columns' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(await openHint(user, 'About the column mapping')).toHaveTextContent(/We guessed how to read your file/)
    await closeHint(user, 'About the column mapping')
    // The peek: the file's first rows, with the column names as headers.
    const peek = within(dialog).getByRole('table', { name: 'Sample of the uploaded file' })
    expect(within(peek).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Date', 'Description', 'Amount', 'Currency'])
    expect(peek).toHaveTextContent('TESCO')
    // Its box scrolls sideways on a phone: a keyboard reaches it, named after the table.
    expect(within(dialog).getByRole('region', { name: 'Sample of the uploaded file' })).toHaveAttribute('tabindex', '0')
    // The rarely changed fields wait behind "More options".
    expect(screen.getByText('More options')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Amount column')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText('Amount column'), '3')
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(columns).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()

    // A re-scan the server refuses stays in the dialog, as its own alert; the page shows no banner.
    mockPreview.mockRejectedValueOnce({ response: { data: { title: 'Column 3 is not an amount.' } } })
    await user.click(columns)
    await user.selectOptions(screen.getByLabelText('Amount column'), '3')
    await user.click(screen.getByRole('button', { name: 'Apply changes & re-scan' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Column 3 is not an amount.')
    expect(screen.getByRole('dialog', { name: 'Columns' }).contains(alert)).toBe(true)
    expect(screen.getByRole('button', { name: 'Apply changes & re-scan' })).toBeEnabled()
  })

  // ---- The (i) hints on the review -------------------------------------------------------------

  it('the list bar’s chip counts the rows skipped, with the duplicate rules behind its (i); the strip’s (i) explains a recognised format', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue({ ...preview(), detectedFormat: 'HsbcCsv' })
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    expect(screen.getByText('1 already imported')).toBeInTheDocument()
    const about = screen.getByRole('button', { name: 'About skipped rows' })
    expect(about).not.toHaveAttribute('aria-describedby')
    const hint = await openHint(user, 'About skipped rows')
    expect(hint).toHaveTextContent(/Rows already imported are skipped, so re-importing a file never duplicates them\./)
    expect(about).toHaveAttribute('aria-describedby', hint.id)
    await closeHint(user, 'About skipped rows')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    const strip = screen.getByRole('region', { name: 'Statement file' })
    expect(strip).toHaveTextContent('tx.csv')
    expect(strip).toHaveTextContent('Bank CSV')
    expect(strip).toHaveTextContent('No account')
    expect(await openHint(user, 'About the format')).toHaveTextContent(
      'We recognised this file as an HSBC transaction history export and read it with the dedicated importer, so payees and duplicate detection stay consistent.',
    )
  })

  it('a credit marked as a transfer with no recorded match reads Pending review with its sentence behind the (i); candidates read Already recorded? and open the editor', { timeout: 15000 }, async () => {
    const data = previewWithTransfer()
    const user = userEvent.setup()
    mockPreview.mockResolvedValue(data)
    renderPage()
    await goToReview(user, 'acc1')

    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    await user.selectOptions(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16'), 'acc2')
    await done(user)
    const row = rowOf('Include E-BANKING PAYMENT on 2026-06-16')
    expect(within(row).getByText('Pending review')).toBeInTheDocument()
    expect(await openHint(user, 'About pending review')).toHaveTextContent(
      'Held for review until the departure date is known; nothing is posted to either account yet.',
    )
    await closeHint(user, 'About pending review')
    // The amount of a transfer steps back to the muted colour.
    expect(row.querySelector('[data-import-amount]')).toHaveClass('text-slate-500')

    // With candidates, the row flags "Already recorded?" until one is chosen (or declined).
    await user.click(screen.getByRole('button', { name: 'Choose a different file' }))
    data.items[0] = {
      ...data.items[0],
      transferMatches: [{ transferId: 'tr-1', counterpartyAccountId: 'acc2', counterpartyAccountName: 'Pot', amount: 234.24, currency: 'EUR', departedOn: '2026-06-15', receivedOn: null, payee: 'Transfer', kind: 'Match', fee: null, recordedDate: null, sameReference: false }],
    }
    await goToReview(user, 'acc1')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    await done(user)
    await user.click(screen.getByRole('button', { name: 'Already recorded? E-BANKING PAYMENT on 2026-06-16' }))
    expect(await screen.findByRole('dialog', { name: 'Transfer' })).toBeInTheDocument()
    await chooseMatch(user, 'E-BANKING PAYMENT on 2026-06-16', /From Pot/)
    // A chosen match locks the account.
    expect(screen.getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).toBeDisabled()
    await done(user)
    expect(screen.queryByRole('button', { name: 'Already recorded? E-BANKING PAYMENT on 2026-06-16' })).not.toBeInTheDocument()
    expect(screen.queryByText('Pending review')).not.toBeInTheDocument()
  })

  // ---- The jar fields' toggle ------------------------------------------------------------------

  it('a credit into a jar-backed account: "Into jars" under the amount opens and closes the fields, keeping what was typed', { timeout: 15000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: jarAccounts })
      if (url === '/budget/current') return Promise.resolve({ data: jarMonth })
      if (url === '/members') return Promise.resolve({ data: [] })
      if (url === '/jars/ledger') return Promise.resolve({ data: ledgers })
      return Promise.resolve({ data: [] })
    })
    mockPreview.mockResolvedValue(jarPreview())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    // The strip's (i) explains the jar questions.
    expect(await openHint(user, 'About HSBC Current')).toHaveTextContent(/HSBC Current holds jars: say which jars incoming money goes into/)
    await closeHint(user, 'About HSBC Current')

    const row = rowOf('Include SALARY on 2026-06-01')
    const toggle = within(row).getByRole('button', { name: 'Into jars' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(panel).toHaveAttribute('hidden')
    expect(screen.queryByRole('group', { name: 'Put into jars in HSBC Current' })).not.toBeInTheDocument()

    const fields = within(await openJars(user, 'Include SALARY on 2026-06-01'))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(panel).not.toHaveAttribute('hidden')
    await user.type(fields.getByLabelText('Amount for Holiday'), '175')
    expect(fields.getByText(/Stays unallocated/)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '€175 into jars' })).toBeInTheDocument()

    // Closed again: the answer stays (the toggle reads it) and comes back when reopened.
    await user.click(within(row).getByRole('button', { name: '€175 into jars' }))
    expect(panel).toHaveAttribute('hidden')
    expect(screen.queryByRole('group', { name: 'Put into jars in HSBC Current' })).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '€175 into jars' }))
    expect(within(screen.getByRole('group', { name: 'Put into jars in HSBC Current' })).getByLabelText('Amount for Holiday')).toHaveValue('175')
    // A debit on a line that is not a jar's offers From jar… in its ⋯, and shows the jar as a chip.
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'From jar for AUTOMARKET on 2026-06-17')
    const dialog = await screen.findByRole('dialog', { name: 'From jar' })
    expect(await openHint(user, 'About paying from a jar')).toHaveTextContent(/Which jar in HSBC Current does this come from\?/)
    await closeHint(user, 'About paying from a jar')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'From jar' }), 'j1')
    await done(user)
    expect(within(rowOf('Include AUTOMARKET on 2026-06-17')).getByText('From Holiday')).toBeInTheDocument()
  })

  // ---- Keyboard --------------------------------------------------------------------------------

  it('keyboard: Tab reaches the box, the chip and the ⋯ of a row; Enter on the chip opens the picker, Escape closes it back to the chip', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)

    const box = screen.getByLabelText('Include AUTOMARKET on 2026-06-17')
    act(() => box.focus())
    await user.tab()
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' })).toHaveFocus()
    await user.tab({ shift: true })
    await user.keyboard('{Enter}')
    const select = await screen.findByLabelText('Category for AUTOMARKET on 2026-06-17')
    expect(select).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Category for AUTOMARKET on 2026-06-17')).not.toBeInTheDocument())
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveFocus()
    // A pick closes the picker back to the chip, which now reads the line.
    await user.keyboard('{Enter}')
    await user.selectOptions(await screen.findByLabelText('Category for AUTOMARKET on 2026-06-17'), 'bi2')
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveTextContent('Soap')
    expect(categoryChip('AUTOMARKET on 2026-06-17')).toHaveFocus()

    // Arrow keys walk the ⋯ menu; Escape closes it back to the ⋯.
    await user.tab()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Member for AUTOMARKET on 2026-06-17' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' })).toHaveFocus()
  })

  it('Undo transfer and Clear split, from a dialog the row’s own chip opened, give focus back to the row’s ⋯', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')

    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    await done(user)
    // The chip that opened the dialog is gone once the transfer is undone: focus lands on the ⋯ instead of nowhere.
    await user.click(screen.getByRole('button', { name: 'Edit transfer for E-BANKING PAYMENT on 2026-06-16' }))
    await screen.findByRole('dialog', { name: 'Transfer' })
    await user.click(screen.getByRole('button', { name: 'Undo transfer for E-BANKING PAYMENT on 2026-06-16' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Edit transfer for E-BANKING PAYMENT on 2026-06-16' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'E-BANKING PAYMENT on 2026-06-16: more actions' })).toHaveFocus()

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Split AUTOMARKET on 2026-06-17')
    await user.type(screen.getByLabelText('Split line 1 amount for AUTOMARKET'), '35')
    await done(user)
    await user.click(screen.getByRole('button', { name: 'Edit split for AUTOMARKET on 2026-06-17' }))
    await screen.findByRole('dialog', { name: 'Split' })
    await user.click(screen.getByRole('button', { name: 'Clear split' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'AUTOMARKET on 2026-06-17: more actions' })).toHaveFocus()
  })

  it('an unfinished row leaves one short foot note, the rules behind its (i), and Import disabled', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const note = screen.getByText(/Finish the highlighted rows first/)
    expect(note).toHaveTextContent(/^Finish the highlighted rows first\.$/)
    expect(note).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByText(/splits must add up/i)).not.toBeInTheDocument()
    expect(await openHint(user, 'What the highlighted rows need')).toHaveTextContent(
      'Splits must add up, transfers need an account, a fee needs a category, and jar amounts can’t exceed what arrived.',
    )
    await closeHint(user, 'What the highlighted rows need')
    expect(screen.getByRole('button', { name: /^Import \d+ transactions?$/ })).toBeDisabled()
  })

  it('each step change puts focus on the new card’s heading: the review, Import complete, the upload card again', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    expect(screen.getByRole('heading', { name: /new transactions? to review/ })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    expect(await screen.findByRole('heading', { name: 'Import complete' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Import another file' }))
    expect(await screen.findByRole('heading', { name: 'Upload a statement' })).toHaveFocus()
  })

  it('a fee the row cannot carry, and a fee without a line, are told as alerts tied to their fields', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')
    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark AUTOMARKET on 2026-06-17 as a transfer')
    const dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    const fee = within(dialog).getByLabelText('Fee for AUTOMARKET on 2026-06-17')
    await user.type(fee, '0')
    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent('The fee must be more than zero and less than the row’s amount.')
    expect(fee).toHaveAttribute('aria-invalid', 'true')
    expect(fee).toHaveAttribute('aria-describedby', error.id)
    await user.clear(fee)
    await user.type(fee, '2')
    expect(fee).not.toHaveAttribute('aria-invalid')
    expect(fee).not.toHaveAttribute('aria-describedby')
    // A fee with no line yet: the select is marked and its message tied to it.
    const line = within(dialog).getByLabelText('Fee category for AUTOMARKET on 2026-06-17')
    const missing = within(dialog).getByRole('alert')
    expect(missing).toHaveTextContent('Choose the fee’s category.')
    expect(line).toHaveAttribute('aria-invalid', 'true')
    expect(line).toHaveAttribute('aria-describedby', missing.id)
  })

  it('a fee the row cannot carry, or one without a line, marks the row itself once the dialog closes (nothing shows a fee that is not recorded)', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')
    const row = () => within(rowOf('Include AUTOMARKET on 2026-06-17'))
    const chip = () => row().getByRole('button', { name: 'Edit transfer for AUTOMARKET on 2026-06-17' })
    const tone = () => row().getByText('Transfer').closest('[data-tone]')?.getAttribute('data-tone')

    await rowAction(user, 'AUTOMARKET on 2026-06-17', 'Mark AUTOMARKET on 2026-06-17 as a transfer')
    let dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    await user.selectOptions(within(dialog).getByLabelText('Transfer account for AUTOMARKET on 2026-06-17'), 'acc2')
    // A fee larger than the row: Done closes the dialog, the row reads bad and names the reason; no "+ fee" line.
    await user.type(within(dialog).getByLabelText('Fee for AUTOMARKET on 2026-06-17'), '99')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer' })).not.toBeInTheDocument())
    expect(tone()).toBe('bad')
    expect(chip()).toHaveAttribute('title', 'The fee must be more than zero and less than the row’s amount.')
    expect(row().queryByText(/\+ fee/)).not.toBeInTheDocument()
    expect(screen.getByText(/Finish the highlighted rows first/)).toBeInTheDocument()

    // A fee the row can carry but no line for it yet: still bad, and the fee line now shows.
    await user.click(chip())
    dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    const fee = within(dialog).getByLabelText('Fee for AUTOMARKET on 2026-06-17')
    await user.clear(fee)
    await user.type(fee, '2')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer' })).not.toBeInTheDocument())
    expect(tone()).toBe('bad')
    expect(chip()).toHaveAttribute('title', 'Choose the fee’s category.')
    expect(row().getByText('+ fee €2.00')).toBeInTheDocument()

    // The line chosen: the row is complete again.
    await user.click(chip())
    dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    await user.selectOptions(within(dialog).getByLabelText('Fee category for AUTOMARKET on 2026-06-17'), 'bi1')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer' })).not.toBeInTheDocument())
    expect(tone()).toBe('line')
    expect(chip()).not.toHaveAttribute('title')
    expect(screen.queryByText(/Finish the highlighted rows first/)).not.toBeInTheDocument()
  })

  it('the Transfer dialog of an unticked row says why its controls are disabled', { timeout: 15000 }, async () => {
    mockPreview.mockResolvedValue(previewWithTransfer())
    const user = userEvent.setup()
    renderPage()
    await goToReview(user, 'acc1')
    await rowAction(user, 'E-BANKING PAYMENT on 2026-06-16', 'Mark E-BANKING PAYMENT on 2026-06-16 as a transfer')
    let dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    expect(within(dialog).queryByText('Tick the row to edit its transfer.')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer' })).not.toBeInTheDocument())
    await user.click(screen.getByLabelText('Include E-BANKING PAYMENT on 2026-06-16'))
    await user.click(screen.getByRole('button', { name: 'Edit transfer for E-BANKING PAYMENT on 2026-06-16' }))
    dialog = await screen.findByRole('dialog', { name: 'Transfer' })
    expect(within(dialog).getByText('Tick the row to edit its transfer.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Transfer account for E-BANKING PAYMENT on 2026-06-16')).toBeDisabled()
  })

  it('the include-all box reads mixed while only some rows are ticked', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    const all = screen.getByLabelText('Include all rows') as HTMLInputElement
    expect(all.indeterminate).toBe(false)
    await user.click(screen.getByLabelText('Include WOLT on 2026-06-15'))
    expect(all.indeterminate).toBe(true)
    expect(all).not.toBeChecked()
    await user.click(all)
    expect(all.indeterminate).toBe(false)
    expect(all).toBeChecked()
    expect(screen.getByLabelText('Include WOLT on 2026-06-15')).toBeChecked()
  })

  // ---- The bulk dialogs and the done card ------------------------------------------------------

  it('the list bar’s ⋯ holds the bulk actions, each a dialog with its (i); Cancel applies nothing', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    expect(await menuItems(user, 'Bulk actions')).toEqual([
      { name: 'Member for included rows', disabled: false },
      { name: 'Category for included expenses', disabled: false },
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Member for included rows' }))
    const dialog = await screen.findByRole('dialog', { name: 'Member for included rows' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(await openHint(user, 'About the bulk member')).toHaveTextContent(/Sets whose spending every ticked row is\./)
    await closeHint(user, 'About the bulk member')
    await user.selectOptions(within(dialog).getByLabelText('Bulk member'), 'm1')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Bulk actions' })).toHaveFocus()
    expect(within(rowOf('Include WOLT on 2026-06-15')).queryByText('Alex')).not.toBeInTheDocument()
  })

  it('the done card: a quiet row of stats, the conditional ones only above zero', { timeout: 15000 }, async () => {
    mockCommit.mockResolvedValue(committed({ transfers: 1, matchedTransfers: 1 }))
    const user = userEvent.setup()
    renderPage()
    await goToReview(user)
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))
    const card = (await screen.findByRole('heading', { name: 'Import complete' })).closest('section')!
    expect(screen.getByText('2 transactions added.')).toBeInTheDocument()
    const labels = Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent)
    expect(labels).toEqual(['Imported', 'Money in', 'Money out', 'Transfers', 'Matched'])
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending review')).not.toBeInTheDocument()
    // Each stat is one div holding its label and its value (the journeys read the pair).
    expect(screen.getByText('Matched').closest('div')).toHaveTextContent('Matched1')
    expect(within(card).getByRole('button', { name: 'Import another file' })).toBeInTheDocument()
  })
})
