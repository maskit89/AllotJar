import { screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { chooseFromMenu } from './rowMenu'

/*
 * The Import page's review list (restyle PR 14): one list card in the Transactions row style. A
 * row's rarely used actions (Split, Mark as transfer, Member, From jar…, Edit/Undo transfer, Edit/
 * Clear split) sit behind a ⋯ named "{payee} on {date}: more actions", and each item's accessible
 * name says which row it acts on (e.g. "Split AUTOMARKET on 2026-06-17"); the transfer, the split,
 * a row's member and its jar are edited in a sheet dialog; a row's line is a chip ("Assign …" /
 * "Reassign …") that opens the select; the explanations sit behind (i) hints.
 */

/** Picks `item` (its full accessible name) from the ⋯ menu of the review row named `row` ("{payee} on {date}"). */
export const rowAction = (user: UserEvent, row: string, item: string) => chooseFromMenu(user, `${row}: more actions`, item)

/** Opens the row's ⋯ menu and returns its items (the visible label and whether each is disabled), then closes it. */
export async function rowItems(user: UserEvent, row: string): Promise<{ name: string; disabled: boolean }[]> {
  await user.click(await screen.findByRole('button', { name: `${row}: more actions` }, { timeout: 5000 }))
  await screen.findByRole('menu', {}, { timeout: 5000 })
  const items = screen.getAllByRole('menuitem').map((el) => ({
    name: el.textContent ?? '',
    disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
  }))
  await user.keyboard('{Escape}')
  return items
}

/** The row's category chip: "Assign {row}" while it has no line, "Reassign {row}: {line}" once it has one. */
export const categoryChip = (row: string): HTMLElement =>
  screen.getByRole('button', { name: (n) => n === `Assign ${row}` || n.startsWith(`Reassign ${row}: `) })

/** Opens the row's category chip and picks `value` from the select it reveals (which closes again). */
export async function pickCategory(user: UserEvent, row: string, value: string): Promise<void> {
  await user.click(categoryChip(row))
  await user.selectOptions(screen.getByLabelText(`Category for ${row}`), value)
}

/** The review row (the <li>) holding this include checkbox. */
export const rowOf = (includeLabel: string): HTMLElement => screen.getByLabelText(includeLabel).closest('li') as HTMLElement

/** Opens the (i) hint named `label` (by hovering its trigger) and returns its popover. */
export async function openHint(user: UserEvent, label: string): Promise<HTMLElement> {
  await user.hover(screen.getByRole('button', { name: label }))
  return screen.findByRole('tooltip')
}

/** Closes the (i) hint named `label` (the pointer leaves its trigger). */
export const closeHint = (user: UserEvent, label: string) => user.unhover(screen.getByRole('button', { name: label }))

/** Closes the open sheet dialog by its Done button. */
export const done = (user: UserEvent) => user.click(screen.getByRole('button', { name: 'Done' }))

/** The "Already recorded?" radio group of the transfer dialog of the row named `row`. */
export const matchGroup = (row: string): HTMLElement => screen.getByLabelText(`Match recorded transfer for ${row}`)

/** The labels of the "Already recorded?" radios, in the server's order after "No — record it as a new transfer". */
export const matchOptions = (row: string): string[] =>
  within(matchGroup(row))
    .getAllByRole('radio')
    .map((radio) => radio.closest('label')?.textContent ?? '')

/** Chooses the recorded transfer whose label matches `label` (the empty string for "record it as a new transfer"). */
export async function chooseMatch(user: UserEvent, row: string, label: string | RegExp): Promise<void> {
  await user.click(within(matchGroup(row)).getByRole('radio', { name: label === '' ? 'No — record it as a new transfer' : label }))
}

/** Opens the credit's "Into jars" toggle under its amount (the jar fields start closed) and returns the fields' group. */
export async function openJars(user: UserEvent, includeLabel: string, accountName = 'HSBC Current'): Promise<HTMLElement> {
  const toggle = within(rowOf(includeLabel)).getByRole('button', { name: /into jars/i })
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle)
  return screen.getByRole('group', { name: `Put into jars in ${accountName}` })
}
