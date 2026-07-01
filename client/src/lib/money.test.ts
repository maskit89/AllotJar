import { describe, it, expect, afterEach } from 'vitest'
import {
  fromAmount,
  toAmount,
  sumMinor,
  parseMinor,
  formatMoney,
  toEditString,
  currencySymbol,
  setMoneyFormat,
  currencyNoun,
  detectLocaleDefaults,
  NUMBER_FORMAT_OPTIONS,
} from './money'

describe('money — integer minor units', () => {
  it('round-trips amount <-> minor at scale 4', () => {
    expect(fromAmount(1100)).toBe(11_000_000)
    expect(fromAmount(33.3333)).toBe(333_333)
    expect(toAmount(11_005_000)).toBe(1100.5)
  })

  it('sums exactly where floating point drifts', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754, but integer minor units are exact.
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(sumMinor([fromAmount(0.1), fromAmount(0.2)])).toBe(fromAmount(0.3))
  })

  it('sums a budget with no drift', () => {
    const planned = sumMinor([1100, 180, 120, 60, 400, 90, 250].map(fromAmount))
    expect(toAmount(fromAmount(3000) - planned)).toBe(800)
  })
})

describe('parseMinor', () => {
  it.each([
    ['1100', 11_000_000],
    ['1100,50', 11_005_000], // comma decimal separator
    ['1100.50', 11_005_000],
    ['33.3333', 333_333],
    ['0', 0],
    ['12.99999', 130_000], // rounds half-up beyond 4 dp -> 13.0000
    // European thousands separators (incomes are the biggest figures in a budget)
    ['2.500,00', 25_000_000], // de-DE: dot grouping, comma decimal
    ['1.234.567,89', 12_345_678_900], // multiple grouping separators
    ['1,234.56', 12_345_600], // en: comma grouping, dot decimal
    ["1'234.56", 12_345_600], // de-CH: apostrophe grouping, dot decimal
    ['1’234.56', 12_345_600], // de-CH with a curly apostrophe
    ['1 234,56', 12_345_600], // fr-FR: space grouping, comma decimal
    ['1,23,456.78', 1_234_567_800], // en-IN: lakh grouping, dot decimal
  ])('parses %s -> %i', (input, expected) => {
    expect(parseMinor(input)).toBe(expected)
  })

  // Single-separator ambiguity is preserved: a lone "." or "," is the decimal
  // point, and these malformed inputs still fail the strict check.
  it.each(['', '  ', '-5', 'abc', '1.2.3', '1,2,3'])('rejects %j -> null', (input) => {
    expect(parseMinor(input)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats with the budget currency', () => {
    // Non-breaking spaces vary by runtime; assert on the meaningful parts.
    // The app default is en-GB (€ prefix, comma grouping, dot decimal).
    expect(formatMoney(11_000_000, 'EUR')).toContain('1,100.00')
    expect(formatMoney(11_000_000, 'EUR')).toContain('€')
    expect(formatMoney(4550, 'GBP')).toContain('£')
  })

  it('produces a plain editable string', () => {
    expect(toEditString(11_005_000)).toBe('1100.5')
    expect(toEditString(11_000_000)).toBe('1100')
  })
})

describe('setMoneyFormat — money-display preference', () => {
  const minor = fromAmount(1234.56)

  // Reset to the app default (en-GB / comma-dot) so test order can't leak the active format.
  afterEach(() => setMoneyFormat('comma-dot'))

  it('renders dot-grouping, comma-decimal (de-DE)', () => {
    setMoneyFormat('dot-comma')
    expect(formatMoney(minor, 'EUR')).toContain('1.234,56')
  })

  it('renders comma-grouping, dot-decimal (en-GB)', () => {
    setMoneyFormat('comma-dot')
    expect(formatMoney(minor, 'EUR')).toContain('1,234.56')
  })

  it('renders space-grouping, comma-decimal (fr-FR)', () => {
    setMoneyFormat('space-comma')
    const out = formatMoney(minor, 'EUR')
    expect(out).toContain('234,56') // comma decimal
    expect(out).not.toContain('.234') // grouping is not a dot
    expect(out).not.toContain(',234') // grouping is not a comma
  })

  it('renders apostrophe-grouping, dot-decimal (de-CH)', () => {
    setMoneyFormat('apostrophe')
    const out = formatMoney(minor, 'EUR')
    expect(out).toContain('234.56') // dot decimal
    expect(out).not.toContain('1,234') // grouping is not a comma
    expect(out).not.toContain('1.234') // grouping is not a dot
  })

  it('renders lakh grouping, dot-decimal (en-IN)', () => {
    setMoneyFormat('lakh')
    // Lakh grouping only shows above 100,000: 12,34,567.89.
    expect(formatMoney(fromAmount(1234567.89), 'INR')).toContain('12,34,567.89')
  })

  it('falls back to the default (en-GB) for an unknown/blank format', () => {
    setMoneyFormat('not-a-real-format')
    expect(formatMoney(minor, 'EUR')).toContain('1,234.56')
    setMoneyFormat(null)
    expect(formatMoney(minor, 'EUR')).toContain('1,234.56')
  })

  it('keeps the currency symbol independent of the chosen number format', () => {
    setMoneyFormat('comma-dot')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('EUR')).toBe('€')
  })
})

describe('currencyNoun — the tagline noun', () => {
  it.each([
    ['EUR', 'euro'],
    ['USD', 'dollar'],
    ['GBP', 'pound'],
    ['INR', 'rupee'],
    ['CHF', 'franc'],
    ['JPY', 'yen'],
    ['aud', 'dollar'], // case-insensitive
  ])('maps %s -> %s', (code, noun) => {
    expect(currencyNoun(code)).toBe(noun)
  })

  it('falls back to a neutral "unit" for unknown/blank codes', () => {
    expect(currencyNoun('XYZ')).toBe('unit')
    expect(currencyNoun('')).toBe('unit')
    expect(currencyNoun(null)).toBe('unit')
    expect(currencyNoun(undefined)).toBe('unit')
  })
})

describe('detectLocaleDefaults — browser-locale guess', () => {
  it('returns a supported currency + a known format key', () => {
    const { currency, numberFormat } = detectLocaleDefaults()
    expect(currency).toMatch(/^[A-Z]{3}$/)
    expect(NUMBER_FORMAT_OPTIONS.map((o) => o.value)).toContain(numberFormat)
  })
})
