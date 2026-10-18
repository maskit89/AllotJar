import { useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type SelectHTMLAttributes } from 'react'

/**
 * A revealed native <select> that commits once, on Enter, on blur or on a pointer choice, never on
 * an arrow key (#350 P3-1, the Import and Transactions category pickers). Chrome and Edge fire
 * `change` on a closed select for every ArrowDown / ArrowUp (and Home, End, Page keys and type-ahead
 * letters), so a select that closed on `change` gave a keyboard user one step per opening. Here those
 * keys only move the choice (`value` follows them), and Enter or leaving the select commits it;
 * Escape closes it without a change. A choice from the open list (a click, a tap, or Enter in the
 * open list, where the select itself sees no key) commits at once, as before.
 *
 * `onCommit(value)` runs at most once per opening, whichever way it closes: a second Enter, or the
 * blur that follows a commit as the select unmounts, is ignored. `onCommit` with the opening value
 * means "closed with no change".
 */
function useCommitSelect({
  initial,
  onCommit,
  onCancel,
}: {
  /** The value the select opens with. */
  initial: string
  /** The chosen value, and how: 'pick' (Enter or a pointer choice) or 'blur' (focus went elsewhere). */
  onCommit: (value: string, how: 'pick' | 'blur') => void
  /** Escape: closed with no change. */
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  // The last key moved the choice: the `change` it fires is not a commit.
  const keyMove = useRef(false)
  // This opening has already committed or cancelled.
  const done = useRef(false)

  const finish = (fn: () => void) => {
    if (done.current) return
    done.current = true
    fn()
  }

  return {
    value,
    onKeyDown(e: KeyboardEvent<HTMLSelectElement>) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(onCancel)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(() => onCommit(e.currentTarget.value, 'pick'))
        return
      }
      // Space and Alt+Arrow open the list (a choice there commits); every other key that a closed
      // select acts on only moves the choice.
      keyMove.current = e.key !== ' ' && e.key !== 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey
    },
    onMouseDown() {
      keyMove.current = false
    },
    onChange(e: ChangeEvent<HTMLSelectElement>) {
      const next = e.target.value
      setValue(next)
      if (keyMove.current) {
        keyMove.current = false
        return
      }
      finish(() => onCommit(next, 'pick'))
    },
    onBlur(e: FocusEvent<HTMLSelectElement>) {
      finish(() => onCommit(e.currentTarget.value, 'blur'))
    },
  }
}

/**
 * The revealed select itself (see useCommitSelect): mounted when the picker opens, so each opening
 * starts from `initial` and commits at most once. Every other select prop passes through.
 */
export function CommitSelect({
  initial,
  onCommit,
  onCancel,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'onMouseDown'> & {
  initial: string
  onCommit: (value: string, how: 'pick' | 'blur') => void
  onCancel: () => void
}) {
  const props = useCommitSelect({ initial, onCommit, onCancel })
  return (
    <select {...rest} {...props}>
      {children}
    </select>
  )
}
