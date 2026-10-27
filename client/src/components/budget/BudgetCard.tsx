import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  billStatus,
  categoryActual,
  categoryPlanned,
  effectiveDueDay,
  isIncome,
  isSavings,
  type CategoryVM,
  type ItemVM,
  type MonthVM,
} from '../../budgetModel'
import type { HouseholdMemberDto, JarDto } from '../../types'
import { formatMoney, fromAmount, sumMinor, type Minor } from '../../lib/money'
import { shortDate } from '../../lib/dates'
import { hueForIndex } from '../../lib/categoryColors'
import { useAuth } from '../../auth/AuthContext'
import { InfoHint } from '../InfoHint'
import { Button } from '../ui'
import { BudgetGroup } from './BudgetGroup'
import { BudgetLine, CarryLine } from './BudgetLine'
import { CARD_TITLE, DASH_CARD } from './card'

export interface BudgetCardProps {
  month: MonthVM
  today: Date
  phone: boolean
  savingItemId: string | null
  /** Shared households: who earns each income line. */
  isShared: boolean
  members: HouseholdMemberDto[]
  /** The household's jars as read for the month (null while loading or after a failed read). */
  jars: JarDto[] | null
  /** Every jar in the household's order, for each jar line's colour (as on the shelf). */
  jarOrder: JarDto[]
  /** A past month: jar plans are history (rule 46), and nothing in it can be skipped (rule 60). */
  isPastMonth: boolean
  /**
   * The money the month gives a job besides its income (CarryLine), shown first under Income:
   * what the months before left over (from a month), or money already in the accounts (a first
   * budget, from null). A null amount says why there is none yet (state); absent when there is
   * nothing to show.
   */
  carry?: { from: string | null; month: string; minor: Minor | null; state?: 'ahead' | 'loading' | 'failed' }
  onCommitItem: (itemId: string, plannedMinor: Minor) => void
  onSetItemMember: (itemId: string, memberId: string | null) => void
  onSetBill: (itemId: string, dueDay: number | null) => void
  onSetPaid: (itemId: string, isPaid: boolean) => void
  onRenameItem: (itemId: string, name: string) => void
  onAddItem: (categoryId: string, name: string) => void
  onDeleteItem: (itemId: string) => void
  onRestoreJarLine: (itemId: string) => void
  /** Rule 60: the skip-or-archive dialog for a jar line, with the choice the user made. */
  onRemoveJarLine: (item: ItemVM, intent: 'skip' | 'archive') => void
  onAddJar: (categoryId: string) => void
  onAddCategory: (name: string, asSavings: boolean) => void
  onRenameCategory: (categoryId: string, name: string) => void
  onDeleteCategory: (categoryId: string) => void
  onMoveCategory: (categoryId: string, direction: -1 | 1) => void
  onReorderItems: (categoryId: string, orderedItemIds: string[]) => void
}

/**
 * The Budget card (restyle PR 3): the whole month's plan in one card, one eyebrow group per
 * category: Income first, then the spending groups, then the Savings groups (the jars' monthly
 * contributions). "+ Group" in the header adds a group; the (i) beside the title rolls the
 * month up (spent of planned, what went into the jars).
 */
export function BudgetCard(props: BudgetCardProps) {
  const { month, today, phone, savingItemId, isShared, members, jars, jarOrder, isPastMonth } = props
  const { canWrite } = useAuth()
  const [addingGroup, setAddingGroup] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIsSavings, setNewIsSavings] = useState(false)
  // The header holds the "+ Group" button, where focus goes back when the new-group row closes.
  const header = useRef<HTMLDivElement>(null)
  const backToAddGroup = () => header.current?.querySelector<HTMLElement>('[data-add-group]')?.focus()
  const currency = month.currency
  const money = (minor: Minor) => formatMoney(minor, currency)

  const income = month.categories.filter(isIncome)
  const expense = month.categories.filter((c) => c.kind === 'expense')
  const savings = month.categories.filter(isSavings)

  // Rule 14: each jar line reads what went into its jar this month from the jar itself. A jar
  // missing from the read shows only its plan, and so does its group's total: a total that
  // counted the missing jar as 0 would read as complete.
  const jarOf = (item: ItemVM) => (jars ? (jars.find((j) => j.id === item.savingsId) ?? null) : null)
  const contributedIn = (c: CategoryVM): Minor | null => {
    if (!jars) return null
    let sum = 0
    for (const i of c.items) {
      if (!i.savingsId) continue
      const jar = jarOf(i)
      if (!jar) return null
      sum += fromAmount(jar.contributedThisMonth)
    }
    return sum
  }

  // The roll-up behind the title's (i).
  const spent = sumMinor(expense.map(categoryActual))
  const spendPlanned = sumMinor(expense.map(categoryPlanned))
  const jarsPlanned = sumMinor(savings.map(categoryPlanned))
  const jarsIn = savings.reduce<Minor | null>((s, c) => {
    const v = contributedIn(c)
    return s === null || v === null ? null : s + v
  }, 0)

  function submitNewGroup() {
    const trimmed = newName.trim()
    if (trimmed === '') return
    props.onAddCategory(trimmed, newIsSavings)
    setNewName('')
    setAddingGroup(false)
    backToAddGroup()
  }
  function cancelNewGroup() {
    setNewName('')
    setAddingGroup(false)
    backToAddGroup()
  }

  function moveItem(category: CategoryVM, itemId: string, direction: -1 | 1) {
    const idx = category.items.findIndex((i) => i.id === itemId)
    const swap = idx + direction
    if (idx < 0 || swap < 0 || swap >= category.items.length) return
    const reordered = [...category.items]
    ;[reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]]
    props.onReorderItems(category.id, reordered.map((i) => i.id))
  }

  const dueDateOf = (item: ItemVM) => {
    const day = effectiveDueDay(item.dueDay, month.year, month.month)
    return day === null ? null : shortDate(`${month.year}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }

  return (
    <section aria-labelledby="budget-heading" className={`@container ${DASH_CARD}`}>
      <div ref={header} className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 id="budget-heading" className={CARD_TITLE}>
            Budget
          </h2>
          {(expense.length > 0 || savings.length > 0) && (
            <InfoHint
              label="About this month’s budget"
              buttonClassName="relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
            >
              {expense.length > 0 && (
                <span className="block tabular-nums">
                  Spending: {money(spent)} spent of {money(spendPlanned)} planned.
                </span>
              )}
              {savings.length > 0 && (
                <span className="block tabular-nums">
                  Jars: {jarsIn === null ? `${money(jarsPlanned)} planned` : `${money(jarsIn)} in of ${money(jarsPlanned)} planned`} this
                  month.
                </span>
              )}
            </InfoHint>
          )}
        </div>
        {canWrite && (
          <Button
            data-add-group=""
            variant="secondary"
            size="sm"
            aria-label="Add a group"
            aria-expanded={addingGroup}
            onClick={() => setAddingGroup(true)}
            className="h-8 border-slate-200 px-3 text-[13px] shadow-[var(--shadow-frame)] [@media(hover:none)]:h-10"
          >
            <Plus aria-hidden className="size-4" />
            Group
          </Button>
        )}
      </div>

      {/* Income first: the pool every other group gives a job to. */}
      {income.map((category, gi) => (
        <BudgetGroup
          key={category.id}
          kind="income"
          category={category}
          phone={phone}
          onAddItem={props.onAddItem}
        >
          {gi === 0 && props.carry && (
            <CarryLine {...props.carry} currency={currency} phone={phone} />
          )}
          {category.items.map((item) => (
            <BudgetLine
              key={item.id}
              kind="income"
              item={item}
              currency={currency}
              saving={savingItemId === item.id}
              phone={phone}
              hue="emerald"
              members={members}
              showMember={isShared}
              onSetMember={props.onSetItemMember}
              onRename={props.onRenameItem}
              onCommit={props.onCommitItem}
              onDelete={props.onDeleteItem}
            />
          ))}
        </BudgetGroup>
      ))}

      {expense.map((category, gi, arr) => {
        const hue = hueForIndex(gi)
        return (
          <BudgetGroup
            key={category.id}
            kind="expense"
            category={category}
            phone={phone}
            total={
              <>
                <span className="sr-only">{money(categoryActual(category))} spent of </span>
                {money(categoryPlanned(category))}
              </>
            }
            onAddItem={props.onAddItem}
            onRename={props.onRenameCategory}
            onDelete={props.onDeleteCategory}
            onMove={props.onMoveCategory}
            isFirst={gi === 0}
            isLast={gi === arr.length - 1}
          >
            {category.items.map((item, i, items) => (
              <BudgetLine
                key={item.id}
                kind="expense"
                item={item}
                currency={currency}
                saving={savingItemId === item.id}
                phone={phone}
                hue={hue}
                billStatus={billStatus(item, month.year, month.month, today)}
                dueDate={dueDateOf(item)}
                onCommit={props.onCommitItem}
                onSetBill={props.onSetBill}
                onSetPaid={props.onSetPaid}
                onRename={props.onRenameItem}
                onDelete={props.onDeleteItem}
                onMove={(id, dir) => moveItem(category, id, dir)}
                isFirst={i === 0}
                isLast={i === items.length - 1}
              />
            ))}
          </BudgetGroup>
        )
      })}

      {/* Jars last: each line is a jar's contribution this month; balances roll over. */}
      {savings.map((category) => {
        // Rule 60: a jar's line leaves a month only by skipping it or archiving the jar, so a
        // group that still holds one cannot be deleted either (the server refuses it too).
        const holdsJarLines = category.items.some((i) => i.savingsId)
        const contributed = contributedIn(category)
        return (
          <BudgetGroup
            key={category.id}
            kind="savings"
            category={category}
            phone={phone}
            total={
              <>
                {contributed !== null && <span className="sr-only">{money(contributed)} in of </span>}
                {money(categoryPlanned(category))}
              </>
            }
            // A group still being saved has a temporary id: its Add jar waits for the real one.
            onAddJar={category.id.startsWith('temp-') ? undefined : props.onAddJar}
            onRename={props.onRenameCategory}
            onDelete={holdsJarLines ? undefined : props.onDeleteCategory}
          >
            {category.items.map((item, i) => {
              const order = jarOrder.findIndex((j) => j.id === item.savingsId)
              return (
                <BudgetLine
                  key={item.id}
                  kind="jar"
                  item={item}
                  currency={currency}
                  saving={savingItemId === item.id}
                  phone={phone}
                  hue={hueForIndex(order >= 0 ? order : i)}
                  jar={jarOf(item)}
                  onCommit={isPastMonth ? undefined : props.onCommitItem}
                  onRename={props.onRenameItem}
                  onSkip={isPastMonth ? undefined : (it) => props.onRemoveJarLine(it, 'skip')}
                  onArchive={isPastMonth ? undefined : (it) => props.onRemoveJarLine(it, 'archive')}
                  onRestore={isPastMonth ? undefined : props.onRestoreJarLine}
                />
              )
            })}
          </BudgetGroup>
        )
      })}

      {/* A new spending or savings group, at the end of the card. */}
      {canWrite && addingGroup && (
        <div data-entry className="mt-[22px] flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <input
            type="text"
            autoFocus
            value={newName}
            placeholder={newIsSavings ? 'Savings group, e.g. Travel' : 'Group name, e.g. Subscriptions'}
            aria-label="New category group name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault() // focus goes back to "+ Group": the Enter must not press it too
                submitNewGroup()
              }
              if (e.key === 'Escape') cancelNewGroup()
            }}
            className="h-9 min-w-[12rem] flex-1 rounded-lg border border-input bg-surface px-3 text-sm text-slate-800 placeholder:text-slate-500 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
          />
          <select
            value={newIsSavings ? 'savings' : 'expense'}
            aria-label="New group kind"
            onChange={(e) => setNewIsSavings(e.target.value === 'savings')}
            className="h-9 rounded-lg border border-input bg-surface px-2 text-sm text-slate-700 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
          >
            <option value="expense">Expense</option>
            <option value="savings">Savings</option>
          </select>
          <Button variant="secondary" size="sm" onClick={submitNewGroup} aria-label="Add category group" className="h-9">
            Add
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelNewGroup} aria-label="Cancel adding group" className="h-9">
            Cancel
          </Button>
        </div>
      )}
    </section>
  )
}
