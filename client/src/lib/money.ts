// Money on the client is an integer count of minor units at SCALE 4
// (ten-thousandths of a Euro), matching the backend's decimal(18,4).
//
// Why integers: every budget total is a SUM of line amounts. Summing IEEE-754
// doubles can accumulate drift (0.1 + 0.2 !== 0.3); summing integers cannot.
// We therefore convert to integer minor units at the API boundary, do all
// arithmetic on integers, and only divide by SCALE for display/transport.
//
// Safe-range note: a JS number is an exact integer up to 2^53. At scale 4 that
// covers budgets up to ~900 billion EUR — far beyond any personal budget. If
// the full decimal(18,4) range is ever required, swap `Minor` to bigint; the
// call sites below are the only places that would change.

const FACTOR = 10_000

/** Integer minor units — ten-thousandths of a Euro. */
export type Minor = number

/** API JSON amount (a decimal with <= 4 dp) -> integer minor units. */
export function fromAmount(amount: number): Minor {
  return Math.round(amount * FACTOR)
}

/** Integer minor units -> decimal number for the API wire format. */
export function toAmount(minor: Minor): number {
  return minor / FACTOR
}

/** Exact integer sum. */
export function sumMinor(values: Minor[]): Minor {
  return values.reduce((acc, v) => acc + v, 0)
}

/** Ungrouped editable amount, preserving stored precision in the user's decimal format. */
export function toEditString(minor: Minor): string {
  // Match parseMinor's active decimal separator: a dot in "1.234" would be
  // interpreted as grouping under comma-decimal preferences and become 1234.
  return (minor / FACTOR).toString().replace('.', activeDecimalSeparator())
}

// --- Display preferences ----------------------------------------------------
// The grouping/decimal style is a per-user preference, independent of the currency
// (a EUR user may still prefer "1,234.56"). Each key maps to a locale that renders it.

/** The money grouping/decimal styles a user can choose. */
export type NumberFormatKey = 'dot-comma' | 'comma-dot' | 'space-comma' | 'apostrophe' | 'lakh'

const FORMAT_LOCALES: Record<NumberFormatKey, string> = {
  'dot-comma': 'de-DE', // 1.234,56
  'comma-dot': 'en-GB', // 1,234.56
  'space-comma': 'fr-FR', // 1 234,56
  apostrophe: 'de-CH', // 1'234.56  (Switzerland/Liechtenstein)
  lakh: 'en-IN', // 1,23,456.78  (Indian lakh/crore grouping)
}

/** Selectable money-format presets for the sign-up + preferences UI (value → worked example). */
export const NUMBER_FORMAT_OPTIONS: { value: NumberFormatKey; label: string }[] = [
  { value: 'comma-dot', label: '1,234.56' },
  { value: 'dot-comma', label: '1.234,56' },
  { value: 'space-comma', label: '1 234,56' },
  { value: 'apostrophe', label: "1'234.56" },
  { value: 'lakh', label: '1,23,456.78' },
]

/**
 * The currencies offered at sign-up and in preferences (ISO code → display label).
 * A curated global set — the euro and its European neighbours lead (AllotJar's
 * home), followed by the major world currencies so anyone, anywhere, finds theirs.
 * The engine accepts any ISO 4217 code; this is only the picker's shortlist.
 */
export const CURRENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'EUR', label: 'Euro (€)' },
  { value: 'GBP', label: 'British pound (£)' },
  { value: 'USD', label: 'US dollar ($)' },
  { value: 'CHF', label: 'Swiss franc (CHF)' },
  { value: 'CAD', label: 'Canadian dollar (C$)' },
  { value: 'AUD', label: 'Australian dollar (A$)' },
  { value: 'NZD', label: 'New Zealand dollar (NZ$)' },
  { value: 'JPY', label: 'Japanese yen (¥)' },
  { value: 'INR', label: 'Indian rupee (₹)' },
  { value: 'SGD', label: 'Singapore dollar (S$)' },
  { value: 'HKD', label: 'Hong Kong dollar (HK$)' },
  { value: 'SEK', label: 'Swedish krona (kr)' },
  { value: 'NOK', label: 'Norwegian krone (kr)' },
  { value: 'DKK', label: 'Danish krone (kr)' },
  { value: 'PLN', label: 'Polish złoty (zł)' },
  { value: 'CZK', label: 'Czech koruna (Kč)' },
  { value: 'HUF', label: 'Hungarian forint (Ft)' },
  { value: 'RON', label: 'Romanian leu (lei)' },
  { value: 'ZAR', label: 'South African rand (R)' },
  { value: 'BRL', label: 'Brazilian real (R$)' },
  { value: 'MXN', label: 'Mexican peso (Mex$)' },
  { value: 'AED', label: 'UAE dirham (AED)' },
  { value: 'SAR', label: 'Saudi riyal (SAR)' },
  { value: 'TRY', label: 'Turkish lira (₺)' },
]

/**
 * The singular noun for a currency, used by the "give every ___ a job" tagline so
 * it speaks the signed-in user's money ("every euro", "every rupee"). Covers every
 * code in CURRENCY_OPTIONS; anything else falls back to a neutral "unit". EUR → "euro"
 * keeps euro as the default voice (see the anonymous landing + logged-out surfaces).
 */
const CURRENCY_NOUNS: Record<string, string> = {
  EUR: 'euro',
  GBP: 'pound',
  USD: 'dollar',
  CHF: 'franc',
  CAD: 'dollar',
  AUD: 'dollar',
  NZD: 'dollar',
  JPY: 'yen',
  INR: 'rupee',
  SGD: 'dollar',
  HKD: 'dollar',
  SEK: 'krona',
  NOK: 'krone',
  DKK: 'krone',
  PLN: 'złoty',
  CZK: 'koruna',
  HUF: 'forint',
  RON: 'leu',
  ZAR: 'rand',
  BRL: 'real',
  MXN: 'peso',
  AED: 'dirham',
  SAR: 'riyal',
  TRY: 'lira',
}

/** The singular money-noun for a currency code (e.g. "USD" → "dollar"). Falls back to "unit". */
export function currencyNoun(currency: string | null | undefined): string {
  if (!currency) return 'unit'
  return CURRENCY_NOUNS[currency.trim().toUpperCase()] ?? 'unit'
}

// --- Browser-locale detection ------------------------------------------------
// A welcoming first guess for the sign-up form + the anonymous landing tagline:
// read the visitor's browser locale and pre-select their likely currency + number
// format. Always fully overridable, and EUR / euro-style stays the fallback so the
// front door still greets in euros when detection is unavailable or unrecognised.

/** The app's neutral fallbacks, shared by detection + the sign-up form + AuthContext. */
export const DEFAULT_CURRENCY_CODE = 'EUR'
export const DEFAULT_FORMAT_KEY: NumberFormatKey = 'comma-dot'

/** Region (ISO 3166 alpha-2) → the currency we offer for it. Unlisted regions fall back to EUR. */
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CH: 'CHF', LI: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
  JP: 'JPY', IN: 'INR', SG: 'SGD', HK: 'HKD', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', ZA: 'ZAR', BR: 'BRL', MX: 'MXN',
  AE: 'AED', SA: 'SAR', TR: 'TRY',
}

/** The visitor's region from their browser locale, or null when it can't be determined. */
function localeRegion(): string | null {
  if (typeof navigator === 'undefined' || !navigator.language) return null
  try {
    const region = new Intl.Locale(navigator.language).maximize().region
    if (region) return region.toUpperCase()
  } catch {
    // Fall through to a plain tag parse.
  }
  const parts = navigator.language.split('-')
  const tail = parts.length > 1 ? parts[parts.length - 1] : null
  return tail && /^[A-Za-z]{2}$/.test(tail) ? tail.toUpperCase() : null
}

/** Infer a number-format key from how the browser locale groups a sample number. */
function localeNumberFormat(region: string | null): NumberFormatKey {
  // Two regions have a distinctive grouping the separator alone doesn't reveal.
  if (region === 'IN') return 'lakh'
  if (region === 'CH' || region === 'LI') return 'apostrophe'
  if (typeof navigator === 'undefined' || !navigator.language) return DEFAULT_FORMAT_KEY
  try {
    const parts = new Intl.NumberFormat(navigator.language).formatToParts(1234567.8)
    const group = parts.find((p) => p.type === 'group')?.value ?? ','
    const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.'
    if (decimal === ',' && group === '.') return 'dot-comma'
    if (decimal === ',') return 'space-comma' // fr-style: space (or NBSP) grouping
    if (group === "'" || group === '’') return 'apostrophe'
    return 'comma-dot'
  } catch {
    return DEFAULT_FORMAT_KEY
  }
}

/**
 * Best-guess currency + number format from the visitor's browser locale, for
 * pre-filling the sign-up form and the logged-out tagline. SSR-safe (returns the
 * euro defaults when there's no `navigator`).
 */
export function detectLocaleDefaults(): { currency: string; numberFormat: NumberFormatKey } {
  const region = localeRegion()
  const currency = (region && REGION_CURRENCY[region]) || DEFAULT_CURRENCY_CODE
  return { currency, numberFormat: localeNumberFormat(region) }
}

// The active display locale. Defaults to en-GB — the design's canonical money
// format (€1,234.56: € prefix, comma grouping, dot decimal) — until the signed-in
// user's own preference is applied (see setMoneyFormat / AuthContext).
const DEFAULT_LOCALE = 'en-GB'
let activeLocale = DEFAULT_LOCALE

/**
 * Apply the user's chosen money format app-wide. Every subsequent formatMoney /
 * currencySymbol call renders with it. Call once after sign-in (and on logout to reset).
 */
export function setMoneyFormat(format: NumberFormatKey | string | null | undefined): void {
  activeLocale = FORMAT_LOCALES[(format ?? '') as NumberFormatKey] ?? DEFAULT_LOCALE
}

// Cache one formatter per (locale, currency) — constructing Intl.NumberFormat isn't free,
// and the locale can change when the user updates their preference.
const formatters = new Map<string, Intl.NumberFormat>()

function formatterFor(currency: string): Intl.NumberFormat {
  const key = `${activeLocale}:${currency}`
  let fmt = formatters.get(key)
  if (!fmt) {
    // No fixed fraction digits — each currency uses its own ISO minor-unit count:
    // 2 for EUR/USD/GBP, 0 for JPY ("¥1,234", not "¥1,234.00"), 3 for KWD/BHD.
    fmt = new Intl.NumberFormat(activeLocale, { style: 'currency', currency })
    formatters.set(key, fmt)
  }
  return fmt
}

/** Format integer minor units as a localized currency string (e.g. "1.100,00 €"). */
export function formatMoney(minor: Minor, currency: string): string {
  return formatterFor(currency).format(toAmount(minor))
}

// A plain grouped number (no currency symbol), for inline-editable amount fields
// that already render their own "€" prefix — e.g. "1,100.00" in en-GB.
const plainFormatters = new Map<string, Intl.NumberFormat>()

/** Format integer minor units as a grouped decimal with no currency symbol (e.g. "1,100.00"). */
export function formatPlain(minor: Minor): string {
  let fmt = plainFormatters.get(activeLocale)
  if (!fmt) {
    fmt = new Intl.NumberFormat(activeLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    plainFormatters.set(activeLocale, fmt)
  }
  return fmt.format(toAmount(minor))
}

/** An exchange rate as a grouped decimal in the active format, up to 6 places (e.g. "0.923456"). */
export function formatRate(rate: number): string {
  return new Intl.NumberFormat(activeLocale, { maximumFractionDigits: 6 }).format(rate)
}

/** The currency's symbol for the active locale (e.g. "EUR" -> "€", "GBP" -> "£"). */
export function currencySymbol(currency: string): string {
  const part = formatterFor(currency)
    .formatToParts(0)
    .find((p) => p.type === 'currency')
  return part?.value ?? currency
}

/** The active format's decimal separator (',' or '.'), derived from its locale. */
function activeDecimalSeparator(): string {
  try {
    const parts = new Intl.NumberFormat(activeLocale).formatToParts(12345.6)
    return parts.find((p) => p.type === 'decimal')?.value ?? '.'
  } catch {
    return '.'
  }
}

/**
 * True when `str` is a validly-grouped whole number using `sep` as the grouping
 * separator — Western triples ("1,234,567") or Indian lakh/crore grouping
 * ("12,34,567"). Used to decide whether a lone separator is grouping we can strip
 * or genuinely malformed input we must reject.
 */
function isGroupedInteger(str: string, sep: string): boolean {
  const s = sep === '.' ? '\\.' : sep
  const western = new RegExp(`^\\d{1,3}(?:${s}\\d{3})+$`)
  const lakh = new RegExp(`^\\d{1,2}(?:${s}\\d{2})+${s}\\d{3}$`)
  return western.test(str) || lakh.test(str)
}

/**
 * Parse a user-entered decimal string into integer minor units WITHOUT going
 * through floating point. Accepts '.' or ',' as the decimal separator, and
 * tolerates a thousands separator when the amount carries both — e.g. "2.500,00"
 * (de-DE) or "1,234.56" (en): the right-most separator is taken as the decimal
 * point and the other is stripped as grouping.
 *
 * When only ONE separator type is present, its role is resolved by the active
 * money format (see setMoneyFormat): the separator that equals the format's
 * decimal character is the decimal point; the other is a grouping separator and
 * is stripped. So under comma-dot "1,500" -> 1500 (grouping) while "1.50" -> 1.50
 * (decimal); under dot-comma the two swap. This makes parsing agree with
 * formatting instead of always assuming a lone separator is decimal (audit F14).
 *
 * Income figures are the largest in the budget, so this is where grouping
 * separators show up. Returns null for empty / negative / non-numeric input.
 * Anything beyond 4 dp is rounded half-up to scale 4.
 */
export function parseMinor(input: string): Minor | null {
  const expression = expressionTerms(input)
  if (expression !== null) {
    return evaluateExpression(expression)
  }
  return parseSingleMinor(input)
}

/** One plain amount (no arithmetic) as integer minor units; see parseMinor. */
function parseSingleMinor(input: string): Minor | null {
  const canonical = canonicalAmount(input)
  if (canonical === null) return null

  const [intPart, fracRaw = ''] = canonical.split('.')
  const frac4 = fracRaw.slice(0, 4).padEnd(4, '0')
  let minor = Number(intPart) * FACTOR + Number(frac4)
  // A pasted run of 305 or more digits overflows to Infinity; refuse it as any invalid amount
  // (review P3-5: inside an expression it threw out of parseMinor instead).
  if (!Number.isFinite(minor)) return null

  // Round half-up on a 5th fractional digit.
  const fifth = fracRaw.charAt(4)
  if (fifth !== '' && Number(fifth) >= 5) {
    minor += 1
  }

  return minor
}

/** What a money field says when a typed amount has more decimals than cents (D1). */
export const TOO_MANY_DECIMALS = 'Enter at most 2 decimal places.'

/**
 * True when the typed amount has more than 2 decimals that matter ("12.345", not "12.340") and
 * is not the amount the field opened with (`stored`). A typed amount is refused with
 * TOO_MANY_DECIMALS, never rounded without a word (D1, review CL-P3-7); an amount stored with
 * more decimals (a converted amount, a planned one the jar planner worked out) still saves
 * unchanged when the field is left as it opened (W10). The server refuses the same.
 */
export function tooPrecise(input: string, stored?: Minor | null): boolean {
  const terms = expressionTerms(input)
  if (terms !== null) {
    // An expression is always typed, never the amount a field opened with: any term with a third
    // decimal that matters is refused, whatever the result comes to (a product or quotient is
    // rounded to cents by the evaluator).
    return terms.some(({ term }) => tooPrecise(term))
  }
  const canonical = canonicalAmount(input)
  if (canonical === null) return false
  const decimals = (canonical.split('.')[1] ?? '').replace(/0+$/, '')
  return decimals.length > 2 && parseMinor(input) !== stored
}

/** One term of a typed expression and the operator in front of it ('+' for the first). */
export interface ExpressionTerm {
  op: '+' | '-' | '*' | '/'
  term: string
}

/** The operator characters an amount field accepts, with the keyboard and Unicode spellings of each. */
const OPERATOR_OF: Record<string, ExpressionTerm['op']> = { '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '÷': '/' }

/**
 * Arithmetic typed into an amount field ("20+30", "100-12.50", "3*19.99", "120/4"), split into
 * its terms, each with the operator in front of it. Null when the input is a single amount. The
 * keyboard operators and their Unicode forms (−, ×, ÷) are read alike; "x" is not an operator
 * (it would clash with nothing today, but a typed "x" is more often a slip). A term is whatever
 * sits between two operators; an empty term ("20+", "20**30") makes the whole input invalid,
 * which parseMinor then refuses, so a half-typed expression never saves as something else. A
 * leading "-" is a sign on the first term ("-5+10" comes to 5); a lone "-5" is refused as before.
 */
export function expressionTerms(input: string): ReadonlyArray<ExpressionTerm> | null {
  const trimmed = input.trim()
  if (!/[+\-−*×/÷]/.test(trimmed.slice(1))) return null
  const terms: ExpressionTerm[] = []
  let op: ExpressionTerm['op'] = '+'
  let term = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    const operator = OPERATOR_OF[ch]
    if (operator === undefined) {
      term += ch
      continue
    }
    if (i === 0) {
      // A sign on the first term; only "-" means anything there.
      if (operator !== '-') return [{ op: '+', term: '' }]
      op = '-'
      continue
    }
    terms.push({ op, term: term.trim() })
    op = operator
    term = ''
  }
  terms.push({ op, term: term.trim() })
  return terms
}

/**
 * A pasted date, which must never save as a number (PR #321 review P3-1, P3-7), anywhere in the
 * expression ("2026-03-10+0" is a date with a stray key, not 2013). Three whole-number parts
 * joined by the same "-" or "/" where one part is a four-digit year ("2026-03-10",
 * "10/03/2026") or every part is one or two digits ("10-03-26"): a genuine "2026-3-10" is not
 * an amount anyone types. Or a year 1900-2099 and a month 1-12 as a month key: year first with
 * "-" ("2026-10"), or month first with either ("10/2026", "10-2026"; the latter would otherwise
 * save as 0.01). A year-first slash ("2000/12") is a yearly bill split into months, which nobody
 * pastes as a date, so it parses (review P3-8); "1500/4" and "2000-50" are arithmetic.
 */
function looksLikeDate(terms: ReadonlyArray<ExpressionTerm>): boolean {
  const whole = (t: ExpressionTerm): boolean => /^\d{1,4}$/.test(t.term)
  const year = (t: ExpressionTerm): boolean => /^(19|20)\d\d$/.test(t.term)
  const month = (t: ExpressionTerm): boolean => /^(0?[1-9]|1[0-2])$/.test(t.term)
  for (let i = 0; i < terms.length - 1; i++) {
    if (i > 0 && terms[i].op !== '+') continue
    const joiner = terms[i + 1].op
    if (joiner !== '-' && joiner !== '/') continue
    const a = terms[i]
    const b = terms[i + 1]
    if (!whole(a) || !whole(b)) continue
    const c = terms[i + 2]
    if (c !== undefined && c.op === joiner && whole(c)) {
      const parts = [a, b, c].map((t) => t.term)
      if (parts.some((p) => p.length === 4) || parts.every((p) => p.length <= 2)) return true
    }
    if ((year(a) && month(b) && joiner === '-') || (month(a) && year(b))) return true
  }
  return false
}

/**
 * Works a typed expression out in integer minor units: "*" and "/" first, then "+" and "-",
 * left to right, like a calculator with precedence. Each step keeps the four decimals the
 * units carry (half-up), and only the result is rounded half-up to whole cents (D1: an amount
 * never carries more than two decimals, and 10/3 cannot be fixed by typing), so 10/3 is 3.33
 * and 10/3*3 is 10.00 as on a calculator (review P3-6). Refused (null): any term that is not
 * an amount, a division by zero, a result below zero (an amount is a magnitude; the
 * transaction's type says which way it goes), or a pasted date (looksLikeDate). A zero result
 * is 0, which the forms refuse where they must.
 */
function evaluateExpression(terms: ReadonlyArray<ExpressionTerm>): Minor | null {
  if (looksLikeDate(terms)) return null
  const factor = BigInt(FACTOR)
  const cent = BigInt(FACTOR / 100)
  const roundToCents = (value: bigint): bigint => {
    // Half-up on the magnitude, then back to the sign.
    const negative = value < 0n
    const magnitude = negative ? -value : value
    const rounded = ((magnitude + cent / 2n) / cent) * cent
    return negative ? -rounded : rounded
  }
  // First pass: multiply and divide into the running product; each product ends a group.
  const groups: bigint[] = []
  let current: bigint | null = null
  let sign = 1n
  for (const { op, term } of terms) {
    const minor = parseSingleMinor(term)
    if (minor === null) return null
    const value = BigInt(minor)
    if (op === '+' || op === '-') {
      if (current !== null) groups.push(sign * current)
      sign = op === '-' ? -1n : 1n
      current = value
      continue
    }
    if (current === null) return null
    if (op === '*') {
      current = (current * value + factor / 2n) / factor
    } else {
      if (value === 0n) return null
      current = (current * factor + value / 2n) / value
    }
  }
  if (current !== null) groups.push(sign * current)
  const total = roundToCents(groups.reduce((sum, g) => sum + g, 0n))
  if (total < 0n) return null
  return Number(total)
}

/** True when the typed text is arithmetic ("20+30", "3*19.99") rather than a single amount. */
export function isExpression(input: string): boolean {
  return expressionTerms(input) !== null
}

/** The typed amount as plain digits with a '.' decimal point ("1234.5"), or null when it isn't one. */
function canonicalAmount(input: string): string | null {
  // Strip unambiguous grouping separators first — spaces (fr-FR "1 234,56"),
  // apostrophes (de-CH "1'234.56", straight or curly). Neither is ever a decimal
  // separator, so removing them can't change the value; only ',' and '.' remain
  // ambiguous and are resolved below.
  let trimmed = input.trim().replace(/[\s'’]/g, '')

  const hasComma = trimmed.indexOf(',') !== -1
  const hasDot = trimmed.indexOf('.') !== -1
  if (hasComma && hasDot) {
    // Both present: the right-most is the decimal separator; strip the grouping one.
    const decimalSep = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.') ? ',' : '.'
    const groupSep = decimalSep === ',' ? '.' : ','
    trimmed = trimmed.split(groupSep).join('').replace(decimalSep, '.')
  } else if (hasComma || hasDot) {
    // A single separator type is present; the active format fixes its role.
    const sep = hasComma ? ',' : '.'
    if (sep === activeDecimalSeparator()) {
      // Decimal separator. Collapsing every occurrence to '.' keeps a genuinely
      // malformed "1.2.3" / "1,2,3" failing the strict check below.
      trimmed = trimmed.split(sep).join('.')
    } else if (isGroupedInteger(trimmed, sep)) {
      // Well-formed grouping for this format: strip it entirely (e.g. "1,500" -> 1500).
      // This is the case audit F14 fixes — previously "1,500" became 1.5.
      trimmed = trimmed.split(sep).join('')
    } else {
      // Not the format's decimal, and not valid grouping either (e.g. "12,50" under
      // comma-dot, where a 2-digit trailing group can't be grouping). The user typed
      // the sibling separator as a decimal point — a common habit — so read it as the
      // decimal. Collapsing every occurrence to '.' also keeps a genuinely malformed
      // "1,2,3" failing the strict check below.
      trimmed = trimmed.split(sep).join('.')
    }
  }
  // (No separator at all: `trimmed` is already the integer part.)

  if (trimmed === '' || !/^\d+(\.\d+)?$/.test(trimmed)) {
    return null
  }
  return trimmed
}
