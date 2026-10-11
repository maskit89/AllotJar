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

/**
 * The Jars page's cards (restyle PR 4): a jar's actions sit behind a ⋯ named "{jar}: more actions",
 * whose note (the menu's description) says where the money is held, this month's plan and how the
 * last cycle ended. Picks `item` from the jar's ⋯ menu.
 */
export const jarAction = (user: UserEvent, jar: string, item: string) => chooseFromMenu(user, `${jar}: more actions`, item)

/** Opens a ⋯ menu and returns its note (the menu's accessible description), one line per entry. */
export async function menuNote(user: UserEvent, menuLabel: string): Promise<string[]> {
  await user.click(await screen.findByRole('button', { name: menuLabel }, { timeout: 5000 }))
  const menu = await screen.findByRole('menu', {}, { timeout: 5000 })
  const id = menu.getAttribute('aria-describedby')
  const note = id ? document.getElementById(id) : null
  const lines = note ? Array.from(note.querySelectorAll('span')).map((s) => s.textContent ?? '') : []
  await user.keyboard('{Escape}')
  return lines
}

/** Opens a jar's ⋯ menu and returns its note (the menu's accessible description), one line per entry. */
export const jarNote = (user: UserEvent, jar: string) => menuNote(user, `${jar}: more actions`)

/**
 * The Transactions list (restyle PR 5): a row's actions (Edit, Split, Mark as refund, the
 * transfer leg, Delete) sit behind a ⋯ named "{payee}: more actions" (the date when it has no
 * payee), and each item's accessible name says which row it acts on, e.g. "Edit transaction:
 * Tesco". Picks `item` (that full name) from the row's ⋯ menu.
 */
export const txAction = (user: UserEvent, row: string, item: string) => chooseFromMenu(user, `${row}: more actions`, item)

/** Opens a row's ⋯ menu and returns the accessible names of its items, in order. */
export async function txItems(user: UserEvent, row: string): Promise<string[]> {
  await user.click(await screen.findByRole('button', { name: `${row}: more actions` }, { timeout: 5000 }))
  await screen.findByRole('menu', {}, { timeout: 5000 })
  const names = screen.getAllByRole('menuitem').map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '')
  await user.keyboard('{Escape}')
  return names
}

/** Opens a row's ⋯ menu and returns its note (what the row's chips leave out), one line per entry. */
export const txNote = (user: UserEvent, row: string) => menuNote(user, `${row}: more actions`)

/** The list row (icon, payee, category, account, amount, ⋯) that shows `payee`. */
export function txRow(payee: string): HTMLElement {
  const rows = screen.getAllByTestId('tx-row').filter((r) =>
    Array.from(r.querySelectorAll('span, button')).some((el) => el.textContent === payee && el.children.length === 0),
  )
  if (rows.length !== 1) throw new Error(`Expected one row showing "${payee}", found ${rows.length}`)
  return rows[0]
}
