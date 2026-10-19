import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CategoryVM } from '../../budgetModel'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../ui'
import { InfoHint } from '../InfoHint'
import { RowMenu, type RowAction } from '../RowActions'
import { AutoWidthInput } from './BudgetLine'

export type GroupKind = 'income' | 'expense' | 'savings'

/** The small uppercase group label (SPEC `.eyebrow`). */
export const EYEBROW = 'text-xs font-[650] tracking-[0.05em] text-slate-500 uppercase'

export interface BudgetGroupProps {
  kind: GroupKind
  category: CategoryVM
  /** Phone layout: the group ⋯ always shows (no hover there). */
  phone: boolean
  /** The header's total (none for Income: the Income KPI shows it). */
  total?: ReactNode
  /** The lines (BudgetLine rows). */
  children?: ReactNode
  /** Income and spending groups: add a line (or an income source) by name. */
  onAddItem?: (categoryId: string, name: string) => void
  /** Savings groups: open the jar form for this group. Left out while the group is still saving. */
  onAddJar?: (categoryId: string) => void
  onRename?: (categoryId: string, name: string) => void
  /** Left out when the group can't be deleted (Income; a Savings group that holds a jar's line). */
  onDelete?: (categoryId: string) => void
  /** Spending groups: move among the spending groups. */
  onMove?: (categoryId: string, direction: -1 | 1) => void
  isFirst?: boolean
  isLast?: boolean
}

/**
 * One group of the Budget card (restyle PR 3): an eyebrow header (the name, its total and a ⋯
 * with the group's actions), then its lines, a quiet empty row and the add row the ⋯ opens.
 *
 * The group's name stays an inline input for Admin+ (Enter or blur commits, Escape reverts), drawn
 * as the eyebrow; the ⋯ holds Add line / Add income source / Add jar, Rename, Move up and down
 * (spending groups) and Delete, which asks once more in the header.
 */
export function BudgetGroup({
  kind,
  category,
  phone,
  total,
  children,
  onAddItem,
  onAddJar,
  onRename,
  onDelete,
  onMove,
  isFirst = false,
  isLast = false,
}: BudgetGroupProps) {
  // Group structure needs Admin+; the lines gate themselves.
  const { canWrite } = useAuth()
  const [name, setName] = useState(category.name)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [nameInput, setNameInput] = useState<HTMLInputElement | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  // When the add row or the delete confirmation closes by a key or a button, focus goes back to
  // the group's ⋯ (where they were opened), not to the page.
  const refocus = useRef(false)
  // A rename picked from the ⋯ edits the name in place; Enter or Escape gives focus back to the
  // ⋯. Escape drops the edit, so the blur it causes must not save it.
  const [renameFromMenu, setRenameFromMenu] = useState(false)
  const skipCommit = useRef(false)

  useEffect(() => setName(category.name), [category.name])
  useEffect(() => {
    if (!refocus.current || adding || confirmingDelete) return
    refocus.current = false
    headRef.current?.querySelector<HTMLElement>('[data-row-trigger]')?.focus()
  }, [adding, confirmingDelete])

  function commitName() {
    if (!onRename) return
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(category.name)
      return
    }
    if (trimmed !== category.name) onRename(category.id, trimmed)
  }

  function submitNew() {
    const trimmed = newName.trim()
    if (trimmed === '' || !onAddItem) return
    onAddItem(category.id, trimmed)
    setNewName('')
    refocus.current = true
    setAdding(false)
  }

  function cancelAdd() {
    setNewName('')
    refocus.current = true
    setAdding(false)
  }

  function cancelDelete() {
    refocus.current = true
    setConfirmingDelete(false)
  }

  const income = kind === 'income'
  const addLabel = income ? 'Add income source' : 'Add line'

  const actions: RowAction[] = []
  if (canWrite) {
    if (onAddItem) actions.push({ key: 'add', label: addLabel, icon: <Plus aria-hidden />, after: 'focus', onSelect: () => setAdding(true) })
    if (kind === 'savings' && onAddJar) {
      actions.push({ key: 'jar', label: 'Add jar', icon: <Plus aria-hidden />, after: 'dialog', onSelect: () => onAddJar(category.id) })
    }
    if (onRename) {
      actions.push({
        key: 'rename',
        label: 'Rename',
        icon: <Pencil aria-hidden />,
        after: 'focus',
        onSelect: () => {
          setRenameFromMenu(true)
          nameInput?.focus()
          nameInput?.select()
        },
      })
    }
    if (onMove) {
      actions.push({ key: 'up', label: 'Move up', icon: <ArrowUp aria-hidden />, disabled: isFirst, onSelect: () => onMove(category.id, -1) })
      actions.push({ key: 'down', label: 'Move down', icon: <ArrowDown aria-hidden />, disabled: isLast, onSelect: () => onMove(category.id, 1) })
    }
    if (onDelete) {
      actions.push({
        key: 'delete',
        label: 'Delete',
        icon: <Trash2 aria-hidden />,
        danger: true,
        separatorBefore: actions.length > 0,
        after: 'focus',
        onSelect: () => setConfirmingDelete(true),
      })
    }
  }

  const empty = category.items.length === 0
  const renamable = canWrite && !!onRename

  // The quiet way in from an empty group (the ⋯ holds the same).
  let emptyAdd: ReactNode = null
  if (canWrite && empty && !adding) {
    if (kind === 'savings' && onAddJar) {
      emptyAdd = (
        <QuietAdd label={`Add a jar to ${category.name}`} onClick={() => onAddJar(category.id)}>
          Add a jar
        </QuietAdd>
      )
    } else if (onAddItem) {
      emptyAdd = (
        <QuietAdd label={income ? 'Add income source' : `Add a line to ${category.name}`} onClick={() => setAdding(true)}>
          {income ? 'Add income source' : 'Add a line'}
        </QuietAdd>
      )
    }
  }

  return (
    <div className="not-first:mt-[22px]">
      <div ref={headRef} className="group/gh flex min-h-8 items-center gap-3 border-b border-line pb-1 @min-[500px]:gap-3.5">
        <h3 className={`min-w-0 flex-1 ${EYEBROW}`}>
          {renamable ? (
            <AutoWidthInput
              inputRef={setNameInput}
              value={name}
              aria-label={`Rename group ${category.name}`}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setRenameFromMenu(false)
                if (skipCommit.current) skipCommit.current = false
                else commitName()
              }}
              onKeyDown={(e) => {
                const trigger = renameFromMenu
                  ? headRef.current?.querySelector<HTMLElement>('[data-row-trigger]')
                  : null
                if (e.key === 'Enter') {
                  // No keypress after this keydown: it would press the ⋯ (focused by then).
                  if (trigger) e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                  trigger?.focus()
                }
                if (e.key === 'Escape') {
                  setName(category.name)
                  if (trigger) {
                    skipCommit.current = true
                    trigger.focus()
                  }
                }
              }}
              className="uppercase focus-within:tracking-normal focus-within:normal-case"
            />
          ) : (
            category.name
          )}
        </h3>
        {total !== undefined && <span className="text-[13px] font-semibold whitespace-nowrap text-slate-500 tabular-nums">{total}</span>}
        {confirmingDelete ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false)
                onDelete?.(category.id)
              }}
              aria-label={`Confirm delete ${category.name}`}
              className="h-8 rounded-lg bg-destructive px-2.5 text-[13px] font-semibold text-white hover:bg-rose-700"
            >
              Delete
            </button>
            <button
              type="button"
              autoFocus
              onClick={cancelDelete}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelDelete()
              }}
              aria-label="Cancel delete"
              className="h-8 rounded-lg px-2.5 text-[13px] font-semibold text-slate-500 hover:bg-surface-2 dark:hover:bg-foreground/7"
            >
              Cancel
            </button>
          </span>
        ) : actions.length === 0 ? (
          // No ⋯ (read-only or limited access): keep its column on wide rows so the total stays
          // over the lines' amounts.
          !phone && <span aria-hidden className="hidden w-8 shrink-0 @min-[500px]:block" />
        ) : (
          <span className="flex">
            <RowMenu
              label={`${category.name} group: more actions`}
              actions={actions}
              triggerClassName={
                phone || empty
                  ? ''
                  : 'opacity-0 group-focus-within/gh:opacity-100 group-hover/gh:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'
              }
            />
          </span>
        )}
      </div>

      <div>
        {children}
        {empty && (
          <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 not-first:border-t not-first:border-line">
            <span className="flex items-center gap-1.5 text-sm text-slate-500">
              {kind === 'income' ? 'No income yet' : kind === 'savings' ? 'No jars yet' : 'No lines yet'}
              {kind === 'savings' && (
                <InfoHint
                  label="About jars"
                  buttonClassName="relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
                >
                  Each jar is held in one of your accounts.
                </InfoHint>
              )}
            </span>
            {emptyAdd}
          </div>
        )}
        {adding && onAddItem && (
          <div data-entry className="flex items-center gap-2 py-2.5 not-first:border-t not-first:border-line">
            <input
              type="text"
              autoFocus
              value={newName}
              placeholder={income ? 'Income source, e.g. Freelance' : 'Line name, e.g. Groceries'}
              aria-label={income ? 'New income source name' : `Add a line to ${category.name}`}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault() // focus goes back to the ⋯: the Enter must not press it too
                  submitNew()
                }
                if (e.key === 'Escape') cancelAdd()
              }}
              onBlur={() => !newName.trim() && setAdding(false)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-surface px-3 text-sm text-slate-800 placeholder:text-slate-500 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={submitNew}
              aria-label={income ? 'Add income source' : `Add line to ${category.name}`}
              className="h-9"
            >
              Add
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The link-quiet add button in an empty group. */
function QuietAdd({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-brand-700 transition hover:bg-surface-2 dark:text-brand-200 dark:hover:bg-foreground/7"
    >
      <Plus aria-hidden className="size-4" />
      {children}
    </button>
  )
}
