import { afterEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InfoHint } from './InfoHint'
import { Modal } from './Modal'

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

  it('closes on Escape without closing the dialog it sits in; the next Escape closes the dialog', () => {
    const onClose = vi.fn()
    render(
      <Modal title="New jar" onClose={onClose}>
        <InfoHint label="What repeating means">Text</InfoHint>
      </Modal>,
    )
    const trigger = screen.getByRole('button', { name: 'What repeating means' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  describe('on a narrow screen', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      Reflect.deleteProperty(document.documentElement, 'clientWidth')
    })

    it('moves a popover that would run off the right edge back inside it, 8px from the edge', () => {
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 320, configurable: true })
      // Hung from an icon at 100px, the 256px popover would end at 356px on a 320px screen.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 356, top: 0, bottom: 0, width: 256, height: 0, x: 100, y: 0, toJSON: () => ({}) })
      render(<InfoHint label="Hint">Text</InfoHint>)
      fireEvent.focus(screen.getByRole('button', { name: 'Hint' }))
      expect(screen.getByRole('tooltip').parentElement).toHaveStyle({ marginLeft: '-44px' })
    })

    it('moves a popover hung from the icon\'s right edge that would run off the left edge back inside it', () => {
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 390, configurable: true })
      // Hung from an icon ending at 180px, the 256px popover would start at -76px.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: -76, right: 180, top: 0, bottom: 0, width: 256, height: 0, x: -76, y: 0, toJSON: () => ({}) })
      render(
        <InfoHint label="Hint" align="end">
          Text
        </InfoHint>,
      )
      fireEvent.focus(screen.getByRole('button', { name: 'Hint' }))
      const hanger = screen.getByRole('tooltip').parentElement!
      expect(hanger).toHaveClass('right-0')
      // A right-anchored box moves by its right margin: 84px to the right.
      expect(hanger).toHaveStyle({ marginRight: '-84px' })
      expect(hanger.style.marginLeft).toBe('')
    })

    it('leaves a popover that fits where it is', () => {
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 390, configurable: true })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 356, top: 0, bottom: 0, width: 256, height: 0, x: 100, y: 0, toJSON: () => ({}) })
      render(<InfoHint label="Hint">Text</InfoHint>)
      fireEvent.focus(screen.getByRole('button', { name: 'Hint' }))
      expect(screen.getByRole('tooltip').parentElement!.style.marginLeft).toBe('')
    })
  })
})
