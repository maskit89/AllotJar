import { screen, within } from '@testing-library/react'
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

/**
 * The Accounts page's cards (restyle PR 6): an account's actions (Edit, Make private / Share with
 * the household, Delete) sit behind a ⋯ named "{account}: more actions", and each item's
 * accessible name says which account it acts on, e.g. "Edit Everyday". Picks `item` (that full
 * name) from the account's ⋯ menu.
 */
export const accountAction = (user: UserEvent, account: string, item: string) =>
  chooseFromMenu(user, `${account}: more actions`, item)

/** Opens an account's ⋯ menu and returns its items' accessible names (and whether each is disabled). */
export async function accountItems(user: UserEvent, account: string): Promise<{ name: string; disabled: boolean }[]> {
  await user.click(await screen.findByRole('button', { name: `${account}: more actions` }, { timeout: 5000 }))
  await screen.findByRole('menu', {}, { timeout: 5000 })
  const items = screen.getAllByRole('menuitem').map((el) => ({
    name: el.getAttribute('aria-label') ?? el.textContent ?? '',
    disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
  }))
  await user.keyboard('{Escape}')
  return items
}

/** Opens an account's ⋯ menu and returns its note (type, opening, money in jars, who sees it), one line per entry. */
export const accountNote = (user: UserEvent, account: string) => menuNote(user, `${account}: more actions`)

/** The card (or, on a phone, the row) of the account named `name`. */
export const accountCard = (name: string): HTMLElement => screen.getByRole('article', { name })

/**
 * The People page's cards (restyle PR 8): a person's actions (This is me, Invite to sign in, Send
 * again, Edit, Archive) sit behind a ⋯ named "{name}: more actions", and each item's accessible
 * name says whom it acts on, e.g. "Edit Alex". Picks `item` (that full name) from the person's ⋯.
 */
export const personAction = (user: UserEvent, person: string, item: string) =>
  chooseFromMenu(user, `${person}: more actions`, item)

/** Opens a person's ⋯ menu and returns its items' accessible names, in order. */
export const personItems = async (user: UserEvent, person: string): Promise<string[]> =>
  (await accountItems(user, person)).map((i) => i.name)

/** Opens a person's ⋯ menu and returns its note (their sign-in, a link to release), one line per entry. */
export const personNote = (user: UserEvent, person: string) => menuNote(user, `${person}: more actions`)

/** The card of the person named `name`. */
export const personCard = (name: string): HTMLElement => screen.getByRole('article', { name })

/**
 * The People page's "Other sign-ins" rows: a sign-in's actions (Send again, Link to a person,
 * Remove) sit behind a ⋯ named "Sign-in {email}: more actions". Picks `item` (its full name).
 */
export const signInAction = (user: UserEvent, email: string, item: string) =>
  chooseFromMenu(user, `Sign-in ${email}: more actions`, item)

/** Opens a sign-in's ⋯ menu (on "Other sign-ins") and returns its items' accessible names, in order. */
export const signInItems = async (user: UserEvent, email: string): Promise<string[]> =>
  (await accountItems(user, `Sign-in ${email}`)).map((i) => i.name)

/** Deletes a row from its ⋯ menu: picks Delete, then confirms in the "Delete this transaction?" dialog. */
export async function txDelete(user: UserEvent, row: string) {
  await txAction(user, row, `Delete transaction: ${row}`)
  const dialog = await screen.findByRole('dialog', { name: 'Delete this transaction?' }, { timeout: 5000 })
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
}
