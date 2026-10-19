import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

// A phone resumes the installed app rather than starting it afresh, so coming back in a new
// month must move a view that was on the current month on to the new one, as a fresh start
// would; a month picked on purpose stays put, and nothing moves under an entry being made.
describe('coming back to the app in a new month', () => {
  function Navigator() {
    const { label, goPrev } = useMonth()
    return (
      <>
        <p>{label}</p>
        <button onClick={goPrev}>Previous month</button>
      </>
    )
  }

  function awayUntil(iso: string) {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.setSystemTime(new Date(iso))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('moves on from October to November when the app was showing October', () => {
    vi.setSystemTime(new Date('2026-10-31T21:00:00Z'))
    render(
      <MonthProvider>
        <Navigator />
      </MonthProvider>,
    )
    expect(screen.getByText('October 2026')).toBeInTheDocument()

    awayUntil('2026-11-01T07:30:00Z')

    expect(screen.getByText('November 2026')).toBeInTheDocument()
  })

  it('stays on a month picked on purpose', () => {
    vi.setSystemTime(new Date('2026-10-31T21:00:00Z'))
    render(
      <MonthProvider>
        <Navigator />
      </MonthProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByText('September 2026')).toBeInTheDocument()

    awayUntil('2026-11-01T07:30:00Z')

    expect(screen.getByText('September 2026')).toBeInTheDocument()
  })

  it('stays put within the same month', () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
    render(
      <MonthProvider>
        <Navigator />
      </MonthProvider>,
    )
    awayUntil('2026-10-20T12:00:00Z')
    expect(screen.getByText('October 2026')).toBeInTheDocument()
  })

  it('waits while a dialog is open, then moves on the next time the app comes back', () => {
    vi.setSystemTime(new Date('2026-10-31T21:00:00Z'))
    const { rerender } = render(
      <MonthProvider>
        <Navigator />
        <div role="dialog" aria-label="Add a transaction" />
      </MonthProvider>,
    )
    awayUntil('2026-11-01T07:30:00Z')
    expect(screen.getByText('October 2026')).toBeInTheDocument()

    rerender(
      <MonthProvider>
        <Navigator />
      </MonthProvider>,
    )
    awayUntil('2026-11-01T08:00:00Z')
    expect(screen.getByText('November 2026')).toBeInTheDocument()
  })
})
