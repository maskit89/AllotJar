import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CircleAlertIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from './alert'
import { Badge, badgeVariants } from './badge'
import { Button, buttonVariants } from './button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card'
import { Progress } from './progress'
import { Separator } from './separator'
import { Skeleton } from './skeleton'
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from './table'
import { cn } from '../../lib/utils'

const button = (name: string) => screen.getByRole('button', { name })
const indicatorOf = (bar: HTMLElement) => bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]')!

describe('Button', () => {
  it('is type="button" by default, so it never submits its form; an explicit type="submit" does', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <Button>Cancel</Button>
        <Button type="submit">Save</Button>
      </form>,
    )
    expect(button('Cancel')).toHaveAttribute('type', 'button')
    expect(button('Cancel')).toHaveAttribute('data-slot', 'button')
    await user.click(button('Cancel'))
    expect(onSubmit).not.toHaveBeenCalled()

    expect(button('Save')).toHaveAttribute('type', 'submit')
    await user.click(button('Save'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('fires onClick from a click and from the keyboard', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Add jar</Button>)
    await user.tab()
    expect(button('Add jar')).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onClick).toHaveBeenCalledTimes(2)
    await user.click(button('Add jar'))
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('applies the default variant and size, or the ones asked for', () => {
    render(
      <>
        <Button>Default</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Add">
          +
        </Button>
      </>,
    )
    expect(button('Default')).toHaveClass('bg-primary', 'text-primary-foreground', 'h-9', 'px-4')
    expect(button('Delete')).toHaveClass('bg-destructive', 'text-destructive-foreground')
    expect(button('Delete')).not.toHaveClass('bg-primary')
    expect(button('Outline')).toHaveClass('border', 'border-border', 'bg-card', 'text-foreground')
    expect(button('Secondary')).toHaveClass('bg-secondary', 'text-secondary-foreground')
    expect(button('Ghost')).toHaveClass('hover:bg-accent')
    expect(button('Ghost')).not.toHaveClass('bg-primary')
    expect(button('Link')).toHaveClass('text-primary', 'hover:underline', 'dark:text-brand-500')
    expect(button('Small')).toHaveClass('h-8', 'px-3')
    expect(button('Small')).not.toHaveClass('h-9')
    expect(button('Large')).toHaveClass('h-10', 'px-6')
    expect(button('Add')).toHaveClass('size-9')
    expect(button('Add')).not.toHaveClass('h-9')
  })

  it('exports its variants so a non-button can look like one', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'sm' }).split(' ')
    expect(classes).toEqual(expect.arrayContaining(['border-border', 'h-8']))
    expect(classes).not.toContain('bg-primary')
  })

  it('renders its child instead with asChild: a link that looks like a button, with no type attribute', () => {
    render(
      <Button asChild variant="outline">
        <a href="/jars">Open jars</a>
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'Open jars' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/jars')
    expect(link).toHaveAttribute('data-slot', 'button')
    expect(link).not.toHaveAttribute('type')
    expect(link).toHaveClass('border-border', 'bg-card')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('is disabled: no click reaches onClick, and it is dimmed', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    )
    expect(button('Save')).toBeDisabled()
    expect(button('Save')).toHaveClass('disabled:pointer-events-none', 'disabled:opacity-50')
    await user.click(button('Save'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it("lets a caller's className win over a default of the same kind", () => {
    render(<Button className="bg-secondary px-8">Wide</Button>)
    expect(button('Wide')).toHaveClass('bg-secondary', 'px-8')
    expect(button('Wide')).not.toHaveClass('bg-primary')
    expect(button('Wide')).not.toHaveClass('px-4')
  })
})

describe('Card', () => {
  it('renders each part with its data-slot inside a bordered card surface', () => {
    render(
      <Card data-testid="card">
        <CardHeader data-testid="header">
          <CardTitle>Groceries</CardTitle>
          <CardDescription>320 left this month</CardDescription>
          <CardAction>
            <Button size="sm">Edit</Button>
          </CardAction>
        </CardHeader>
        <CardContent>Weekly shop and markets</CardContent>
        <CardFooter>Resets on the 1st</CardFooter>
      </Card>,
    )
    const card = screen.getByTestId('card')
    expect(card).toHaveAttribute('data-slot', 'card')
    expect(card).toHaveClass('border', 'border-border', 'bg-card', 'text-card-foreground')
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'card-header')
    expect(screen.getByText('Groceries')).toHaveAttribute('data-slot', 'card-title')
    expect(screen.getByText('320 left this month')).toHaveAttribute('data-slot', 'card-description')
    expect(screen.getByText('320 left this month')).toHaveClass('text-muted-foreground')
    expect(button('Edit').parentElement).toHaveAttribute('data-slot', 'card-action')
    expect(screen.getByText('Weekly shop and markets')).toHaveAttribute('data-slot', 'card-content')
    expect(screen.getByText('Resets on the 1st')).toHaveAttribute('data-slot', 'card-footer')
    // The header makes room for the action column only when an action is present.
    expect(screen.getByTestId('header')).toHaveClass('has-data-[slot=card-action]:grid-cols-[1fr_auto]')
  })

  it("lets a caller's className win over a default of the same kind", () => {
    render(
      <Card data-testid="card" className="gap-2 py-4">
        <CardContent className="px-4">Body</CardContent>
      </Card>,
    )
    expect(screen.getByTestId('card')).toHaveClass('gap-2', 'py-4')
    expect(screen.getByTestId('card')).not.toHaveClass('gap-6')
    expect(screen.getByTestId('card')).not.toHaveClass('py-6')
    expect(screen.getByText('Body')).toHaveClass('px-4')
    expect(screen.getByText('Body')).not.toHaveClass('px-6')
  })
})

describe('Badge', () => {
  it('is a span in the default variant, and takes each other variant', () => {
    render(
      <>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Overspent</Badge>
        <Badge variant="outline">Outline</Badge>
      </>,
    )
    const badge = screen.getByText('Default')
    expect(badge.tagName).toBe('SPAN')
    expect(badge).toHaveAttribute('data-slot', 'badge')
    expect(badge).toHaveClass('border-transparent', 'bg-primary', 'text-primary-foreground')
    expect(screen.getByText('Secondary')).toHaveClass('bg-secondary', 'text-secondary-foreground')
    expect(screen.getByText('Secondary')).not.toHaveClass('bg-primary')
    expect(screen.getByText('Overspent')).toHaveClass('bg-destructive', 'text-destructive-foreground')
    // Upstream's translucent dark fill would drop the white text below AA.
    expect(screen.getByText('Overspent')).not.toHaveClass('dark:bg-destructive/60')
    expect(screen.getByText('Outline')).toHaveClass('border', 'border-border', 'text-foreground')
    expect(screen.getByText('Outline')).not.toHaveClass('bg-primary')
  })

  it('renders its child instead with asChild, and the hover style applies only to a link', () => {
    render(
      <Badge asChild variant="outline">
        <a href="/jars/groceries">Groceries</a>
      </Badge>,
    )
    const link = screen.getByRole('link', { name: 'Groceries' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/jars/groceries')
    expect(link).toHaveAttribute('data-slot', 'badge')
    expect(link).toHaveClass('border-border', '[a&]:hover:bg-accent')
  })

  it("lets a caller's className win over a default of the same kind, and exports its variants", () => {
    render(<Badge className="rounded-full px-3">Pill</Badge>)
    expect(screen.getByText('Pill')).toHaveClass('rounded-full', 'px-3')
    expect(screen.getByText('Pill')).not.toHaveClass('rounded-md')
    expect(screen.getByText('Pill')).not.toHaveClass('px-2')
    expect(badgeVariants({ variant: 'destructive' }).split(' ')).toContain('bg-destructive')
  })
})

describe('Separator', () => {
  it('is decorative by default: a horizontal hairline kept out of the accessibility tree', () => {
    render(<Separator data-testid="separator" />)
    const separator = screen.getByTestId('separator')
    expect(separator).toHaveAttribute('data-slot', 'separator')
    expect(separator).toHaveAttribute('role', 'none')
    expect(separator).toHaveAttribute('data-orientation', 'horizontal')
    expect(separator).toHaveClass('bg-border', 'data-[orientation=horizontal]:h-px')
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('is announced as a separator, with its orientation, when not decorative', () => {
    render(<Separator decorative={false} orientation="vertical" />)
    const separator = screen.getByRole('separator')
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('data-orientation', 'vertical')
  })

  it("lets a caller's className win over a default of the same kind", () => {
    render(<Separator data-testid="separator" className="my-4 bg-primary" />)
    expect(screen.getByTestId('separator')).toHaveClass('my-4', 'bg-primary')
    expect(screen.getByTestId('separator')).not.toHaveClass('bg-border')
  })
})

describe('Skeleton', () => {
  it('is a pulsing placeholder whose size and shape the caller sets', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-32 rounded-full" />)
    const skeleton = screen.getByTestId('skeleton')
    expect(skeleton).toHaveAttribute('data-slot', 'skeleton')
    expect(skeleton).toHaveClass('animate-pulse', 'bg-accent', 'h-4', 'w-32', 'rounded-full')
    expect(skeleton).not.toHaveClass('rounded-md')
  })
})

describe('Progress', () => {
  it('is a progressbar named by its label, exposing its value, its range and a percentage', () => {
    render(<Progress value={40} aria-label="Groceries spent" />)
    const bar = screen.getByRole('progressbar', { name: 'Groceries spent' })
    expect(bar).toHaveAttribute('data-slot', 'progress')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuetext', '40%')
    expect(bar).toHaveAttribute('data-state', 'loading')
    expect(indicatorOf(bar)).toHaveClass('bg-primary')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-60%)')
  })

  it('fills against max, and follows the value as it changes', () => {
    const { rerender } = render(<Progress value={50} max={200} aria-label="Saved" />)
    const bar = screen.getByRole('progressbar', { name: 'Saved' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(bar).toHaveAttribute('aria-valuemax', '200')
    expect(bar).toHaveAttribute('aria-valuetext', '25%')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-75%)')

    rerender(<Progress value={200} max={200} aria-label="Saved" />)
    expect(bar).toHaveAttribute('aria-valuenow', '200')
    expect(bar).toHaveAttribute('data-state', 'complete')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-0%)')
  })

  it('clamps an overspent or negative value, so the bar reads full or empty and Radix logs nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(<Progress value={130} max={100} aria-label="Groceries spent" />)
    const bar = screen.getByRole('progressbar', { name: 'Groceries spent' })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(bar).toHaveAttribute('data-state', 'complete')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-0%)')

    rerender(<Progress value={-5} max={100} aria-label="Groceries spent" />)
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-100%)')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('is indeterminate and empty with no value', () => {
    render(<Progress aria-label="Loading" />)
    const bar = screen.getByRole('progressbar', { name: 'Loading' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('data-state', 'indeterminate')
    expect(indicatorOf(bar).style.transform).toBe('translateX(-100%)')
  })

  it("lets a caller's className win over a default of the same kind", () => {
    render(<Progress value={10} aria-label="Spent" className="h-3 bg-muted" />)
    const bar = screen.getByRole('progressbar', { name: 'Spent' })
    expect(bar).toHaveClass('h-3', 'bg-muted', 'rounded-full')
    expect(bar).not.toHaveClass('h-2')
    expect(bar).not.toHaveClass('bg-primary/20')
  })
})

describe('Alert', () => {
  it('is announced as an alert, with a title, a description and an optional icon', () => {
    render(
      <Alert>
        <CircleAlertIcon data-testid="icon" />
        <AlertTitle>Over budget</AlertTitle>
        <AlertDescription>Groceries is 20 over this month.</AlertDescription>
      </Alert>,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('data-slot', 'alert')
    expect(alert).toHaveTextContent('Over budget')
    expect(alert).toHaveClass('border', 'border-border', 'bg-card', 'text-card-foreground')
    expect(alert).toContainElement(screen.getByTestId('icon'))
    expect(screen.getByText('Over budget')).toHaveAttribute('data-slot', 'alert-title')
    expect(screen.getByText('Groceries is 20 over this month.')).toHaveAttribute('data-slot', 'alert-description')
    expect(screen.getByText('Groceries is 20 over this month.')).toHaveClass('text-muted-foreground')
  })

  it('the destructive variant turns the text red, in the red that stays readable in dark mode', () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Payment failed</AlertTitle>
      </Alert>,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('bg-card', 'text-destructive-text')
    expect(alert).not.toHaveClass('dark:bg-destructive')
    expect(alert).not.toHaveClass('text-card-foreground')
  })

  it("lets a caller's role and className win", () => {
    render(
      <Alert role="status" className="bg-muted px-6">
        Saved
      </Alert>,
    )
    const status = screen.getByRole('status')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(status).toHaveClass('bg-muted', 'px-6')
    expect(status).not.toHaveClass('bg-card')
    expect(status).not.toHaveClass('px-4')
  })
})

describe('Table', () => {
  const renderTable = () =>
    render(
      <Table className="min-w-[32rem]">
        <TableCaption>Recent transactions</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-state="selected">
            <TableCell>3 Oct</TableCell>
            <TableCell className="p-3 text-right">12.00</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>5 Oct</TableCell>
            <TableCell>40.00</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell>52.00</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    )

  it('is a table named by its caption, in a container that scrolls sideways on a narrow screen', () => {
    renderTable()
    const table = screen.getByRole('table', { name: 'Recent transactions' })
    expect(table).toHaveAttribute('data-slot', 'table')
    // The caller's className goes on the <table>, not on the scroll container.
    expect(table).toHaveClass('w-full', 'min-w-[32rem]')
    const container = table.parentElement!
    expect(container).toHaveAttribute('data-slot', 'table-container')
    expect(container).toHaveClass('overflow-x-auto')
    expect(container).not.toHaveClass('min-w-[32rem]')
    expect(screen.getByText('Recent transactions')).toHaveAttribute('data-slot', 'table-caption')
  })

  it('renders header, body and footer row groups with their cells', () => {
    renderTable()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Date', 'Amount'])
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getAllByRole('rowgroup').map((group) => group.getAttribute('data-slot'))).toEqual([
      'table-header',
      'table-body',
      'table-footer',
    ])
    expect(screen.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('data-slot', 'table-head')
    expect(screen.getByRole('cell', { name: '3 Oct' })).toHaveAttribute('data-slot', 'table-cell')
    const selected = screen.getByRole('cell', { name: '3 Oct' }).closest('tr')!
    expect(selected).toHaveAttribute('data-slot', 'table-row')
    expect(selected).toHaveClass('border-b', 'border-border', 'data-[state=selected]:bg-muted')
  })

  it("lets a caller's className win over a cell's defaults", () => {
    renderTable()
    const cell = screen.getByRole('cell', { name: '12.00' })
    expect(cell).toHaveClass('p-3', 'text-right')
    expect(cell).not.toHaveClass('p-2')
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveClass('text-right')
    expect(screen.getByRole('columnheader', { name: 'Amount' })).not.toHaveClass('text-left')
  })
})

// Splits a class into its variant prefix ("dark:", "[&_tr]:") and its utility, ignoring colons
// inside arbitrary [...] values.
function splitVariant(token: string): [string, string] {
  let depth = 0
  let cut = -1
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[') depth++
    else if (token[i] === ']') depth--
    else if (token[i] === ':' && depth === 0) cut = i
  }
  return [token.slice(0, cut + 1), token.slice(cut + 1)]
}

const BORDER_WIDTH = /^border(-[xytrbl])?(-[1-9]\d*)?$/
const BORDER_COLOUR = /^border(-[xytrbl])?-(border|input|transparent|destructive|ring|primary)(\/\d+)?$/
const PALETTE = /(^|-)(slate|gray|zinc|neutral|stone|red|rose|emerald|green|white|black)(-\d+)?(\/\d+)?$/

describe('the display building blocks follow the app rules', () => {
  it('use only semantic colours, give every border a colour, and add no focus ring of their own', () => {
    const { container } = render(
      <>
        <Button>One</Button>
        <Button variant="outline">Two</Button>
        <Button variant="link">Three</Button>
        <Card>
          <CardHeader>
            <CardTitle>Title</CardTitle>
            <CardDescription>Description</CardDescription>
            <CardAction>Action</CardAction>
          </CardHeader>
          <CardContent>Content</CardContent>
          <CardFooter>Footer</CardFooter>
        </Card>
        <Badge>a</Badge>
        <Badge variant="secondary">b</Badge>
        <Badge variant="destructive">c</Badge>
        <Badge variant="outline">d</Badge>
        <Separator />
        <Skeleton />
        <Progress value={30} aria-label="Spent" />
        <Alert>
          <AlertTitle>Title</AlertTitle>
          <AlertDescription>Description</AlertDescription>
        </Alert>
        <Alert variant="destructive">Error</Alert>
        <Table>
          <TableCaption>Caption</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Head</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Foot</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </>,
    )

    const problems: string[] = []
    for (const element of container.querySelectorAll<HTMLElement>('[data-slot]')) {
      const slot = element.dataset.slot
      const tokens = [...element.classList]
      const colouredPrefixes = new Set<string>()
      for (const token of tokens) {
        const [prefix, utility] = splitVariant(token)
        if (BORDER_COLOUR.test(utility)) colouredPrefixes.add(prefix)
        if (token.includes('#')) problems.push(`${slot}: hex colour ${token}`)
        if (PALETTE.test(utility.replace(/^(bg|text|border|ring|fill|stroke)-/, ''))) {
          problems.push(`${slot}: palette colour ${token}`)
        }
        // The one palette exception: the brightened brand green for text and data marks in dark mode.
        if (utility.includes('brand-') && !/^dark:(text|bg)-brand-500$/.test(token)) problems.push(`${slot}: ${token}`)
        if (/^ring(-|$)/.test(utility) || /^outline-(none|hidden)$/.test(utility)) {
          problems.push(`${slot}: focus style ${token}`)
        }
      }
      for (const token of tokens) {
        const [prefix, utility] = splitVariant(token)
        if (BORDER_WIDTH.test(utility) && !colouredPrefixes.has(prefix) && !colouredPrefixes.has('')) {
          problems.push(`${slot}: ${token} has no border colour`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})

describe('cn', () => {
  it("knows the app's own shadow sizes, so a caller's shadow-card replaces a block's default shadow", () => {
    expect(cn('shadow-sm', 'shadow-card')).toBe('shadow-card')
    expect(cn('shadow-xs', 'shadow-hero')).toBe('shadow-hero')
    // A shadow colour is a different kind of class and stays.
    expect(cn('shadow-card', 'shadow-black/10')).toBe('shadow-card shadow-black/10')
    render(<Card className="shadow-card">Jar</Card>)
    const card = screen.getByText('Jar')
    expect(card).toHaveClass('shadow-card')
    expect(card).not.toHaveClass('shadow-sm')
  })
})
