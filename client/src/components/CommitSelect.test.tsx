import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommitSelect } from './CommitSelect'

// #350 P3-1: Chrome fires `change` on a closed select for each arrow key, so the revealed category
// pickers (Import, Transactions) closed on the first ArrowDown. CommitSelect lets the keyboard move
// through the options and commits on Enter, on blur or on a pointer choice, once.

function setup(initial = 'a') {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  render(
    <CommitSelect aria-label="Category" initial={initial} onCommit={onCommit} onCancel={onCancel}>
      <option value="a">A</option>
      <option value="b">B</option>
      <option value="c">C</option>
    </CommitSelect>,
  )
  return { select: screen.getByLabelText('Category') as HTMLSelectElement, onCommit, onCancel }
}

/** A closed select's arrow key as Chrome does it: the keydown, then a `change` to the next option. */
function arrow(select: HTMLSelectElement, key: 'ArrowDown' | 'ArrowUp', to: string) {
  fireEvent.keyDown(select, { key })
  fireEvent.change(select, { target: { value: to } })
}

describe('CommitSelect', () => {
  it('arrow keys move the choice without committing; Enter commits it, once', () => {
    const { select, onCommit } = setup()
    arrow(select, 'ArrowDown', 'b')
    arrow(select, 'ArrowDown', 'c')
    arrow(select, 'ArrowUp', 'b')
    expect(onCommit).not.toHaveBeenCalled()
    expect(select.value).toBe('b')
    fireEvent.keyDown(select, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('b', 'pick')
    // A second Enter, or the blur as the picker closes, does nothing more.
    fireEvent.keyDown(select, { key: 'Enter' })
    fireEvent.blur(select)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('type-ahead letters and Home / End only move the choice too', () => {
    const { select, onCommit } = setup()
    for (const key of ['c', 'Home', 'End', 'PageDown']) {
      fireEvent.keyDown(select, { key })
      fireEvent.change(select, { target: { value: 'c' } })
    }
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('leaving the select commits what it shows', () => {
    const { select, onCommit } = setup()
    arrow(select, 'ArrowDown', 'b')
    fireEvent.blur(select)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('b', 'blur')
  })

  it('a pointer choice commits at once, as before', async () => {
    const { select, onCommit } = setup()
    await userEvent.setup().selectOptions(select, 'c')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('c', 'pick')
  })

  it('a choice from the list opened with Space commits (the select sees no arrow key there)', () => {
    const { select, onCommit } = setup()
    fireEvent.keyDown(select, { key: ' ' })
    fireEvent.change(select, { target: { value: 'c' } })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('c', 'pick')
  })

  it('a click after arrowing commits the clicked choice', () => {
    const { select, onCommit } = setup()
    arrow(select, 'ArrowDown', 'b')
    fireEvent.mouseDown(select)
    fireEvent.change(select, { target: { value: 'c' } })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('c', 'pick')
  })

  it('Escape closes it with no commit, and nothing commits after', () => {
    const { select, onCommit, onCancel } = setup()
    arrow(select, 'ArrowDown', 'b')
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.blur(select)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
