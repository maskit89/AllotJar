import type { JarAllocationRequest } from '../types'
import { fromAmount, parseMinor, toAmount, toEditString } from './money'

/** Parses the typed jar amounts into the request rows the API takes; empty and zero fields are left out. */
export function toJarAllocations(value: Record<string, string>): JarAllocationRequest[] {
  return Object.entries(value)
    .map(([jarId, text]) => ({ jarId, minor: text.trim() === '' ? 0 : parseMinor(text) }))
    .filter((r): r is { jarId: string; minor: number } => r.minor !== null && r.minor > 0)
    .map((r) => ({ jarId: r.jarId, amount: toAmount(r.minor) }))
}

/** The jar amounts summed, or null when a field doesn't parse. */
export function jarAllocationsTotal(value: Record<string, string>): number | null {
  let total = 0
  for (const text of Object.values(value)) {
    if (text.trim() === '') continue
    const minor = parseMinor(text)
    if (minor === null || minor < 0) return null
    total += minor
  }
  return toAmount(total)
}

/** Pre-fills the fields from stored request rows (an edit, or a re-prompt). */
export function fromJarAllocations(rows: JarAllocationRequest[]): Record<string, string> {
  const value: Record<string, string> = {}
  for (const row of rows) value[row.jarId] = toEditString(fromAmount(row.amount))
  return value
}

