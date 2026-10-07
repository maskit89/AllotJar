import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InfoHint } from './InfoHint'

describe('InfoHint', () => {
  it('opens its popover on focus, named by the trigger, and closes it on Escape', () => {
    render(<InfoHint label="What this means">Short explanation.</InfoHint>)
    const trigger = screen.getByRole('button', { name: 'What this means' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.focus(trigger)
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Short explanation.')
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('hangs the popover from the icon\'s left edge by default, and centres it under the icon when asked (an icon partway across a phone-width line)', () => {
    const { unmount } = render(<InfoHint label="Start">Text</InfoHint>)
    fireEvent.focus(screen.getByRole('button', { name: 'Start' }))
    expect(screen.getByRole('tooltip').parentElement).toHaveClass('left-0')
    unmount()

    render(
      <InfoHint label="Centre" align="center">
        Text
      </InfoHint>,
    )
    fireEvent.focus(screen.getByRole('button', { name: 'Centre' }))
    const hanger = screen.getByRole('tooltip').parentElement
    expect(hanger).toHaveClass('left-1/2', '-translate-x-1/2')
    expect(hanger).not.toHaveClass('left-0')
  })
})
