import { describe, it, expect, vi, afterEach } from 'vitest'
import { shortDate, formatDate, monthYear } from './dates'

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
