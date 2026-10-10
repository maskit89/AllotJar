import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

/**
 * The Dashboard's row menus (restyle PR 3): a line's or a group's rarely used actions sit behind a
 * ⋯ button named "{name}: more actions" / "{group} group: more actions". Opens the menu and picks
 * the item (the menu renders in a portal, so items are found on the screen, not in the row).
 */
export async function chooseFromMenu(user: UserEvent, menuLabel: string, item: string) {
  await user.click(await screen.findByRole('button', { name: menuLabel }, { timeout: 5000 }))
  await user.click(await screen.findByRole('menuitem', { name: item }, { timeout: 5000 }))
}

/** Picks `item` from the ⋯ menu of the line named `line`. */
export const lineAction = (user: UserEvent, line: string, item: string) => chooseFromMenu(user, `${line}: more actions`, item)

/** Picks `item` from the ⋯ menu of the group named `group`. */
export const groupAction = (user: UserEvent, group: string, item: string) =>
  chooseFromMenu(user, `${group} group: more actions`, item)

/** Opens a ⋯ menu and returns its items' names (and whether each is disabled). */
export async function menuItems(user: UserEvent, menuLabel: string) {
  await user.click(await screen.findByRole('button', { name: menuLabel }, { timeout: 5000 }))
  await screen.findByRole('menu', {}, { timeout: 5000 })
  return screen.getAllByRole('menuitem').map((el) => ({
    name: el.textContent ?? '',
    disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
  }))
}
