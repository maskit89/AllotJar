const DAY = 24 * 60 * 60 * 1000

/** When a device was last used, in the fewest words: Active today, yesterday, 3 days ago. */
export function lastActive(iso: string, now = Date.now()): string {
  // Rounded: a day across a clock change is 23 or 25 hours long.
  const days = Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / DAY)
  if (days <= 0) return 'Active today'
  if (days === 1) return 'Active yesterday'
  return `Active ${days} days ago`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
