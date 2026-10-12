import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

// Modal's `sheet` opt-in (the Allocation page's dialogs, restyle PR 10). Left out, the dialog the
// other pages use (Accounts, Import, People, Transactions, Move money) is unchanged.

function screenMatching(...queries: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('Modal', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('left as it is: the centred card, its ✕, focus on the first control, Escape closes', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Modal title="Add account" onClose={onClose}>
        <input aria-label="Name" />
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Add account' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.className).toContain('max-w-md')
    expect(dialog.className).not.toContain('sheet-dlg')
    expect(dialog.querySelector('.sheet-dlg-body')).toBeNull()
    expect(within(dialog).getByRole('heading', { name: 'Add account' }).className).toContain('text-base')
    // The ✕ is the first control, so it takes focus (as before).
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(within(dialog).queryByRole('button', { name: 'About this dialog' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sheet: named by its title with an (i) beside it, focus on the ✕ (not the (i)), the footer outside the scrolling middle', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Modal sheet title="Record July’s transfers" hint="What recording does." hintLabel="About recording" onClose={onClose} footer={<button type="button">Save</button>}>
        <p>Body</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Record July’s transfers' })
    expect(dialog.className).toContain('sheet-dlg')
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    const middle = dialog.querySelector('.sheet-dlg-body')!
    expect(middle).toHaveTextContent('Body')
    expect(middle.contains(screen.getByRole('button', { name: 'Save' }))).toBe(false)

    // The (i) opens on focus and Escape closes it alone; the next Escape closes the dialog.
    const about = within(dialog).getByRole('button', { name: 'About recording' })
    act(() => about.focus())
    expect(screen.getByRole('tooltip')).toHaveTextContent('What recording does.')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sheet on a phone: a grab handle is the one Close (no ✕), and it takes focus', async () => {
    screenMatching('(max-width: 699.98px)')
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Modal sheet title="Allocation settings" onClose={onClose}>
        <input aria-label="Pocket" />
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Allocation settings' })
    const close = within(dialog).getAllByRole('button', { name: 'Close' })
    expect(close).toHaveLength(1)
    expect(close[0]).toHaveFocus()
    expect(close[0].querySelector('svg')).toBeNull()
    await user.click(close[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
