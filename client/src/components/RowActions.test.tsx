import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ActionSheet, RowMenu, type RowAction } from './RowActions'

// RowMenu's `trigger`/`menuLabel` opt-in (the Allocation page's "+ Link account" chip, restyle
// PR 10). Left out, the ⋯ trigger the other pages use is unchanged. RowAction's `note` opt-in (the
// Account settings page's Disconnect, restyle PR 12): a line under the item, in the menu and the
// sheet. Left out, the items are as before.

const actions = (onPick: (k: string) => void): RowAction[] => [
  { key: 'a', label: 'Alpha', icon: null, onSelect: () => onPick('a') },
  { key: 'b', label: 'Beta', ariaLabel: 'Beta — Savings', icon: null, onSelect: () => onPick('b') },
]

describe('RowMenu', () => {
  it('left as it is: the ⋯ button named by `label`, its menu labelled by that button', async () => {
    const user = userEvent.setup()
    render(<RowMenu label="Rent: more actions" actions={actions(() => {})} />)
    const trigger = screen.getByRole('button', { name: 'Rent: more actions' })
    expect(trigger).toHaveAttribute('data-row-trigger')
    expect(trigger.querySelector('svg')).not.toBeNull()
    await user.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id)
    expect(menu).toHaveAccessibleName('Rent: more actions')
  })

  it('with a trigger of its own: that button opens the menu, which takes `menuLabel` as its name', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(
      <RowMenu
        label="unused"
        menuLabel="Savings account for Robin"
        trigger={<button type="button" aria-label="Link account for Robin’s savings">+ Link account</button>}
        actions={actions(onPick)}
      />,
    )
    expect(screen.queryByRole('button', { name: 'unused' })).not.toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Link account for Robin’s savings' })
    expect(chip).toHaveTextContent('+ Link account')
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(chip)
    const menu = await screen.findByRole('menu', { name: 'Savings account for Robin' })
    expect(menu).not.toHaveAttribute('aria-labelledby')
    await user.click(within(menu).getByRole('menuitem', { name: 'Beta — Savings' }))
    expect(onPick).toHaveBeenCalledWith('b')
    await waitFor(() => expect(chip).toHaveFocus())
  })
})

const REASON = 'Google is your only way to sign in, so it can’t be disconnected yet. Set a password first.'

describe('RowAction.note', () => {
  it('left out: no line under any item, nothing describes the items or the menu', async () => {
    const user = userEvent.setup()
    render(<RowMenu label="Rent: more actions" actions={actions(() => {})} />)
    await user.click(screen.getByRole('button', { name: 'Rent: more actions' }))
    const menu = await screen.findByRole('menu')
    expect(menu).not.toHaveAttribute('aria-describedby')
    for (const item of within(menu).getAllByRole('menuitem')) expect(item).not.toHaveAttribute('aria-describedby')
    expect(menu.querySelector('p')).toBeNull()
  })

  it('in the ⋯ menu: a disabled item’s note sits under it and describes the item and the menu', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(
      <RowMenu
        label="Google: more actions"
        actions={[{ key: 'disconnect', label: 'Disconnect', icon: null, disabled: true, note: REASON, onSelect: onPick }]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Google: more actions' }))
    const menu = await screen.findByRole('menu')
    const item = within(menu).getByRole('menuitem', { name: 'Disconnect' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription(REASON)
    // The arrow keys skip a disabled item, so the menu itself carries the reason too.
    expect(menu).toHaveAccessibleDescription(REASON)
    const note = within(menu).getByText(REASON)
    expect(item.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(item)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('in the ⋯ menu: an enabled item’s note describes that item only', async () => {
    const user = userEvent.setup()
    render(
      <RowMenu
        label="Row: more actions"
        actions={[
          { key: 'a', label: 'Alpha', icon: null, note: 'What Alpha does.', onSelect: () => {} },
          { key: 'b', label: 'Beta', icon: null, onSelect: () => {} },
        ]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Row: more actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveAccessibleDescription('What Alpha does.')
    expect(within(menu).getByRole('menuitem', { name: 'Beta' })).not.toHaveAttribute('aria-describedby')
    expect(menu).not.toHaveAttribute('aria-describedby')
  })

  function Sheet({ list, onOpen }: { list: RowAction[]; onOpen?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false)
    return (
      <ActionSheet
        title="Google"
        actions={list}
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          onOpen?.(o)
        }}
      >
        <button type="button">Google: more actions</button>
      </ActionSheet>
    )
  }

  it('in the phone sheet: a disabled item with a note stays focusable (aria-disabled), says why, and does nothing', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<Sheet list={[{ key: 'disconnect', label: 'Disconnect', icon: null, disabled: true, note: REASON, onSelect: onPick }]} />)
    await user.click(screen.getByRole('button', { name: 'Google: more actions' }))
    const sheet = await screen.findByRole('dialog', { name: 'Google' })
    const item = within(sheet).getByRole('button', { name: 'Disconnect' })
    expect(item).not.toBeDisabled()
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription(REASON)
    await user.click(item)
    expect(onPick).not.toHaveBeenCalled()
    // Still open: a disabled item doesn't close the sheet.
    expect(screen.getByRole('dialog', { name: 'Google' })).toBeInTheDocument()
  })

  it('in the phone sheet, left out: a disabled item is disabled as before, with no line under it', async () => {
    const user = userEvent.setup()
    render(
      <Sheet
        list={[
          { key: 'a', label: 'Alpha', icon: null, disabled: true, onSelect: () => {} },
          { key: 'b', label: 'Beta', icon: null, onSelect: () => {} },
        ]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Google: more actions' }))
    const sheet = await screen.findByRole('dialog', { name: 'Google' })
    const alpha = within(sheet).getByRole('button', { name: 'Alpha' })
    expect(alpha).toBeDisabled()
    expect(alpha).not.toHaveAttribute('aria-disabled')
    expect(alpha).not.toHaveAttribute('aria-describedby')
    expect(within(sheet).getByRole('button', { name: 'Beta' })).not.toHaveAttribute('aria-describedby')
    expect(sheet.querySelector('p')).toBeNull()
  })
})
