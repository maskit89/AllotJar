import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useProgressiveList } from './useProgressiveList'

// A stand-in for the browser's IntersectionObserver (jsdom has none): the test says when the
// sentinel is in view, and every observer still watching hears it.
let inView = false
const observers = new Set<{ fire: () => void }>()
class FakeObserver {
  private readonly entry: { fire: () => void }
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { fire: () => callback([{ isIntersecting: inView } as IntersectionObserverEntry], this as never) }
  }
  observe() {
    observers.add(this.entry)
    this.entry.fire()
  }
  disconnect() {
    observers.delete(this.entry)
  }
}

function List({ total, atLeast = 0, resetKey }: { total: number; atLeast?: number; resetKey?: string }) {
  const { shown, more, sentinelRef } = useProgressiveList(total, { atLeast, resetKey, first: 10, step: 20 })
  return (
    <div>
      <p>{shown} drawn</p>
      {more && <div ref={sentinelRef} data-testid="sentinel" />}
    </div>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  observers.clear()
  inView = false
})

describe('useProgressiveList', () => {
  it('draws every row where the browser cannot tell what is in view', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    render(<List total={500} />)
    expect(screen.getByText('500 drawn')).toBeInTheDocument()
    expect(screen.queryByTestId('sentinel')).not.toBeInTheDocument()
  })

  it('draws the first batch, then a batch more each time the end comes into view', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    render(<List total={45} />)
    expect(screen.getByText('10 drawn')).toBeInTheDocument()

    act(() => {
      inView = true
      observers.forEach((o) => o.fire())
    })
    // Still in view after each batch, so it keeps going to the end and the sentinel goes.
    expect(screen.getByText('45 drawn')).toBeInTheDocument()
    expect(screen.queryByTestId('sentinel')).not.toBeInTheDocument()
  })

  it('always draws the rows asked for, beyond the batch, and keeps them drawn after', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const { rerender } = render(<List total={2000} atLeast={1500} />)
    expect(screen.getByText('1500 drawn')).toBeInTheDocument()
    rerender(<List total={2000} atLeast={0} />)
    expect(screen.getByText('1500 drawn')).toBeInTheDocument()
  })

  it('starts again from the first batch for another list', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const { rerender } = render(<List total={100} resetKey="a" />)
    act(() => {
      inView = true
      observers.forEach((o) => o.fire())
    })
    expect(screen.getByText('100 drawn')).toBeInTheDocument()
    inView = false
    rerender(<List total={100} resetKey="b" />)
    expect(screen.getByText('10 drawn')).toBeInTheDocument()
  })

  it('draws every row for printing', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    render(<List total={100} />)
    act(() => {
      window.dispatchEvent(new Event('beforeprint'))
    })
    expect(screen.getByText('100 drawn')).toBeInTheDocument()
  })
})
