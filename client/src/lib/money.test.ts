import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  fromAmount,
  toAmount,
  sumMinor,
  parseMinor,
  formatMoney,
  formatMoneyShort,
  toEditString,
  currencySymbol,
  setMoneyFormat,
  currencyNoun,
  detectLocaleDefaults,
  NUMBER_FORMAT_OPTIONS,
  tooPrecise,
  isExpression,
  expressionTerms,
} from './money'

// D1 (review CL-P3-7): a typed amount is whole cents; one stored with more decimals goes back unchanged (W10).
describe('money — tooPrecise', () => {
  afterEach(() => setMoneyFormat('comma-dot'))

  it('flags a typed third decimal that matters, never one that is only zeros', () => {
    expect(tooPrecise('12.345')).toBe(true)
    expect(tooPrecise('0.0001')).toBe(true)
    expect(tooPrecise('12.34')).toBe(false)
    expect(tooPrecise('12.340')).toBe(false)
    expect(tooPrecise('12')).toBe(false)
    expect(tooPrecise('')).toBe(false)
    expect(tooPrecise('abc')).toBe(false)
  })

  it('lets the stored amount go back as it opened', () => {
    expect(tooPrecise('12.3456', fromAmount(12.3456))).toBe(false)
    expect(tooPrecise('12.3455', fromAmount(12.3456))).toBe(true)
  })

  it('reads the separators as the active format does', () => {
    setMoneyFormat('dot-comma')
    expect(tooPrecise('12,345')).toBe(true)
    expect(tooPrecise('12.345')).toBe(false) // grouping: twelve thousand three hundred and forty-five
    expect(tooPrecise('1.234,567')).toBe(true)
  })
})

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

  // A sum typed into the field (5 October 2026, Christopher's note "monetary amounts to be able
  // to enter a summation"): 50 for the vet is typed as 20+30 and saves as 50.
  // Arithmetic typed into the field (5 October 2026, Christopher's note "monetary amounts to be
  // able to enter a summation", then at 14:53 "add the other basic arithmetic symbols as well"):
  // 50 for the vet is typed as 20+30 and saves as 50; * and / first, then + and -, left to right.
  describe('arithmetic', () => {
    it.each([
      ['20+30', 500_000],
      ['20 + 30', 500_000],
      ['10+10+5', 250_000],
      ['1,500+0.50', 15_005_000], // a grouped term under comma-dot
      ['12,50+1', 135_000], // the sibling separator read as a decimal, as alone
      ['50-12.50', 375_000],
      ['-5+10', 50_000],
      ['3*19.99', 599_700],
      ['3×19.99', 599_700],
      ['120/4', 300_000],
      ['120÷4', 300_000],
      ['100−1', 990_000],
      ['2+3*4', 140_000], // precedence, not left to right
      ['10-2*3+1', 50_000],
      ['10/3', 33_300], // the result is rounded half-up to cents (D1)
      ['2/3', 6_700],
      ['10/3*3', 100_000], // only the result is rounded, as on a calculator (review P3-6)
      ['1/3*3', 10_000],
      ['100/3*3', 1_000_000],
      ['1.25*1.25', 15_600], // 1.5625 → 1.56
      ['0.005*3', 200], // 0.015 → 0.02
      ['10-10', 0],
      ['100/8/5', 25_000], // left to right
      ['1500/4', 3_750_000], // not a year and a month (review P3-7)
      ['2000-50', 19_500_000],
      ['2000/12', 1_666_700], // a yearly bill split into months (review P3-8)
      ['2024/4', 5_060_000],
      ['2026/10', 2_026_000], // a year-first slash is never pasted as a date
    ])('works %s out to %i', (input, expected) => {
      expect(parseMinor(input)).toBe(expected)
      expect(isExpression(input)).toBe(true)
    })

    it.each([
      '20+', '+5', '20++30', '20*/3', '20+abc', '*5', // half-typed or not an amount
      '5-10', '-5', '10-20+5', // below zero: an amount is a magnitude
      '5/0', '5/0.00', // division by zero
      '2026-03-10', '10/03/2026', '10-03-26', '10/03/26', '2026/03/10', // a pasted date (review P3-1)
      '2026-10', '10/2026', '12/2026', '10-2026', '2026-3', // a pasted month (review P3-7, P3-8)
      '2026-03-10+0', '2026-10*2', '5+2026-03-10', // a date with an operator around it
      '1'.repeat(400) + '*0', '1'.repeat(400) + '+1', // a run of digits that overflows (review P3-5)
    ])('refuses %s', (input) => {
      expect(parseMinor(input)).toBeNull()
    })

    it('tells a date from a sum or a range of amounts', () => {
      expect(parseMinor('12-5')).toBe(70_000)
      expect(parseMinor('1-2-3')).toBeNull() // every part one or two digits reads as a date
      expect(parseMinor('100-20-3')).toBe(770_000) // a three-digit part is not a date part
      expect(parseMinor('20.26-3-10')).toBe(72_600) // a decimal is never a date part
      expect(parseMinor('2026-03-10.50')).toBeNull() // but it starts with a year and a month
      expect(parseMinor('2024-4')).toBeNull() // a year and a month, even without the zero
      expect(parseMinor('1899-10')).toBe(18_890_000) // not a year
      expect(parseMinor('2026-13')).toBe(20_130_000) // not a month
    })

    it('refuses a plain run of digits that overflows, rather than saving Infinity', () => {
      expect(parseMinor('1'.repeat(400))).toBeNull()
    })

    it('is not an expression when there is nothing to work out', () => {
      expect(isExpression('20')).toBe(false)
      expect(isExpression('20.50')).toBe(false)
      expect(expressionTerms('1,500')).toBeNull()
    })

    it('refuses a term with a third decimal that matters, never a result that happens to have one', () => {
      expect(tooPrecise('20.005+1')).toBe(true)
      expect(tooPrecise('20.50+1.25')).toBe(false)
      expect(tooPrecise('20.500+1')).toBe(false)
      expect(tooPrecise('10/3')).toBe(false)
    })
  })

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
  it('returns the euro + a known format key', () => {
    const { currency, numberFormat } = detectLocaleDefaults()
    expect(currency).toBe('EUR')
    expect(NUMBER_FORMAT_OPTIONS.map((o) => o.value)).toContain(numberFormat)
  })

  it('preselects the euro whatever the browser locale', () => {
    for (const lang of ['en-US', 'en-GB', 'de-CH', 'ja-JP', 'en-IN']) {
      const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue(lang)
      try {
        expect(detectLocaleDefaults().currency).toBe('EUR')
      } finally {
        spy.mockRestore()
      }
    }
  })
})

describe('formatMoneyShort — whole amounts drop their decimals', () => {
  afterEach(() => setMoneyFormat('comma-dot'))

  it('drops the decimals of a whole amount and keeps them otherwise', () => {
    expect(formatMoneyShort(1_750_000, 'EUR')).toBe('€175')
    expect(formatMoneyShort(17_505_000, 'EUR')).toBe('€1,750.50')
    expect(formatMoneyShort(0, 'EUR')).toBe('€0')
    expect(formatMoneyShort(-2_000_000, 'GBP')).toBe('-£200')
  })

  it('follows the active money format', () => {
    setMoneyFormat('dot-comma')
    expect(formatMoneyShort(1_750_000, 'EUR')).toBe(formatMoney(1_750_000, 'EUR').replace(',00', ''))
  })
})
