import type { FocusEvent, MouseEvent } from 'react'

// Chrome/Safari fire the focusing click's mouseup AFTER focus and collapse the
// selection to a caret, so onFocus + select() alone doesn't survive a click.
// The guard swallows only that first mouseup; later clicks inside an
// already-focused field place the caret normally. Only one focus gesture is in
// flight per document at a time, so a module-scoped flag is safe to share.
// Known micro-wart: after keyboard (Tab) focus, the next click keeps the
// selection instead of placing the caret once — harmless and self-healing.
let pendingSelect = false

/**
 * Spread onto a numeric `<input>`/`<Input>` so focusing selects the current
 * value and typing replaces it (prevents "0" becoming "050"/"500").
 * Not for free-text fields — replacing a payee or name on a stray keypress
 * would be destructive, and Tab-focus already selects text inputs natively.
 */
export const selectOnFocusProps = {
  onFocus(e: FocusEvent<HTMLInputElement>) {
    pendingSelect = true
    e.currentTarget.select()
  },
  onMouseUp(e: MouseEvent<HTMLInputElement>) {
    if (pendingSelect) {
      pendingSelect = false
      e.preventDefault()
    }
  },
}
