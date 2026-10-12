import { screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

// The Allocation page after its restyle (PR 10): the figures are a KPI row, the warnings and notes
// are short strips with their full sentence behind an (i), the steps are a list named "How {month}
// is allocated", and each person's savings is a row in the list "Savings by person".

const W = { timeout: 5000 }

/** The Steps card's list, named "How {month} is allocated": the page has its figures for that month. */
export const findSteps = (month: string) => screen.findByRole('list', { name: `How ${month} is allocated` }, W)

/** The Allocate button (named "Allocate {month}"; its visible word is "Allocate"). */
export const allocateButton = (month: string) => screen.getByRole('button', { name: `Allocate ${month}` })
export const findAllocateButton = (month: string) => screen.findByRole('button', { name: `Allocate ${month}` }, W)

/**
 * The text behind the (i) named `name` (it renders only while open): hovered as a pointer would,
 * read, then left so the next (i) opens alone. `scope` picks one (i) where two share a name (a
 * person's row and their line in the Allocate dialog).
 */
export async function hintText(user: UserEvent, name: string, scope: HTMLElement = document.body): Promise<string> {
  const button = within(scope).getByRole('button', { name })
  await user.hover(button)
  const text = (await screen.findByRole('tooltip', {}, W)).textContent ?? ''
  await user.unhover(button)
  return text
}

/** The strip (a warning or note) `id` (its `data-strip`), or null. */
export const strip = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-strip="${id}"]`)

/** A KPI tile's figure: "€5,000.00" → 5000, "-€500.00" → -500 (the tile is a group named by its label). */
export function tileValue(label: string): number {
  const group = screen.getByRole('group', { name: label })
  const value = group.querySelectorAll('p')[1]?.textContent ?? ''
  const neg = value.trim().startsWith('-')
  const n = parseFloat(value.replace(/[^\d.]/g, ''))
  return neg ? -n : n
}

/** A person's row in the Savings card. */
export function savingsRow(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Savings by person' })
  const rows = within(list)
    .getAllByRole('listitem')
    .filter((li) => within(li).queryByText(name, { exact: true }) !== null)
  if (rows.length !== 1) throw new Error(`Expected one Savings row for "${name}", found ${rows.length}`)
  return rows[0]
}

/** A step's row in the Steps card (its label, its amount or the people it goes to). */
export function stepRow(month: string, label: string): HTMLElement {
  const list = screen.getByRole('list', { name: `How ${month} is allocated` })
  const rows = within(list)
    .getAllByRole('listitem')
    .filter((li) => within(li).queryByText(label, { exact: true }) !== null)
  if (rows.length !== 1) throw new Error(`Expected one step row "${label}", found ${rows.length}`)
  return rows[0]
}

/** In the open Allocate dialog: tick "I’ve completed these transfers" and press Record transfers. */
export async function recordTransfers(user: UserEvent, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('checkbox', { name: 'I’ve completed these transfers' }))
  await user.click(within(dialog).getByRole('button', { name: 'Record transfers' }))
}

/** Opens the Allocate dialog for `month` and returns it. */
export async function openAllocate(user: UserEvent, month: string): Promise<HTMLElement> {
  await user.click(await findAllocateButton(month))
  return screen.findByRole('dialog', {}, W)
}
