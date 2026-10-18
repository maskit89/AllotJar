import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsentBanner } from './ConsentBanner'

// The analytics consent banner as a Notice (restyle PR 17): one line, two quiet buttons, pinned
// above the phone tab bar and within the content column, and the room it takes published as
// --consent-h for the Help page (the LandingPage catalog proves the accept / decline persistence).
describe('ConsentBanner', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--consent-h')
  })

  it('is one line in a named region with Decline and Accept, neither a primary button', async () => {
    const user = userEvent.setup()
    const onAccept = vi.fn()
    const onDecline = vi.fn()
    render(<ConsentBanner onAccept={onAccept} onDecline={onDecline} />)
    const region = screen.getByRole('region', { name: 'Analytics consent' })
    expect(region).toHaveTextContent('We use Google Analytics for anonymous usage only; change it under Help.')
    expect(region.textContent).not.toMatch(/never send/)
    const decline = within(region).getByRole('button', { name: 'Decline' })
    const accept = within(region).getByRole('button', { name: 'Accept' })
    // Both quiet: the page under the banner keeps its one green primary.
    for (const b of [decline, accept]) expect(b.className).not.toMatch(/bg-brand-600|bg-primary/)
    await user.click(accept)
    expect(onAccept).toHaveBeenCalledOnce()
    await user.click(decline)
    expect(onDecline).toHaveBeenCalledOnce()
  })

  it('sits above the tab bar and within the content column, and publishes its room as --consent-h', () => {
    // jsdom has no ResizeObserver: a stand-in records what the banner watches.
    const observed: { el: Element; opts?: ResizeObserverOptions }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(el: Element, opts?: ResizeObserverOptions) {
          observed.push({ el, opts })
        }
        disconnect() {}
        unobserve() {}
      },
    )
    const { unmount } = render(<ConsentBanner onAccept={() => {}} onDecline={() => {}} />)
    const region = screen.getByRole('region', { name: 'Analytics consent' })
    // Pinned to the foot of the screen, its padding clearing the tab bar (PhoneNav's --tabbar-h) on a
    // phone and the sidebar (--sidebar-w) from 900px; the wrapper lets touches through to the tab bar.
    expect(region).toHaveClass('fixed', 'bottom-0', 'pointer-events-none')
    expect(region.className).toMatch(/pb-\[max\(calc\(var\(--tabbar-h\)\+12px\)/)
    expect(region.className).toMatch(/min-\[900px\]:left-\[var\(--sidebar-w,0px\)\]/)
    expect(region.firstElementChild).toHaveClass('pointer-events-auto')
    // jsdom lays nothing out, so the height is 0px; the property is set while shown and removed after.
    expect(document.documentElement.style.getPropertyValue('--consent-h')).toBe('0px')
    // The room follows the wrapper's border box: its padding is the tab bar's room, which mounts
    // after the first measure (the content box alone would miss it).
    expect(observed).toEqual([{ el: region, opts: { box: 'border-box' } }])
    unmount()
    vi.unstubAllGlobals()
    expect(document.documentElement.style.getPropertyValue('--consent-h')).toBe('')
  })
})
