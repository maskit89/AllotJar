import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RowMenu, type RowAction } from './RowActions'

// RowMenu's `trigger`/`menuLabel` opt-in (the Allocation page's "+ Link account" chip, restyle
// PR 10). Left out, the ⋯ trigger the other pages use is unchanged.

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
