import { describe, it, expect } from 'vitest'
import { shortDate, formatDate } from './dates'

// jsdom's navigator.language is en-US, so these assert the en-US rendering; the
// helpers follow the browser locale at runtime.
describe('shortDate', () => {
  it('formats an ISO date as a compact month + day (no year)', () => {
    expect(shortDate('2026-06-20')).toBe('Jun 20')
    expect(shortDate('2026-01-05')).toBe('Jan 5')
  })

  it('does not shift the day across a timezone boundary', () => {
    // Parsed as local midnight, not UTC — so it never rolls back to the 19th.
    expect(shortDate('2026-06-20')).toContain('20')
  })

  it('returns the input unchanged when it is not a parseable ISO date', () => {
    expect(shortDate('')).toBe('')
    expect(shortDate('not-a-date')).toBe('not-a-date')
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
