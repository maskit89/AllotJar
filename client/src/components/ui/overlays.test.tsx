import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog'
import { buttonVariants } from './button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from './sheet'

function slot(name: string) {
  return document.querySelector(`[data-slot="${name}"]`)
}

function NewJarDialog({
  contentClassName,
  showCloseButton,
}: {
  contentClassName?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog>
      <DialogTrigger>New jar</DialogTrigger>
      <DialogContent className={contentClassName} showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>Create a jar</DialogTitle>
          <DialogDescription>Give the jar a name and a monthly amount.</DialogDescription>
        </DialogHeader>
        <label htmlFor="jar-name">Name</label>
        <input id="jar-name" />
        <DialogFooter>
          <DialogClose>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

describe('Dialog', () => {
  it('opens from its trigger as a modal dialog named by its title and described by its description', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog />)
    const trigger = screen.getByRole('button', { name: 'New jar' })
    expect(trigger).toHaveAttribute('data-slot', 'dialog-trigger')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Create a jar' })
    expect(dialog).toHaveAccessibleDescription('Give the jar a name and a monthly amount.')
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // Focus moves into the dialog, onto its first field.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus())
  })

  it('opens from the keyboard, closes on Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog />)
    const trigger = screen.getByRole('button', { name: 'New jar' })
    trigger.focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'Create a jar' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('has a close button named Close that closes the dialog and returns focus', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog />)
    const trigger = screen.getByRole('button', { name: 'New jar' })
    await user.click(trigger)

    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveAttribute('data-slot', 'dialog-close')
    expect(close).toHaveAttribute('type', 'button')
    await user.click(close)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes from a DialogClose the caller places, and on a click on the overlay', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog />)
    const trigger = screen.getByRole('button', { name: 'New jar' })

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    const overlay = slot('dialog-overlay')
    expect(overlay).not.toBeNull()
    await user.click(overlay as Element)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves the close button out when showCloseButton is false', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog showCloseButton={false} />)
    await user.click(screen.getByRole('button', { name: 'New jar' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  })

  it('works as a controlled dialog: open drives it, and onOpenChange reports each close', async () => {
    const user = userEvent.setup()
    const changes: boolean[] = []
    function Controlled() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <Dialog
            open={open}
            onOpenChange={(next) => {
              changes.push(next)
              setOpen(next)
            }}
          >
            <DialogContent>
              <DialogTitle>Edit account</DialogTitle>
              <DialogDescription>Rename the account.</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<Controlled />)
    expect(screen.getByRole('dialog', { name: 'Edit account' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(changes).toEqual([false])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(screen.getByRole('dialog', { name: 'Edit account' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(changes).toEqual([false, false])
  })

  it('stacks above the app layers and scrolls inside itself on a short screen', async () => {
    const user = userEvent.setup()
    render(<NewJarDialog />)
    await user.click(screen.getByRole('button', { name: 'New jar' }))
    expect(slot('dialog-overlay')).toHaveClass('z-[80]', 'bg-overlay')
    expect(screen.getByRole('dialog')).toHaveClass(
      'z-[80]',
      'max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto',
      'border-border',
      'bg-card',
    )
    // The header keeps clear of the close button in the corner.
    expect(screen.getByRole('dialog')).toHaveClass('[&_[data-slot=dialog-header]]:px-4')
  })

  it("lets a caller's className replace a default of the same kind", async () => {
    const user = userEvent.setup()
    render(<NewJarDialog contentClassName="p-5 rounded-2xl sm:max-w-2xl" />)
    await user.click(screen.getByRole('button', { name: 'New jar' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('p-5', 'rounded-2xl', 'sm:max-w-2xl', 'grid')
    expect(dialog).not.toHaveClass('p-6')
    expect(dialog).not.toHaveClass('rounded-lg')
    expect(dialog).not.toHaveClass('sm:max-w-lg')
  })
})

function DeleteJarAlert({ onDelete, actionClassName }: { onDelete: () => void; actionClassName?: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger>Delete jar</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this jar?</AlertDialogTitle>
          <AlertDialogDescription>Its transactions move to Unassigned.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction className={actionClassName} onClick={onDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

describe('AlertDialog', () => {
  it('opens as an alertdialog named by its title, with focus on Cancel', async () => {
    const user = userEvent.setup()
    render(<DeleteJarAlert onDelete={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete jar' }))

    const alert = screen.getByRole('alertdialog', { name: 'Delete this jar?' })
    expect(alert).toHaveAccessibleDescription('Its transactions move to Unassigned.')
    expect(alert).toHaveAttribute('data-slot', 'alert-dialog-content')
    expect(alert).toHaveClass('z-[80]', 'max-h-[calc(100dvh-2rem)]', 'overflow-y-auto')
    expect(slot('alert-dialog-overlay')).toHaveClass('z-[80]')
    // Radix puts the safe choice under the person's finger.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus())
  })

  it('does not close on a click on the overlay', async () => {
    const user = userEvent.setup()
    render(<DeleteJarAlert onDelete={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete jar' }))

    const overlay = slot('alert-dialog-overlay')
    expect(overlay).not.toBeNull()
    await user.click(overlay as Element)
    expect(screen.getByRole('alertdialog', { name: 'Delete this jar?' })).toBeInTheDocument()
  })

  it('closes on Cancel without running the action, and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<DeleteJarAlert onDelete={onDelete} />)
    const trigger = screen.getByRole('button', { name: 'Delete jar' })
    await user.click(trigger)

    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('runs the action and closes when the Action is chosen', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<DeleteJarAlert onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Delete jar' }))

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<DeleteJarAlert onDelete={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Delete jar' })
    await user.click(trigger)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('styles Action as the default button and Cancel as the outline button; a caller can swap the variant', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DeleteJarAlert onDelete={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete jar' }))

    const action = screen.getByRole('button', { name: 'Delete' })
    const cancel = screen.getByRole('button', { name: 'Keep it' })
    expect(action).toHaveAttribute('data-slot', 'alert-dialog-action')
    expect(action).toHaveClass('bg-primary', 'text-primary-foreground', 'h-9')
    expect(cancel).toHaveAttribute('data-slot', 'alert-dialog-cancel')
    expect(cancel).toHaveClass('border', 'border-border', 'bg-card')
    expect(cancel).not.toHaveClass('bg-primary')
    unmount()

    render(<DeleteJarAlert onDelete={() => {}} actionClassName={buttonVariants({ variant: 'destructive' })} />)
    await user.click(screen.getByRole('button', { name: 'Delete jar' }))
    const destructive = screen.getByRole('button', { name: 'Delete' })
    expect(destructive).toHaveClass('bg-destructive', 'text-destructive-foreground')
    expect(destructive).not.toHaveClass('bg-primary')
    expect(destructive).not.toHaveClass('text-primary-foreground')
  })
})

type Side = 'top' | 'right' | 'bottom' | 'left'

function FiltersSheet({ side, className }: { side?: Side; className?: string }) {
  return (
    <Sheet>
      <SheetTrigger>Filters</SheetTrigger>
      <SheetContent side={side} className={className}>
        <SheetHeader>
          <SheetTitle>Filter transactions</SheetTitle>
          <SheetDescription>Narrow the list by account and month.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <button type="button">Apply</button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

describe('Sheet', () => {
  it.each<[Side, string[]]>([
    ['top', ['top-0', 'inset-x-0', 'border-b', 'max-h-[calc(100dvh-2rem)]', 'data-[state=open]:slide-in-from-top']],
    ['right', ['right-0', 'inset-y-0', 'border-l', 'w-3/4', 'data-[state=open]:slide-in-from-right']],
    ['bottom', ['bottom-0', 'inset-x-0', 'border-t', 'max-h-[calc(100dvh-2rem)]', 'data-[state=open]:slide-in-from-bottom']],
    ['left', ['left-0', 'inset-y-0', 'border-r', 'w-3/4', 'data-[state=open]:slide-in-from-left']],
  ])('opens from the %s side as a dialog named by its title', async (side, classes) => {
    const user = userEvent.setup()
    render(<FiltersSheet side={side} />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))

    const sheet = screen.getByRole('dialog', { name: 'Filter transactions' })
    expect(sheet).toHaveAccessibleDescription('Narrow the list by account and month.')
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    expect(sheet).toHaveAttribute('data-side', side)
    expect(sheet).toHaveClass(...classes, 'z-[80]', 'border-border', 'overflow-y-auto')
    expect(slot('sheet-overlay')).toHaveClass('z-[80]')
  })

  it('opens from the right by default', async () => {
    const user = userEvent.setup()
    render(<FiltersSheet />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const sheet = screen.getByRole('dialog', { name: 'Filter transactions' })
    expect(sheet).toHaveAttribute('data-side', 'right')
    expect(sheet).toHaveClass('right-0', 'border-l')
  })

  it('closes from its Close button and on Escape, returning focus to the trigger each time', async () => {
    const user = userEvent.setup()
    render(<FiltersSheet />)
    const trigger = screen.getByRole('button', { name: 'Filters' })

    await user.click(trigger)
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveAttribute('data-slot', 'sheet-close')
    await user.click(close)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("lets a caller's className replace a default of the same kind", async () => {
    const user = userEvent.setup()
    render(<FiltersSheet className="w-full sm:max-w-md" />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveClass('w-full', 'sm:max-w-md', 'right-0')
    expect(sheet).not.toHaveClass('w-3/4')
    expect(sheet).not.toHaveClass('sm:max-w-sm')
  })
})
