import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JarDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, mockPut, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar } from '../test/fixtures/jars'

// A date can be just a month (jar setup plan, PR 2): the form asks for a month, sends
// the 1st of that month with monthOnly, and the card reads "Mar 2027". The plan is the 1st's, so
// nothing else about the jar changes.

let fundsData: JarDto[] = []

const renderPage = () => renderWithProviders(<JarsPage />)

async function openNewJar(user: ReturnType<typeof userEvent.setup>) {
  renderPage()
  await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('JarsPage — a date that is just a month', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
    fundsData = []
    mockGet.mockImplementation((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [account()] })
      if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
      if (url === '/jars') return Promise.resolve({ data: fundsData })
      return Promise.resolve({ data: {} })
    })
  })

  it('asks for a date by default, and for a month when Month is picked', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    expect(dialog.getByRole('radio', { name: 'Date' })).toBeChecked()
    expect(dialog.getByLabelText('Needed by')).toHaveAttribute('type', 'date')
    expect(dialog.queryByLabelText('Needed by (month)')).not.toBeInTheDocument()

    await user.click(dialog.getByRole('radio', { name: 'Month' }))

    expect(dialog.getByRole('radio', { name: 'Month' })).toBeChecked()
    expect(dialog.queryByLabelText('Needed by')).not.toBeInTheDocument()
    expect(dialog.getByLabelText('Needed by (month)')).toHaveValue('')
    // The months run from the next one (the tests' clock is October 2026: this month's 1st has
    // passed) to the end of the year ten years on.
    const months = within(dialog.getByLabelText('Needed by (month)')).getAllByRole('option').map((o) => o.textContent)
    expect(months[0]).toBe('Pick a month')
    expect(months[1]).toBe('Nov 2026')
    expect(months.at(-1)).toBe('Dec 2036')
    expect(months).toHaveLength(1 + 2 + 10 * 12)
  })

  it('creates a jar needed by a month: the 1st of it, sent with monthOnly', { timeout: 15000 }, async () => {
    mockPost.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/jars' ? jar({ id: 'f9', name: 'Holiday', kind: 1, recurMonths: null, monthOnly: true }) : {} }),
    )
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '1500')
    await user.click(dialog.getByRole('radio', { name: 'Month' }))
    await user.selectOptions(dialog.getByLabelText('Needed by (month)'), 'Jul 2027')

    // The preview plans toward the 1st, exactly as a date on the 1st would.
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars/schedule', expect.objectContaining({ targetDate: '2027-07-01', includeDeadlineMonth: false })),
    )
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ kind: 1, targetDate: '2027-07-01', monthOnly: true, accrual: 1 })),
    )
  })

  it('needs a month before it saves', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '1500')
    await user.click(dialog.getByRole('radio', { name: 'Month' }))
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Pick the month the money is needed by.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalledWith('/jars', expect.anything())
  })

  it('keeps the month when switching between a date and just the month', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2027-03-15' } })
    await user.click(dialog.getByRole('radio', { name: 'Month' }))
    expect(dialog.getByLabelText('Needed by (month)')).toHaveValue('2027-03-01')

    // Back to a date: the 1st of that month, until another day is picked.
    await user.click(dialog.getByRole('radio', { name: 'Date' }))
    expect(dialog.getByLabelText('Needed by')).toHaveValue('2027-03-01')
  })

  it('a date later this month asks for a month again: this month\'s 1st has passed', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    await user.type(dialog.getByLabelText('Jar name'), 'Holiday')
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Needed by'), { target: { value: '2026-10-28' } })
    await user.click(dialog.getByRole('radio', { name: 'Month' }))

    const picker = dialog.getByLabelText('Needed by (month)')
    expect(picker).toHaveValue('')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent).slice(0, 2)).toEqual(['Pick a month', 'Nov 2026'])
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    expect(await dialog.findByText('Pick the month the money is needed by.')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalledWith('/jars', expect.anything())
  })

  it('an edited jar due later this month asks for a month the same way', { timeout: 15000 }, async () => {
    fundsData = [jar({ targetDate: '2026-10-28', deadline: '2026-10-28' })]
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Home insurance' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
    await user.click(dialog.getByRole('radio', { name: 'Month' }))

    expect(dialog.getByLabelText('Next due (month)')).toHaveValue('')
  })

  it('a repeating jar is due in a month: "Next due" asks for it the same way', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Repeats'), 'Yearly')
    await user.click(dialog.getByRole('radio', { name: 'Month' }))

    expect(dialog.getByLabelText('Next due (month)')).toBeInTheDocument()
    expect(dialog.queryByLabelText('Next due date')).not.toBeInTheDocument()
  })

  it('edits a jar due in a month: it opens on Month and saves monthOnly again', { timeout: 15000 }, async () => {
    fundsData = [jar({ targetDate: '2027-03-01', deadline: '2027-03-01', monthOnly: true })]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Home insurance' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByRole('radio', { name: 'Month' })).toBeChecked()
    expect(dialog.getByLabelText('Next due (month)')).toHaveValue('2027-03-01')
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ targetDate: '2027-03-01', monthOnly: true, kind: 0 })),
    )
  })

  it('an edited jar due in a month that has passed keeps it on offer', { timeout: 15000 }, async () => {
    fundsData = [jar({ targetDate: '2026-09-01', deadline: '2026-09-01', monthOnly: true, status: 'DeadlineMissed', shortfall: 50 })]
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Home insurance' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    const picker = dialog.getByLabelText('Next due (month)')
    expect(picker).toHaveValue('2026-09-01')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent).slice(0, 3)).toEqual(['Pick a month', 'Sep 2026', 'Nov 2026'])

    // It is the jar's own month, so a trip to Date and back keeps it.
    await user.click(dialog.getByRole('radio', { name: 'Date' }))
    await user.click(dialog.getByRole('radio', { name: 'Month' }))
    expect(dialog.getByLabelText('Next due (month)')).toHaveValue('2026-09-01')
  })

  it('a full date stays a full date: monthOnly is sent false', { timeout: 15000 }, async () => {
    fundsData = [jar()]
    mockPut.mockResolvedValue({ data: fundsData[0] })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Edit Home insurance' }, { timeout: 5000 }))
    const dialog = within(await screen.findByRole('dialog', {}, { timeout: 5000 }))

    expect(dialog.getByRole('radio', { name: 'Date' })).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Save jar' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/jars/f1', expect.objectContaining({ targetDate: '2026-12-01', monthOnly: false })),
    )
  })

  it('the cards read the month, not the 1st', { timeout: 15000 }, async () => {
    fundsData = [
      jar({ targetDate: '2027-03-01', deadline: '2027-03-01', monthOnly: true }),
      jar({ id: 'f2', name: 'Holiday', kind: 1, recurMonths: null, targetDate: '2027-07-01', deadline: '2027-07-01', monthOnly: true }),
    ]
    renderPage()

    expect(await screen.findByText('Due Mar 2027 · yearly', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Needed by Jul 2027')).toBeInTheDocument()
  })
})
