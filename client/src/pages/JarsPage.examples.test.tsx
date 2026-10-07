import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JarDto } from '../types'

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { JarsPage } from './JarsPage'
import { account, jar } from '../test/fixtures/jars'
import { me } from '../test/fixtures/me'
import { setMoneyFormat } from '../lib/money'
import { jarExamples } from '../lib/jarForm'

// Help before the form (jar setup plan, PR 3): the empty Jars page offers one example of each shape
// the form makes, and picking one opens the form filled in. Nothing is saved until Add jar.

function mockLoads(meRole?: number) {
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith('/jars/ledger')) return Promise.resolve({ data: [] })
    if (url === '/jars') return Promise.resolve({ data: [] as JarDto[] })
    if (url === '/accounts') return Promise.resolve({ data: [account()] })
    if (url === '/auth/me') return Promise.resolve({ data: meRole === undefined ? {} : me({ role: meRole }) })
    return Promise.resolve({ data: {} })
  })
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  renderWithProviders(<JarsPage />)
  await user.click(await screen.findByRole('button', { name }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('JarsPage — example jars on the empty page', () => {
  beforeEach(() => {
    resetApiMocks()
    mockPost.mockResolvedValue({ data: {} })
    setMoneyFormat('comma-dot')
    mockLoads()
  })

  it('offers a yearly bill, a holiday by a month and a rainy-day pot, beside New jar', { timeout: 15000 }, async () => {
    renderWithProviders(<JarsPage />)

    expect(await screen.findByText('No jars yet', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Car insurance, €600.00 · yearly' })).toBeInTheDocument()
    // The tests' clock is 15 October 2026: the next July is 2027's.
    expect(screen.getByRole('button', { name: 'Summer holiday, €1,500.00 · Jul 2027' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rainy day, €50.00 a month' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New jar' })).toBeInTheDocument()
  })

  it('the yearly bill opens the form filled in, due in a month six months on, and saves only on Add jar', { timeout: 15000 }, async () => {
    mockPost.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/jars' ? jar({ name: 'Car insurance', targetAmount: 600, monthOnly: true }) : {} }),
    )
    const user = userEvent.setup()
    const dialog = await pick(user, /^Car insurance/)

    expect(dialog.getByLabelText('Jar name')).toHaveValue('Car insurance')
    expect(dialog.getByLabelText('Target amount')).toHaveValue('600')
    expect(dialog.getByLabelText('Repeats')).toHaveDisplayValue('Yearly')
    expect(dialog.getByRole('radio', { name: 'Month' })).toBeChecked()
    expect(dialog.getByLabelText('Next due (month)')).toHaveDisplayValue('Apr 2027')
    expect(mockPost).not.toHaveBeenCalledWith('/jars', expect.anything())

    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({
        name: 'Car insurance', kind: 0, recurMonths: 12, targetAmount: 600, targetDate: '2027-04-01', monthOnly: true, accrual: 1,
      })),
    )
  })

  it('the holiday is a one-off saving by Jul 2027', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await pick(user, /^Summer holiday/)

    expect(dialog.getByLabelText('Jar name')).toHaveValue('Summer holiday')
    expect(dialog.getByLabelText('Target amount')).toHaveValue('1500')
    expect(dialog.getByLabelText('Repeats')).toHaveDisplayValue('Doesn’t repeat')
    expect(dialog.getByLabelText('Needed by (month)')).toHaveDisplayValue('Jul 2027')
  })

  it('the rainy-day pot sets aside a fixed amount each month, with no target', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await pick(user, /^Rainy day/)

    expect(dialog.getByLabelText('Jar name')).toHaveValue('Rainy day')
    expect(dialog.getByLabelText('Set aside a fixed amount each month')).toBeChecked()
    expect(dialog.getByLabelText('Each month')).toHaveValue('50')
  })

  it('New jar still opens an empty form', { timeout: 15000 }, async () => {
    const user = userEvent.setup()
    const dialog = await pick(user, /^New jar$/)

    expect(dialog.getByLabelText('Jar name')).toHaveValue('')
    expect(dialog.getByRole('radio', { name: 'Date' })).toBeChecked()
  })

  it('a read-only login sees no examples', { timeout: 15000 }, async () => {
    mockLoads(3)
    renderWithProviders(<JarsPage />)

    expect(await screen.findByText('No jars yet', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Car insurance/ })).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('Start from one of these, or make your own.')).not.toBeInTheDocument()
  })
})

describe('jarExamples — the months they are due in', () => {
  it.each([
    ['2026-10-15', '2027-04-01', '2027-07-01'],
    ['2027-06-30', '2027-12-01', '2027-07-01'],
    ['2027-07-01', '2028-01-01', '2028-07-01'],
    ['2026-12-31', '2027-06-01', '2027-07-01'],
  ])('on %s the bill is due in %s and the holiday in %s', (today, bill, holiday) => {
    const [insurance, summer, rainy] = jarExamples(new Date(`${today}T12:00:00Z`))
    expect(insurance.month).toBe(bill)
    expect(summer.month).toBe(holiday)
    expect(rainy.month).toBe('')
  })
})
