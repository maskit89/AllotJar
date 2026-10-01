import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MonthProvider, useMonth } from './MonthContext'
import { currentMonth } from '../lib/dates'

function Shown() {
  const { label } = useMonth()
  return <p>{label}</p>
}

// Rule 82, P14: the current month is the UTC month, as on the server. In Malta (UTC+1 in
// winter, +2 in summer) the local calendar turns the month an hour or two before UTC does; the
// app must not show a month the server still counts as the future.
describe('the current month follows the UTC calendar', () => {
  // The test runner's Node environment; the app's tsconfig has no Node types.
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
  const tz = env.TZ
  afterEach(() => {
    env.TZ = tz
  })

  it('opens on October at 00:30 on 1 November Malta time', () => {
    env.TZ = 'Europe/Malta'
    vi.setSystemTime(new Date('2026-10-31T23:30:00Z'))
    expect(currentMonth()).toEqual({ year: 2026, month: 10 })
    render(
      <MonthProvider>
        <Shown />
      </MonthProvider>,
    )
    expect(screen.getByText('October 2026')).toBeInTheDocument()
  })

  it('opens on the new month once midnight UTC has passed, across a year end', () => {
    env.TZ = 'Europe/Malta'
    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'))
    expect(currentMonth()).toEqual({ year: 2026, month: 12 })
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    expect(currentMonth()).toEqual({ year: 2027, month: 1 })
    render(
      <MonthProvider>
        <Shown />
      </MonthProvider>,
    )
    expect(screen.getByText('January 2027')).toBeInTheDocument()
  })
})
