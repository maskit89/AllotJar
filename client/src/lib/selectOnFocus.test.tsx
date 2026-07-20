import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { selectOnFocusProps } from './selectOnFocus'

// UX-055: focusing a numeric input selects its value so typing replaces it
// (prevents "0" turning into "050"/"500").
describe('selectOnFocusProps', () => {
  it('selects the whole value on focus', () => {
    render(<input type="text" inputMode="decimal" aria-label="Amount" defaultValue="0" {...selectOnFocusProps} />)
    const input = screen.getByLabelText('Amount') as HTMLInputElement

    fireEvent.focus(input)

    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(1)
  })

  it('swallows only the mouseup that belongs to the focusing click', () => {
    render(<input type="text" inputMode="decimal" aria-label="Amount" defaultValue="0" {...selectOnFocusProps} />)
    const input = screen.getByLabelText('Amount') as HTMLInputElement

    fireEvent.focus(input)
    // fireEvent returns false when preventDefault was called.
    expect(fireEvent.mouseUp(input)).toBe(false)
    // A later click inside the already-focused field places the caret normally.
    expect(fireEvent.mouseUp(input)).toBe(true)
  })

  it('typing after a click replaces the previous value instead of appending', async () => {
    const user = userEvent.setup()
    render(<input type="text" inputMode="decimal" aria-label="Amount" defaultValue="0" {...selectOnFocusProps} />)
    const input = screen.getByLabelText('Amount') as HTMLInputElement

    await user.type(input, '50')

    expect(input).toHaveValue('50')
  })
})
