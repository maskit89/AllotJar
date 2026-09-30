import { describe, expect, it } from 'vitest'
import { appendSplitRow, blankSplitRow, patchSplitRow, removeSplitRowAt, startSplitRows } from './splitRows'

// The split-row drafts shared by the register editor, the add modal and the import review.
describe('splitRows', () => {
  it('starts a split with the parent line and member on the first slice, then an empty one', () => {
    expect(startSplitRows({ budgetItemId: 'i-food', memberId: 'm1' })).toEqual([
      { budgetItemId: 'i-food', amount: '', memberId: 'm1' },
      blankSplitRow(),
    ])
    expect(startSplitRows()).toEqual([blankSplitRow(), blankSplitRow()])
  })

  it('patches one slice, appends an empty one and keeps at least two on removal', () => {
    const rows = startSplitRows()
    expect(patchSplitRow(rows, 1, { amount: '12.50' })[1]).toEqual({ budgetItemId: '', amount: '12.50', memberId: '' })
    expect(patchSplitRow(rows, 1, { amount: '12.50' })[0]).toBe(rows[0])
    expect(appendSplitRow(rows)).toHaveLength(3)
    expect(removeSplitRowAt(rows, 0)).toBe(rows)
    expect(removeSplitRowAt(appendSplitRow(rows), 2)).toHaveLength(2)
  })
})
