// Locale-aware date formatting.
//
// Dates follow the visitor's *browser* locale (navigator.language), independent of
// the money number-format preference — that preference is only about grouping and
// decimal style, whereas a US visitor writing "1,234.56" still expects "Jun 20"
// and a UK one expects "20 Jun". In Node/SSR or when the locale is unavailable we
// fall back to en-US, which matches the app's historical "Jun 20" rendering.

function dateLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
  return 'en-US'
}

// These values are calendar dates, not instants. Use UTC for both construction
// and formatting so cached formatters cannot shift the day if the timezone changes.
function fromIso(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(Date.UTC(y, m - 1, d))
}

// Intl.DateTimeFormat construction isn't free; cache one per (locale, style).
const shortFmt = new Map<string, Intl.DateTimeFormat>()
const fullFmt = new Map<string, Intl.DateTimeFormat>()
const monthYearFmt = new Map<string, Intl.DateTimeFormat>()

/**
 * Compact register date in the browser locale — "Jun 20" (en-US), "20 Jun" (en-GB),
 * "20. Juni" (de-DE). No year; that lives in the month picker at the top of the page.
 * Returns the raw input unchanged if it isn't a parseable ISO date.
 */
export function shortDate(iso: string): string {
  const d = fromIso(iso)
  if (!d) return iso
  const loc = dateLocale()
  let fmt = shortFmt.get(loc)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    shortFmt.set(loc, fmt)
  }
  return fmt.format(d)
}

/**
 * Full date including the year, in the browser locale (medium style) — e.g.
 * "20 Jun 2026" (en-GB) / "Jun 20, 2026" (en-US) / "20.06.2026" (de-DE). Used where
 * the year matters (e.g. imported statement rows that can straddle a year boundary).
 */
export function formatDate(iso: string): string {
  const d = fromIso(iso)
  if (!d) return iso
  const loc = dateLocale()
  let fmt = fullFmt.get(loc)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, { dateStyle: 'medium', timeZone: 'UTC' })
    fullFmt.set(loc, fmt)
  }
  return fmt.format(d)
}

/**
 * Month and year in the browser locale — "Nov 2026" (en), "Nov. 2026" (de). Used for
 * forward-looking projections ("full by Nov 2026") where the day would be false
 * precision. Returns the raw input unchanged if it isn't a parseable ISO date.
 */
export function monthYear(iso: string): string {
  const d = fromIso(iso)
  if (!d) return iso
  const loc = dateLocale()
  let fmt = monthYearFmt.get(loc)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    monthYearFmt.set(loc, fmt)
  }
  return fmt.format(d)
}

/**
 * Today's calendar date as an ISO `yyyy-MM-dd`, on the API's UTC basis (the server uses
 * DateOnly.FromDateTime(DateTime.UtcNow)). The default for "as of today" date inputs.
 */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * The current month on the same UTC basis as `todayIso` and the server (rule 82, P14: the
 * current month is the UTC month), so from midnight local time until midnight UTC a new month
 * is not shown as current while the server still counts the old one.
 */
export function currentMonth(now = new Date()): { year: number; month: number } {
  const [year, month] = todayIso(now).split('-').map(Number)
  return { year, month }
}

const dayFmt = new Map<string, { weekday: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>()

/**
 * A day header of the transaction list, in the browser locale: "Today", "Yesterday", else the
 * short weekday, a space and the date ("Tue 7 Oct" in en-GB, "Tue Oct 7" in en-US), with the year
 * when it is not this year's ("Tue 7 Oct 2025"). The weekday is joined with a plain space, not the
 * locale's own "Tue, 7 Oct" (whose comma also differs between browsers), as the mock-up writes it.
 * Today is on the same UTC basis as `todayIso`.
 */
export function dayHeading(iso: string, now = new Date()): string {
  const today = todayIso(now)
  if (iso === today) return 'Today'
  const yesterday = todayIso(new Date(now.getTime() - 86_400_000))
  if (iso === yesterday) return 'Yesterday'
  const d = fromIso(iso)
  if (!d) return iso
  const otherYear = iso.slice(0, 4) !== today.slice(0, 4)
  const loc = dateLocale()
  const key = `${loc}|${otherYear}`
  let fmt = dayFmt.get(key)
  if (!fmt) {
    fmt = {
      weekday: new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' }),
      date: new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', ...(otherYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }),
    }
    dayFmt.set(key, fmt)
  }
  return `${fmt.weekday.format(d)} ${fmt.date.format(d)}`
}

const monthHeadingFmt = new Map<string, Intl.DateTimeFormat>()

/**
 * A month header of an account's register, in the browser locale: the month's full name
 * ("October"), with the year when it is not this year's ("December 2025"). Today is on the same
 * UTC basis as `todayIso`. Returns the raw input unchanged if it isn't a parseable ISO date.
 */
export function monthHeading(iso: string, now = new Date()): string {
  const d = fromIso(iso)
  if (!d) return iso
  const otherYear = iso.slice(0, 4) !== todayIso(now).slice(0, 4)
  const loc = dateLocale()
  const key = `${loc}|${otherYear}`
  let fmt = monthHeadingFmt.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, { month: 'long', ...(otherYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    monthHeadingFmt.set(key, fmt)
  }
  return fmt.format(d)
}
