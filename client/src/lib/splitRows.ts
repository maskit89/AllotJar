import type { SplitRowDraft } from '../components/SplitLinesEditor'

// The split-row drafts every split surface edits (the register's inline editor, the add
// modal's split mode and the import review), so the three can't drift.

/** One empty slice, as every split surface starts a new line. */
export const blankSplitRow = (): SplitRowDraft => ({ budgetItemId: '', amount: '', memberId: '' })

/** A fresh split: the parent's line and member on the first slice (both blank for a new entry), then an empty one. */
export function startSplitRows(first: Partial<SplitRowDraft> = {}): SplitRowDraft[] {
  return [{ ...blankSplitRow(), ...first }, blankSplitRow()]
}

/** The rows with one slice changed. */
export function patchSplitRow(rows: SplitRowDraft[], index: number, patch: Partial<SplitRowDraft>): SplitRowDraft[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
}

/** The rows with one more empty slice. */
export function appendSplitRow(rows: SplitRowDraft[]): SplitRowDraft[] {
  return [...rows, blankSplitRow()]
}

/** The rows without one slice; a split keeps at least two. */
export function removeSplitRowAt(rows: SplitRowDraft[], index: number): SplitRowDraft[] {
  return rows.length > 2 ? rows.filter((_, i) => i !== index) : rows
}
