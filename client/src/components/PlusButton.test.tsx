// The "+" beside an amount field (PR #321 review P2-1): on an iPhone the number pad has no plus
// key, so the button appends one and typing carries on after it.
import { describe, it, expect, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlusButton } from './PlusButton'
import { selectOnFocusProps } from '../lib/selectOnFocus'

function Field({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={ref} aria-label="Amount" {...selectOnFocusProps} value={value} onChange={(e) => setValue(e.target.value)} />
      <PlusButton value={value} onChange={setValue} inputRef={ref} label="Add to the amount" />
    </>
  )
}

describe('PlusButton', () => {
  it('appends a plus sign, focuses the field and puts the caret after it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<Field initial="20" />)
    await user.click(screen.getByRole('button', { name: 'Add to the amount' }))
    const input = screen.getByLabelText('Amount') as HTMLInputElement
    expect(input).toHaveValue('20+')
    expect(input).toHaveFocus()
    act(() => vi.runAllTimers())
    expect(input.selectionStart).toBe(3)
    await user.keyboard('30')
    expect(input).toHaveValue('20+30')
    vi.useRealTimers()
  })

  it('adds nothing to an empty field or after a plus already there', async () => {
    const user = userEvent.setup()
    render(<Field initial="" />)
    const button = screen.getByRole('button', { name: 'Add to the amount' })
    await user.click(button)
    expect(screen.getByLabelText('Amount')).toHaveValue('')
    await user.type(screen.getByLabelText('Amount'), '5+')
    await user.click(button)
    expect(screen.getByLabelText('Amount')).toHaveValue('5+')
  })
})
