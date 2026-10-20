import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { OperatorBar } from './OperatorBar'
import { typeIntoField } from '../lib/typeIntoField'

const TOUCH = '(hover: none) and (pointer: coarse)'

function stubMedia(touch: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: touch && query === TOUCH,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

/** A controlled amount field, as the app's forms have them, and a plain text field. */
function Form({ onValue }: { onValue?: (v: string) => void }) {
  const [amount, setAmount] = useState('20')
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label="Amount"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value)
          onValue?.(e.target.value)
        }}
      />
      <input type="text" aria-label="Payee" defaultValue="" />
      <OperatorBar />
    </>
  )
}

describe('OperatorBar', () => {
  afterEach(() => vi.unstubAllGlobals())

  describe('on a touch screen', () => {
    beforeEach(() => stubMedia(true))

    it('shows the four keys while an amount field has focus, and types at the caret', () => {
      const seen: string[] = []
      render(<Form onValue={(v) => seen.push(v)} />)
      expect(screen.queryByRole('toolbar', { name: 'Calculator keys' })).not.toBeInTheDocument()

      const amount = screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement
      act(() => amount.focus())
      const bar = screen.getByRole('toolbar', { name: 'Calculator keys' })
      expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['+', '−', '×', '÷'])

      // The whole value selected (as amount fields select on focus): the operator goes after it.
      amount.setSelectionRange(0, 2)
      fireEvent.click(screen.getByRole('button', { name: 'Plus' }))
      expect(amount.value).toBe('20+')
      expect(seen.at(-1)).toBe('20+')
      expect(document.activeElement).toBe(amount)

      // A caret in the middle: the operator goes there.
      amount.setSelectionRange(1, 1)
      fireEvent.click(screen.getByRole('button', { name: 'Times' }))
      expect(amount.value).toBe('2*0+')
    })

    it('keeps the field focused when a key is pressed', () => {
      render(<Form />)
      const amount = screen.getByRole('textbox', { name: 'Amount' })
      act(() => amount.focus())
      const key = screen.getByRole('button', { name: 'Minus' })
      // The press is cancelled so focus (and the phone's keyboard) stays on the field.
      expect(fireEvent.pointerDown(key)).toBe(false)
      expect(fireEvent.mouseDown(key)).toBe(false)
    })

    it('hides for other fields and when focus leaves', () => {
      render(<Form />)
      act(() => screen.getByRole('textbox', { name: 'Amount' }).focus())
      expect(screen.getByRole('toolbar')).toBeInTheDocument()
      act(() => screen.getByRole('textbox', { name: 'Payee' }).focus())
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
      act(() => screen.getByRole('textbox', { name: 'Amount' }).focus())
      act(() => (document.activeElement as HTMLElement).blur())
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    })
  })

  it('never shows on a computer', () => {
    stubMedia(false)
    render(<Form />)
    act(() => screen.getByRole('textbox', { name: 'Amount' }).focus())
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})

describe('typeIntoField', () => {
  it('replaces a partial selection', () => {
    const input = document.createElement('input')
    input.value = '12345'
    document.body.append(input)
    input.setSelectionRange(1, 3)
    typeIntoField(input, '/')
    expect(input.value).toBe('1/45')
    expect(input.selectionStart).toBe(2)
    input.remove()
  })
})
