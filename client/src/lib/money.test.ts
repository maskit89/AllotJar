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
  // Reset to the app default (comma-dot / en-GB) so a per-test format can't leak.
  afterEach(() => setMoneyFormat('comma-dot'))

  // Format-agnostic cases: no separator, a dot decimal (the default format's
  // decimal), and dual-separator amounts whose right-most separator is the decimal.
  it.each([
    ['1100', 11_000_000],
    ['1100.50', 11_005_000], // dot decimal (comma-dot default)
    ['33.3333', 333_333],
    ['0', 0],
    ['12.99999', 130_000], // rounds half-up beyond 4 dp -> 13.0000
    // Thousands separators (incomes are the biggest figures in a budget)
    ['2.500,00', 25_000_000], // dot grouping, comma decimal (right-most is decimal)
    ['1.234.567,89', 12_345_678_900], // multiple grouping separators
    ['1,234.56', 12_345_600], // comma grouping, dot decimal
    ["1'234.56", 12_345_600], // apostrophe grouping, dot decimal
    ['1’234.56', 12_345_600], // curly apostrophe grouping
    ['1,23,456.78', 1_234_567_800], // lakh grouping, dot decimal
  ])('parses %s -> %i (default comma-dot)', (input, expected) => {
    expect(parseMinor(input)).toBe(expected)
  })

  // A lone separator now takes its role from the active money format, so parsing
  // agrees with formatting (audit F14). Grouped whole numbers round-trip and
  // decimals still parse — verified across every format the picker offers.
  describe('single separator resolves by active format', () => {
    it('comma-dot: comma groups, dot is the decimal', () => {
      setMoneyFormat('comma-dot')
      expect(parseMinor('1,500')).toBe(15_000_000) // grouped 1500.00
      expect(parseMinor('12,345')).toBe(123_450_000) // grouped 12345.00
      expect(parseMinor('1.50')).toBe(15_000) // decimal 1.50
      expect(parseMinor('1.234')).toBe(12_340) // decimal 1.234 (three dp)
    })

    it('dot-comma: dot groups, comma is the decimal', () => {
      setMoneyFormat('dot-comma')
      expect(parseMinor('1.500')).toBe(15_000_000) // grouped 1500,00
      expect(parseMinor('12.345')).toBe(123_450_000) // grouped 12345,00
      expect(parseMinor('1,50')).toBe(15_000) // decimal 1,50
      expect(parseMinor('1100,50')).toBe(11_005_000) // decimal 1100,50
    })

    it('space-comma: comma is the decimal, a stray dot groups', () => {
      setMoneyFormat('space-comma')
      expect(parseMinor('1 234,56')).toBe(12_345_600) // space grouping + comma decimal
      expect(parseMinor('1,50')).toBe(15_000) // decimal 1,50
      expect(parseMinor('1.500')).toBe(15_000_000) // stray dot treated as grouping
    })

    it('apostrophe: dot is the decimal, a stray comma groups', () => {
      setMoneyFormat('apostrophe')
      expect(parseMinor("1'234.56")).toBe(12_345_600) // apostrophe grouping + dot decimal
      expect(parseMinor('1.50')).toBe(15_000) // decimal 1.50
      expect(parseMinor('1,500')).toBe(15_000_000) // stray comma treated as grouping
    })

    it('lakh: comma groups (incl. lakh grouping), dot is the decimal', () => {
      setMoneyFormat('lakh')
      expect(parseMinor('1,500')).toBe(15_000_000) // grouped 1500.00
      expect(parseMinor('1,23,456')).toBe(1_234_560_000) // lakh grouping
      expect(parseMinor('1.50')).toBe(15_000) // decimal 1.50
    })
  })

  // Genuinely malformed input still returns null (a lone "." or "," collapses to a
  // decimal, so "1.2.3" / "1,2,3" still fail the strict check).
  it.each(['', '  ', '-5', 'abc', '1.2.3', '1,2,3'])('rejects %j -> null', (input) => {
    expect(parseMinor(input)).toBeNull()
  })

  // When the lone separator is the format's non-decimal char but the digits can't
  // be valid grouping (a 2-digit trailing group), the user typed the sibling
  // separator as a decimal point — a common habit. We read it as a decimal rather
  // than mangling it, so "12,50" under comma-dot stays 12.50 (only the F14
  // valid-grouping case, "1,500" -> 1500, changes behaviour).
  it('reads the sibling separator as a decimal when it cannot be grouping', () => {
    setMoneyFormat('comma-dot')
    expect(parseMinor('12,50')).toBe(125_000) // 12.50, not 1250 or null
    expect(parseMinor('1,5')).toBe(15_000) // 1.5
    setMoneyFormat('dot-comma')
    expect(parseMinor('12.50')).toBe(125_000) // 12.50
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

  it("uses each currency's natural fraction digits", () => {
    // JPY has no minor unit — whole yen, no decimals.
    expect(formatMoney(fromAmount(1234), 'JPY')).toContain('1,234')
    expect(formatMoney(fromAmount(1234), 'JPY')).not.toContain('1,234.0')
    // Kuwaiti dinar has three.
    expect(formatMoney(fromAmount(1234.567), 'KWD')).toContain('1,234.567')
  })

  it('produces a plain editable string', () => {
    expect(toEditString(11_005_000)).toBe('1100.5')
    expect(toEditString(11_000_000)).toBe('1100')
  })
})

describe('editable amounts', () => {
  afterEach(() => setMoneyFormat('comma-dot'))

  it.each(NUMBER_FORMAT_OPTIONS)('preserves stored precision when editing with $value', ({ value }) => {
    setMoneyFormat(value)

    // Includes the ambiguous three-digit fraction (1.234), the smallest stored
    // unit, and four-decimal values that currency display formatting would round.
    for (const minor of [0, 1, 12_340, 333_333, 11_005_000, 12_345_678_901]) {
      expect(parseMinor(toEditString(minor))).toBe(minor)
    }
  })

  it('uses the preferred decimal separator without adding grouping', () => {
    setMoneyFormat('dot-comma')
    expect(toEditString(12_340)).toBe('1,234')
    expect(toEditString(12_345_678_901)).toBe('1234567,8901')
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
