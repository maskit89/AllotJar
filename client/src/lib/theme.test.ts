import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTheme } from './theme'

describe('useTheme', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.classList.remove('dark')
  })

  it('still switches both ways when the browser blocks site storage', () => {
    // Chrome and Firefox throw on localStorage when site data is blocked.
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const { result } = renderHook(() => useTheme())
    expect(result.current.mode).toBe('light')

    act(() => result.current.setMode('dark'))
    expect(result.current.mode).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')

    act(() => result.current.setMode('light'))
    expect(result.current.mode).toBe('light')
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
