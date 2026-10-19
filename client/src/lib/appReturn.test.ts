import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isMidEntry, useOnReturn } from './appReturn'

/** Hides or shows the page as a phone does when the app goes to the background and back. */
function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.body.innerHTML = ''
})

describe('useOnReturn: the page coming back on screen', () => {
  it('reports how long the page was hidden', () => {
    const onReturn = vi.fn()
    renderHook(() => useOnReturn(onReturn))

    setVisibility('hidden')
    vi.setSystemTime(Date.now() + 12 * 60_000)
    setVisibility('visible')

    expect(onReturn).toHaveBeenCalledTimes(1)
    expect(onReturn).toHaveBeenCalledWith(12 * 60_000)
  })

  it('reports nothing for a visible event that follows no hide', () => {
    const onReturn = vi.fn()
    renderHook(() => useOnReturn(onReturn))

    setVisibility('visible')

    expect(onReturn).not.toHaveBeenCalled()
  })

  it('calls the latest callback, and stops once unmounted', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = renderHook(({ cb }) => useOnReturn(cb), { initialProps: { cb: first } })
    rerender({ cb: second })

    setVisibility('hidden')
    setVisibility('visible')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    unmount()
    setVisibility('hidden')
    setVisibility('visible')
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('isMidEntry: someone part-way through entering something', () => {
  it('is false with nothing focused and no dialog', () => {
    document.body.innerHTML = '<main><p>Dashboard</p></main>'
    expect(isMidEntry()).toBe(false)
  })

  it('is true while a text field or an amount field has the focus', () => {
    document.body.innerHTML = '<input aria-label="Payee" /><input type="text" inputmode="decimal" aria-label="Amount" />'
    document.querySelector<HTMLInputElement>('[aria-label="Amount"]')!.focus()
    expect(isMidEntry()).toBe(true)
  })

  it('is true while a textarea or a select has the focus', () => {
    document.body.innerHTML = '<textarea aria-label="Note"></textarea><select aria-label="Account"><option>A</option></select>'
    document.querySelector('textarea')!.focus()
    expect(isMidEntry()).toBe(true)
    document.querySelector('select')!.focus()
    expect(isMidEntry()).toBe(true)
  })

  it('is false while only a checkbox or a button has the focus', () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Paid" /><button>Save</button>'
    document.querySelector<HTMLInputElement>('input')!.focus()
    expect(isMidEntry()).toBe(false)
    document.querySelector('button')!.focus()
    expect(isMidEntry()).toBe(false)
  })

  it('is true while a dialog or a confirmation is open', () => {
    document.body.innerHTML = '<div role="dialog" aria-label="Add a transaction"></div>'
    expect(isMidEntry()).toBe(true)
    document.body.innerHTML = '<div role="alertdialog" aria-label="Delete?"></div>'
    expect(isMidEntry()).toBe(true)
  })
})
