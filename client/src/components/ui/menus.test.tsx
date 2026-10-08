import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'
import { Toggle } from './toggle'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

function JarMenu({ onRename = () => {}, onDelete = () => {} }: { onRename?: () => void; onDelete?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Jar actions</DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Jar actions">
        <DropdownMenuLabel>Groceries</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onRename}>
            Rename
            <DropdownMenuShortcut>R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem inset className="px-4">
            Move
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('DropdownMenu', () => {
  it('opens from its trigger on click, lists menuitems, and selecting one calls onSelect, closes the menu and returns focus', async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<JarMenu onRename={onRename} />)
    const trigger = screen.getByRole('button', { name: 'Jar actions' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('data-slot', 'dropdown-menu-trigger')

    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Jar actions' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(menu).toHaveAttribute('data-slot', 'dropdown-menu-content')
    // Above a dialog (z-[80]) it may open from, with a coloured hairline (there is no base layer).
    expect(menu).toHaveClass('z-[90]', 'border-border', 'bg-popover')
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['RenameR', 'Move', 'Delete'])

    await user.click(screen.getByRole('menuitem', { name: /Rename/ }))
    expect(onRename).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('opens from the keyboard with Enter or ArrowDown, focusing the first item, and closes on Escape back to the trigger', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<JarMenu onDelete={onDelete} />)
    const trigger = screen.getByRole('button', { name: 'Jar actions' })

    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Rename/ })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Rename/ })).toHaveFocus())
    await user.keyboard('{ArrowDown}{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('marks focused items with a background and an inset outline, and styles the destructive variant', async () => {
    const user = userEvent.setup()
    render(<JarMenu />)
    await user.click(screen.getByRole('button', { name: 'Jar actions' }))

    const rename = screen.getByRole('menuitem', { name: /Rename/ })
    expect(rename).toHaveAttribute('data-slot', 'dropdown-menu-item')
    expect(rename).toHaveAttribute('data-variant', 'default')
    expect(rename).toHaveClass('focus:bg-accent', '-outline-offset-2!', 'outline-ring!')
    expect(rename).not.toHaveClass('outline-none!')
    expect(screen.getByText('R')).toHaveAttribute('data-slot', 'dropdown-menu-shortcut')

    const remove = screen.getByRole('menuitem', { name: 'Delete' })
    expect(remove).toHaveAttribute('data-variant', 'destructive')
    expect(remove).toHaveClass(
      'data-[variant=destructive]:text-destructive-text',
      'data-[variant=destructive]:focus:bg-destructive/10',
    )

    // An inset item pads for an indicator column, and a caller's className wins over a default.
    const move = screen.getByRole('menuitem', { name: 'Move' })
    expect(move).toHaveAttribute('data-inset', 'true')
    expect(move).toHaveClass('px-4', 'data-[inset]:pl-8')
    expect(move).not.toHaveClass('px-2')
    expect(screen.getByText('Groceries')).toHaveAttribute('data-slot', 'dropdown-menu-label')
  })

  it('reports checkbox and radio item state and their changes', async () => {
    const user = userEvent.setup()
    const seenChecked: boolean[] = []
    const seenSort: string[] = []
    function ViewMenu() {
      const [showHidden, setShowHidden] = useState(false)
      const [sort, setSort] = useState('name')
      return (
        <DropdownMenu>
          <DropdownMenuTrigger>View</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem
              checked={showHidden}
              onCheckedChange={(checked) => {
                seenChecked.push(checked)
                setShowHidden(checked)
              }}
            >
              Show hidden jars
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => {
                seenSort.push(value)
                setSort(value)
              }}
            >
              <DropdownMenuRadioItem value="name">By name</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="balance">By balance</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    render(<ViewMenu />)
    const trigger = screen.getByRole('button', { name: 'View' })

    await user.click(trigger)
    const hidden = screen.getByRole('menuitemcheckbox', { name: 'Show hidden jars' })
    expect(hidden).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemradio', { name: 'By name' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'By balance' })).toHaveAttribute('aria-checked', 'false')
    await user.click(hidden)
    expect(seenChecked).toEqual([true])

    await user.click(trigger)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show hidden jars' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitemradio', { name: 'By balance' }))
    expect(seenSort).toEqual(['balance'])

    await user.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: 'By balance' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'By name' })).toHaveAttribute('aria-checked', 'false')
  })

  it('opens a submenu from its sub-trigger with ArrowRight and closes it with ArrowLeft', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Jar actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onMove('bills')}>Bills</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await user.tab()
    await user.keyboard('{ArrowDown}')
    const subTrigger = screen.getByRole('menuitem', { name: 'Move to' })
    await waitFor(() => expect(subTrigger).toHaveFocus())
    expect(subTrigger).toHaveAttribute('aria-haspopup', 'menu')

    await user.keyboard('{ArrowRight}')
    const bills = await screen.findByRole('menuitem', { name: 'Bills' })
    await waitFor(() => expect(bills).toHaveFocus())
    expect(screen.getAllByRole('menu')[1]).toHaveClass('z-[90]', 'border-border')

    await user.keyboard('{ArrowLeft}')
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Bills' })).not.toBeInTheDocument())
    expect(subTrigger).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Bills' })).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(onMove).toHaveBeenCalledWith('bills')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})

describe('Popover', () => {
  it('opens from its trigger, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverAnchor asChild>
          <div>Anchor</div>
        </PopoverAnchor>
        <PopoverTrigger>Rollover rules</PopoverTrigger>
        <PopoverContent aria-label="Rollover rules" className="w-80">
          <button type="button">Keep the rest</button>
        </PopoverContent>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Rollover rules' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Anchor')).toHaveAttribute('data-slot', 'popover-anchor')

    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Rollover rules' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toHaveAttribute('data-slot', 'popover-content')
    expect(panel).toHaveClass('w-80', 'z-[90]', 'border-border', 'bg-popover')
    expect(panel).not.toHaveClass('w-72')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep the rest' })).toHaveFocus())

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('works as a controlled popover: the trigger reports open changes, Escape reports a close', async () => {
    const user = userEvent.setup()
    const seen: boolean[] = []
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <Popover
          open={open}
          onOpenChange={(next) => {
            seen.push(next)
            setOpen(next)
          }}
        >
          <PopoverTrigger>Details</PopoverTrigger>
          <PopoverContent>Due on the 1st.</PopoverContent>
        </Popover>
      )
    }
    render(<Controlled />)
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Due on the 1st.')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(seen).toEqual([true, false])
  })
})

describe('Tooltip', () => {
  it('shows its content when the trigger takes keyboard focus, describes the trigger, and hides on Escape', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip>
        <TooltipTrigger>Rollover</TooltipTrigger>
        <TooltipContent className="px-2">Unspent money moves to next month.</TooltipContent>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: 'Rollover' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await user.tab()
    expect(trigger).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Unspent money moves to next month.')
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)

    const content = document.querySelector('[data-slot="tooltip-content"]')
    expect(content).toHaveClass('z-[90]', 'bg-foreground', 'text-background', 'px-2')
    expect(content).not.toHaveClass('px-3')
    expect(document.querySelector('[data-slot="tooltip-arrow"]')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('works inside a shared TooltipProvider and hides when focus leaves', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>First</TooltipTrigger>
          <TooltipContent>First tip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>Second</TooltipTrigger>
          <TooltipContent>Second tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('First tip')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Second tip'))
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
  })
})

describe('Tabs', () => {
  it('moves between tabs with the arrow keys and shows the matching panel', async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    function Controlled() {
      const [value, setValue] = useState('month')
      return (
        <Tabs
          value={value}
          onValueChange={(next) => {
            seen.push(next)
            setValue(next)
          }}
        >
          <TabsList aria-label="Period">
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="year">Year</TabsTrigger>
          </TabsList>
          <TabsContent value="month">This month's jars</TabsContent>
          <TabsContent value="year">This year's jars</TabsContent>
        </Tabs>
      )
    }
    render(<Controlled />)
    expect(screen.getByRole('tablist', { name: 'Period' })).toHaveAttribute('data-slot', 'tabs-list')
    const month = screen.getByRole('tab', { name: 'Month' })
    const year = screen.getByRole('tab', { name: 'Year' })
    expect(month).toHaveAttribute('aria-selected', 'true')
    expect(year).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel', { name: 'Month' })).toHaveTextContent("This month's jars")

    await user.tab()
    expect(month).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(year).toHaveFocus())
    expect(year).toHaveAttribute('aria-selected', 'true')
    expect(month).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel', { name: 'Year' })).toHaveTextContent("This year's jars")
    expect(screen.queryByText("This month's jars")).not.toBeInTheDocument()

    await user.keyboard('{ArrowLeft}')
    await waitFor(() => expect(month).toHaveFocus())
    expect(screen.getByRole('tabpanel', { name: 'Month' })).toBeInTheDocument()
    expect(seen).toEqual(['year', 'month'])
  })

  it('switches on click, and lets a caller restyle the list and triggers', async () => {
    const user = userEvent.setup()
    render(
      <Tabs defaultValue="a" className="gap-4">
        <TabsList className="h-11">
          <TabsTrigger value="a" className="px-4">
            A
          </TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    )
    await user.click(screen.getByRole('tab', { name: 'B' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B')

    const list = screen.getByRole('tablist')
    expect(list).toHaveClass('h-11', 'bg-muted')
    expect(list).not.toHaveClass('h-9')
    expect(list.parentElement).toHaveClass('gap-4')
    expect(list.parentElement).not.toHaveClass('gap-2')
    const a = screen.getByRole('tab', { name: 'A' })
    expect(a).toHaveClass('px-4', 'border-transparent')
    expect(a).not.toHaveClass('px-2')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'tabs-content')
  })
})

describe('Toggle', () => {
  it('reports its pressed state through aria-pressed and onPressedChange', async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    render(<Toggle aria-label="Show cents" onPressedChange={onPressedChange} />)
    const toggle = screen.getByRole('button', { name: 'Show cents' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('data-slot', 'toggle')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('data-state', 'on')
    expect(onPressedChange).toHaveBeenLastCalledWith(true)

    toggle.focus()
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(onPressedChange).toHaveBeenLastCalledWith(false)
  })

  it('applies its variants and size, and lets a caller override a default', () => {
    render(
      <>
        <Toggle aria-label="Plain" />
        <Toggle aria-label="Outlined" variant="outline" size="sm" />
        <Toggle aria-label="Tall" className="h-11" />
      </>,
    )
    const plain = screen.getByRole('button', { name: 'Plain' })
    expect(plain).toHaveClass('bg-transparent', 'h-9', 'data-[state=on]:bg-primary', 'data-[state=on]:text-primary-foreground')
    expect(plain).not.toHaveClass('border')

    const outlined = screen.getByRole('button', { name: 'Outlined' })
    expect(outlined).toHaveClass('border', 'border-input', 'h-8', 'min-w-8')
    expect(outlined).not.toHaveClass('h-9')

    const tall = screen.getByRole('button', { name: 'Tall' })
    expect(tall).toHaveClass('h-11')
    expect(tall).not.toHaveClass('h-9')
  })
})

describe('ToggleGroup', () => {
  it('keeps a single selection: choosing an item unchecks the previous one', async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    function Controlled() {
      const [value, setValue] = useState('week')
      return (
        <ToggleGroup
          type="single"
          aria-label="Repeat"
          value={value}
          onValueChange={(next) => {
            seen.push(next)
            setValue(next)
          }}
        >
          <ToggleGroupItem value="week">Weekly</ToggleGroupItem>
          <ToggleGroupItem value="month">Monthly</ToggleGroupItem>
          <ToggleGroupItem value="year">Yearly</ToggleGroupItem>
        </ToggleGroup>
      )
    }
    render(<Controlled />)
    const group = screen.getByRole('radiogroup', { name: 'Repeat' })
    expect(group).toHaveAttribute('data-slot', 'toggle-group')
    const weekly = screen.getByRole('radio', { name: 'Weekly' })
    const monthly = screen.getByRole('radio', { name: 'Monthly' })
    expect(weekly).toHaveAttribute('aria-checked', 'true')
    expect(monthly).toHaveAttribute('aria-checked', 'false')

    await user.click(monthly)
    expect(seen).toEqual(['month'])
    expect(monthly).toHaveAttribute('aria-checked', 'true')
    expect(weekly).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByRole('radio').filter((item) => item.getAttribute('aria-checked') === 'true')).toHaveLength(1)

    // Arrow keys move focus between the items without selecting.
    await user.keyboard('{ArrowRight}')
    const yearly = screen.getByRole('radio', { name: 'Yearly' })
    await waitFor(() => expect(yearly).toHaveFocus())
    expect(yearly).toHaveAttribute('aria-checked', 'false')
    await user.keyboard(' ')
    expect(yearly).toHaveAttribute('aria-checked', 'true')
    expect(monthly).toHaveAttribute('aria-checked', 'false')
    expect(seen).toEqual(['month', 'year'])
  })

  it("hands the group's variant and size to its items, and lets an item's className win", () => {
    render(
      <ToggleGroup type="multiple" variant="outline" size="lg" aria-label="Show">
        <ToggleGroupItem value="income">Income</ToggleGroupItem>
        <ToggleGroupItem value="spending" className="px-6">
          Spending
        </ToggleGroupItem>
      </ToggleGroup>,
    )
    const group = screen.getByRole('toolbar', { name: 'Show' })
    expect(group).toHaveAttribute('data-variant', 'outline')
    const income = screen.getByRole('button', { name: 'Income' })
    expect(income).toHaveAttribute('data-slot', 'toggle-group-item')
    expect(income).toHaveAttribute('data-variant', 'outline')
    expect(income).toHaveAttribute('data-size', 'lg')
    expect(income).toHaveClass('border-input', 'h-10', 'rounded-none', 'first:rounded-l-md')
    expect(income).not.toHaveClass('rounded-md')
    expect(income).toHaveAttribute('aria-pressed', 'false')
    const spending = screen.getByRole('button', { name: 'Spending' })
    expect(spending).toHaveClass('px-6')
    expect(spending).not.toHaveClass('px-2.5')
  })
})
