import { Fragment, useId, useRef, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './ui/sheet'

/**
 * One action of a row (restyle PR 3): a line's or a group's rarely used actions live behind a ⋯
 * menu on wide screens and in a bottom sheet on phones, the same list in both.
 */
export interface RowAction {
  key: string
  /** The visible text, which is also the item's accessible name (unless `ariaLabel` gives a fuller one). */
  label: string
  /** A fuller accessible name that starts with `label` (e.g. which cycle a payment is for). */
  ariaLabel?: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /**
   * When the action runs: by default straight away (focus then returns to the ⋯ or the line).
   * 'focus': after the menu has closed, for an action that moves focus itself (it opens an
   * editor in the row, which takes focus). 'dialog': after the menu has closed and focus is back
   * on its trigger, for an action that opens a dialog, which returns focus there when it closes.
   */
  after?: 'focus' | 'dialog'
  /** Starts a new section (a divider above it): the destructive actions. */
  separatorBefore?: boolean
}

/** A row of the menu, as in the mock-ups and the account menu: 38px, a 16px icon column. */
const ITEM =
  "h-[38px] gap-2.5 rounded-lg px-2.5 text-sm font-medium text-popover-foreground focus:bg-surface-2 focus:text-popover-foreground dark:focus:bg-foreground/7 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

/** A destructive action reads in the status red (as in the mock-up), which stays AA on the popover in both themes. */
const DANGER = 'text-bad! focus:text-bad! [&_svg]:text-bad!'

/** The ⋯ button: 32px on a pointer screen, 40px for a finger. Also the look of a ⋯ that opens an ActionSheet. */
export const ROW_MENU_TRIGGER =
  'relative inline-grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 data-[state=open]:bg-surface-2 data-[state=open]:text-slate-900 [@media(hover:none)]:size-10 dark:hover:bg-foreground/7 dark:data-[state=open]:bg-foreground/7'

/**
 * The ⋯ menu of a row: a Radix menu (arrow keys move through it, Escape closes it, focus returns
 * to the ⋯), non-modal like the account menu. `note` is a line of context at the top of the menu
 * (a jar's balance), which also describes the menu to assistive tech. `triggerClassName` adds to
 * the ⋯ button, e.g. to show it only while the row is hovered or holds focus.
 */
export function RowMenu({
  label,
  actions,
  note,
  triggerClassName = '',
}: {
  /** The ⋯ button's accessible name, e.g. "Rent: more actions". */
  label: string
  actions: RowAction[]
  note?: ReactNode
  triggerClassName?: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  // An action that waits for the menu to close (see RowAction.after).
  const pending = useRef<RowAction | null>(null)
  const noteId = useId()
  if (actions.length === 0) return null
  return (
    <DropdownMenu modal={false}>
      {/* data-row-trigger: where a row gives focus back when one of its inline editors closes. */}
      <DropdownMenuTrigger ref={trigger} data-row-trigger="" aria-label={label} className={`${ROW_MENU_TRIGGER} ${triggerClassName}`}>
        <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-[196px] rounded-xl p-1.5 shadow-[var(--shadow-frame-lg)]"
        aria-describedby={note ? noteId : undefined}
        onCloseAutoFocus={(e) => {
          const action = pending.current
          pending.current = null
          if (!action) return
          e.preventDefault()
          if (action.after === 'dialog') trigger.current?.focus()
          action.onSelect()
        }}
      >
        {note && (
          <DropdownMenuLabel id={noteId} className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-slate-500 tabular-nums">
            {note}
          </DropdownMenuLabel>
        )}
        {actions.map((a) => (
          <Fragment key={a.key}>
            {a.separatorBefore && <DropdownMenuSeparator className="mx-1 my-1.5" />}
            <DropdownMenuItem
              className={`${ITEM} ${a.danger ? DANGER : ''}`}
              variant={a.danger ? 'destructive' : 'default'}
              disabled={a.disabled}
              aria-label={a.ariaLabel}
              onSelect={() => {
                if (a.after) pending.current = a
                else a.onSelect()
              }}
            >
              {a.icon}
              {a.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A row of the sheet, as in the phone More sheet: 52px, a 20px icon, the label at 16px. */
const SHEET_ROW =
  "relative flex min-h-[52px] w-full items-center gap-3.5 text-left text-base font-semibold text-slate-900 disabled:opacity-50 not-first:before:absolute not-first:before:top-0 not-first:before:-right-4 not-first:before:left-[46px] not-first:before:border-t not-first:before:border-slate-200 not-first:before:content-[''] [&_svg]:mx-1.5 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-slate-500"
const SHEET_GROUP =
  'flex flex-col rounded-[14px] border border-slate-200/70 bg-card px-4 shadow-[var(--shadow-frame)] dark:bg-surface-2 dark:shadow-none'

/**
 * A row's actions on a phone: the whole row is the trigger (`children`, rendered as the sheet's
 * trigger) and its actions open in a bottom sheet titled with the row's name, the same list the
 * ⋯ menu shows on wider screens. A Radix dialog: focus moves into it, Escape or the grabber
 * closes it, and focus returns to the row.
 */
export function ActionSheet({
  title,
  description,
  actions,
  open,
  onOpenChange,
  children,
}: {
  title: string
  /** One short line under the title (what the line holds). */
  description?: ReactNode
  actions: RowAction[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The trigger: one element (the row's name button). */
  children: ReactNode
}) {
  const trigger = useRef<HTMLElement | null>(null)
  const pending = useRef<RowAction | null>(null)

  // Split into sections at each divider.
  const sections: RowAction[][] = []
  for (const a of actions) {
    if (a.separatorBefore || sections.length === 0) sections.push([])
    sections[sections.length - 1].push(a)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        asChild
        ref={(el) => {
          trigger.current = el
        }}
      >
        {children}
      </SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(e) => {
          const action = pending.current
          pending.current = null
          if (!action) return
          e.preventDefault()
          if (action.after === 'dialog') trigger.current?.focus()
          action.onSelect()
        }}
        overlayClassName="bg-[rgb(10_20_15/0.32)] backdrop-blur-[2px] dark:bg-black/55"
        className="bottom-[var(--tabbar-h)] max-h-[calc(100dvh-var(--tabbar-h)-2rem)] gap-3 rounded-t-[20px] border-0 bg-background pt-2 pr-[max(1rem,env(safe-area-inset-right))] pb-4 pl-[max(1rem,env(safe-area-inset-left))] shadow-[0_-12px_32px_-12px_rgb(10_30_20/0.35)] dark:border-t dark:border-slate-200 dark:bg-card dark:shadow-[0_-12px_32px_-8px_rgb(0_0_0/0.7)]"
      >
        <SheetClose
          aria-label="Close"
          className="relative mx-auto mb-0.5 block h-[5px] w-[38px] shrink-0 rounded-full bg-slate-500/35 after:absolute after:-inset-x-5 after:-inset-y-3.5 after:content-['']"
        />
        <div className="px-1">
          <SheetTitle className="truncate text-base font-semibold text-slate-900">{title}</SheetTitle>
          {description && (
            <SheetDescription className="mt-0.5 text-[13px] text-slate-500 tabular-nums">{description}</SheetDescription>
          )}
        </div>
        {sections.map((section, i) => (
          <div key={i} className={SHEET_GROUP}>
            {section.map((a) => (
              <button
                key={a.key}
                type="button"
                disabled={a.disabled}
                aria-label={a.ariaLabel}
                onClick={() => {
                  if (a.after) {
                    pending.current = a
                    onOpenChange(false)
                  } else {
                    onOpenChange(false)
                    a.onSelect()
                  }
                }}
                className={`${SHEET_ROW} ${a.danger ? DANGER : ''}`}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
        ))}
      </SheetContent>
    </Sheet>
  )
}
