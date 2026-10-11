import { describe, it, expect, vi, afterEach } from 'vitest'
import { shortDate, formatDate, monthYear, dayHeading } from './dates'

// jsdom's navigator.language is en-US, so these assert the en-US rendering; the
// helpers follow the browser locale at runtime.
describe('shortDate', () => {
  it('formats an ISO date as a compact month + day (no year)', () => {
    expect(shortDate('2026-06-20')).toBe('Jun 20')
    expect(shortDate('2026-01-05')).toBe('Jan 5')
  })

  it('does not shift the day across a timezone boundary', () => {
    // Calendar dates must never roll back to the 19th.
    expect(shortDate('2026-06-20')).toContain('20')
  })

  it('returns the input unchanged when it is not a parseable ISO date', () => {
    expect(shortDate('')).toBe('')
    expect(shortDate('not-a-date')).toBe('not-a-date')
  })
})

describe('calendar dates across timezone changes', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('keeps the same date with cached formatters in every timezone', () => {
    for (const timezone of ['UTC', 'Europe/Malta', 'America/New_York', 'Pacific/Kiritimati']) {
      vi.stubEnv('TZ', timezone)
      expect(shortDate('2026-11-01')).toBe('Nov 1')
      expect(formatDate('2026-11-01')).toBe('Nov 1, 2026')
      expect(monthYear('2026-11-01')).toBe('Nov 2026')
    }
  })
})

describe('formatDate', () => {
  it('includes the year', () => {
    expect(formatDate('2026-06-20')).toContain('2026')
    expect(formatDate('2026-06-20')).toMatch(/Jun/)
  })

  it('returns the input unchanged for a non-ISO value', () => {
    expect(formatDate('garbage')).toBe('garbage')
  })
})

describe('monthYear', () => {
  it('renders the month and year with no day', () => {
    expect(monthYear('2026-11-01')).toBe('Nov 2026')
    expect(monthYear('2026-11-30')).toBe('Nov 2026') // day is dropped
  })

  it('returns the input unchanged for a non-ISO value', () => {
    expect(monthYear('soon')).toBe('soon')
  })
})

describe('dayHeading', () => {
  // Sunday 11 Oct 2026, midday UTC.
  const now = new Date(Date.UTC(2026, 9, 11, 12))
  afterEach(() => vi.restoreAllMocks())

  it('names today and yesterday', () => {
    expect(dayHeading('2026-10-11', now)).toBe('Today')
    expect(dayHeading('2026-10-10', now)).toBe('Yesterday')
  })

  it('gives the weekday, a space and the date in the browser locale, the year only for another year', () => {
    // jsdom's navigator.language is en-US.
    expect(dayHeading('2026-10-07', now)).toBe('Wed Oct 7')
    expect(dayHeading('2025-12-31', now)).toBe('Wed Dec 31, 2025')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-GB')
    expect(dayHeading('2026-10-07', now)).toBe('Wed 7 Oct')
    expect(dayHeading('2025-12-31', now)).toBe('Wed 31 Dec 2025')
  })

  it('counts today on the UTC calendar, as todayIso does', () => {
    // 00:30 UTC on the 12th is still the 11th in New York, but the app's "today" is UTC's.
    const justAfterMidnight = new Date(Date.UTC(2026, 9, 12, 0, 30))
    expect(dayHeading('2026-10-12', justAfterMidnight)).toBe('Today')
    expect(dayHeading('2026-10-11', justAfterMidnight)).toBe('Yesterday')
  })

  it('returns the input unchanged when it is not a parseable ISO date', () => {
    expect(dayHeading('not-a-date', now)).toBe('not-a-date')
  })
})
