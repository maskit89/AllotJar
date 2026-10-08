import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Checkbox } from './checkbox'
import { Input } from './input'
import { Label } from './label'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './native-select'
import { RadioGroup, RadioGroupItem } from './radio-group'
import { Switch } from './switch'
import { Textarea } from './textarea'

describe('Input', () => {
  it('is named by a Label pointing at it, and keeps its native type and inputMode', () => {
    render(
      <>
        <Label htmlFor="amount">Amount</Label>
        <Input id="amount" type="text" inputMode="decimal" />
      </>,
    )
    const input = screen.getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('inputmode', 'decimal')
    expect(input).toHaveAttribute('data-slot', 'input')
    expect(screen.getByText('Amount')).toHaveAttribute('data-slot', 'label')
  })

  it('works as a controlled field: typing reports each change and shows the new value', async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    function Controlled() {
      const [value, setValue] = useState('12')
      return (
        <>
          <Label htmlFor="limit">Limit</Label>
          <Input
            id="limit"
            value={value}
            onChange={(e) => {
              seen.push(e.target.value)
              setValue(e.target.value)
            }}
          />
        </>
      )
    }
    render(<Controlled />)
    const input = screen.getByRole('textbox', { name: 'Limit' })
    await user.type(input, '.5')
    expect(input).toHaveValue('12.5')
    expect(seen).toEqual(['12.', '12.5'])
  })

  it("lets a caller's className replace a default of the same kind", () => {
    render(<Input aria-label="Name" className="h-11 rounded-lg" />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input).toHaveClass('h-11', 'rounded-lg', 'border-input')
    expect(input).not.toHaveClass('h-9')
    expect(input).not.toHaveClass('rounded-md')
  })

  it('renders a file input with the upstream file-button styling', () => {
    render(<Input type="file" aria-label="Statement" />)
    const input = screen.getByLabelText('Statement')
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveClass('file:border-0', 'file:bg-transparent', 'file:text-foreground')
  })

  it('marks an invalid field with the destructive border', () => {
    render(<Input aria-label="Email" aria-invalid="true" />)
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveClass('aria-invalid:border-destructive-text')
  })
})

describe('Textarea', () => {
  it('is named by its Label, takes typing, and merges className', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <>
        <Label htmlFor="note">Note</Label>
        <Textarea id="note" onChange={onChange} className="min-h-24" />
      </>,
    )
    const textarea = screen.getByRole('textbox', { name: 'Note' })
    await user.type(textarea, 'Rent')
    expect(textarea).toHaveValue('Rent')
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(textarea).toHaveClass('min-h-24')
    expect(textarea).not.toHaveClass('min-h-16')
  })
})

describe('NativeSelect', () => {
  function Frequency({ onChange }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState('monthly')
    return (
      <>
        <Label htmlFor="frequency">Frequency</Label>
        <NativeSelect
          id="frequency"
          value={value}
          onChange={(e) => {
            onChange?.(e.target.value)
            setValue(e.target.value)
          }}
        >
          <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
          <NativeSelectOption value="monthly">Monthly</NativeSelectOption>
          <NativeSelectOptGroup label="Less often">
            <NativeSelectOption value="yearly">Yearly</NativeSelectOption>
          </NativeSelectOptGroup>
        </NativeSelect>
      </>
    )
  }

  it('is a native select named by its Label, with options and option groups', () => {
    render(<Frequency />)
    const select = screen.getByRole('combobox', { name: 'Frequency' })
    expect(select.tagName).toBe('SELECT')
    expect(select).toHaveValue('monthly')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Weekly', 'Monthly', 'Yearly'])
    expect(screen.getByRole('group', { name: 'Less often' })).toHaveAttribute('data-slot', 'native-select-optgroup')
  })

  it('changes value with userEvent.selectOptions and reports it through onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Frequency onChange={onChange} />)
    const select = screen.getByRole('combobox', { name: 'Frequency' })
    await user.selectOptions(select, 'Yearly')
    expect(select).toHaveValue('yearly')
    expect(onChange).toHaveBeenCalledWith('yearly')
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Yearly' }).selected).toBe(true)
  })

  it('hides the chevron from assistive tech', () => {
    render(<Frequency />)
    const wrapper = screen.getByRole('combobox', { name: 'Frequency' }).parentElement!
    const icon = wrapper.querySelector('[data-slot="native-select-icon"]')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it("puts className on the wrapper, so a caller can widen it, while the select fills it", () => {
    render(
      <NativeSelect aria-label="Account" className="mt-1 w-full">
        <NativeSelectOption value="a">Current</NativeSelectOption>
      </NativeSelect>,
    )
    const select = screen.getByRole('combobox', { name: 'Account' })
    const wrapper = select.parentElement!
    expect(wrapper).toHaveAttribute('data-slot', 'native-select-wrapper')
    expect(wrapper).toHaveClass('mt-1', 'w-full', 'relative')
    expect(wrapper).not.toHaveClass('w-fit')
    expect(select).toHaveClass('w-full', 'border-input')
  })

  it('applies the size variant and passes disabled through to the select', () => {
    render(
      <NativeSelect aria-label="Month" size="sm" disabled>
        <NativeSelectOption value="10">October</NativeSelectOption>
      </NativeSelect>,
    )
    const select = screen.getByRole('combobox', { name: 'Month' })
    expect(select).toHaveAttribute('data-size', 'sm')
    expect(select).toBeDisabled()
    // `size` is the variant, not the native listbox size attribute.
    expect(select).not.toHaveAttribute('size')
  })
})

describe('Checkbox', () => {
  it('is named by its Label and toggles on click and on Space', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <div className="flex items-center gap-2">
        <Checkbox id="rollover" onCheckedChange={onCheckedChange} />
        <Label htmlFor="rollover">Roll over</Label>
      </div>,
    )
    const box = screen.getByRole('checkbox', { name: 'Roll over' })
    expect(box).toHaveAttribute('aria-checked', 'false')

    await user.click(box)
    expect(box).toHaveAttribute('aria-checked', 'true')
    expect(box).toHaveAttribute('data-state', 'checked')
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)

    expect(box).toHaveFocus()
    await user.keyboard(' ')
    expect(box).toHaveAttribute('aria-checked', 'false')
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
  })

  it('toggles when its Label is clicked', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Checkbox id="essential" />
        <Label htmlFor="essential">Essential</Label>
      </>,
    )
    await user.click(screen.getByText('Essential'))
    expect(screen.getByRole('checkbox', { name: 'Essential' })).toBeChecked()
  })

  it('follows a controlled checked value', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    const { rerender } = render(<Checkbox aria-label="Paid" checked={false} onCheckedChange={onCheckedChange} />)
    const box = screen.getByRole('checkbox', { name: 'Paid' })
    await user.click(box)
    // The parent has not accepted the change yet, so the box stays as the parent says.
    expect(onCheckedChange).toHaveBeenCalledWith(true)
    expect(box).not.toBeChecked()
    rerender(<Checkbox aria-label="Paid" checked onCheckedChange={onCheckedChange} />)
    expect(box).toBeChecked()
  })

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup()
    render(<Checkbox aria-label="Locked" disabled />)
    const box = screen.getByRole('checkbox', { name: 'Locked' })
    await user.click(box)
    expect(box).not.toBeChecked()
    expect(box).toBeDisabled()
  })

  it("lets a caller's className replace the default size", () => {
    render(<Checkbox aria-label="Big" className="size-5" />)
    const box = screen.getByRole('checkbox', { name: 'Big' })
    expect(box).toHaveClass('size-5')
    expect(box).not.toHaveClass('size-4')
  })
})

describe('Switch', () => {
  it('is a named switch that toggles on click and on Space', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <>
        <Switch id="reminders" onCheckedChange={onCheckedChange} />
        <Label htmlFor="reminders">Reminders</Label>
      </>,
    )
    const toggle = screen.getByRole('switch', { name: 'Reminders' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)

    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
  })

  it('reaches the switch by Tab and toggles it from the keyboard alone', async () => {
    const user = userEvent.setup()
    render(<Switch aria-label="Dark mode" defaultChecked />)
    await user.tab()
    const toggle = screen.getByRole('switch', { name: 'Dark mode' })
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('applies the size variant to the track and thumb, and merges className', () => {
    render(<Switch aria-label="Compact" size="sm" className="shadow-none" />)
    const toggle = screen.getByRole('switch', { name: 'Compact' })
    expect(toggle).toHaveAttribute('data-size', 'sm')
    expect(toggle).toHaveClass('shadow-none')
    expect(toggle).not.toHaveClass('shadow-xs')
    expect(toggle.querySelector('[data-slot="switch-thumb"]')).toHaveClass('group-data-[size=sm]/switch:size-3')
  })

  it('defaults to the default size', () => {
    render(<Switch aria-label="Plain" />)
    expect(screen.getByRole('switch', { name: 'Plain' })).toHaveAttribute('data-size', 'default')
  })
})

describe('RadioGroup', () => {
  function Cadence({ onValueChange }: { onValueChange?: (value: string) => void }) {
    const [value, setValue] = useState('monthly')
    return (
      <RadioGroup
        aria-label="Cadence"
        value={value}
        onValueChange={(next) => {
          onValueChange?.(next)
          setValue(next)
        }}
      >
        {['weekly', 'monthly', 'yearly'].map((option) => (
          <div key={option} className="flex items-center gap-2">
            <RadioGroupItem value={option} id={`cadence-${option}`} />
            <Label htmlFor={`cadence-${option}`}>{option[0].toUpperCase() + option.slice(1)}</Label>
          </div>
        ))}
      </RadioGroup>
    )
  }

  it('is a named radiogroup of radios named by their Labels, showing the controlled value', () => {
    render(<Cadence />)
    expect(screen.getByRole('radiogroup', { name: 'Cadence' })).toHaveAttribute('data-slot', 'radio-group')
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveAttribute('aria-checked', 'false')
  })

  it('selects a radio on click and reports it through onValueChange', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Cadence onValueChange={onValueChange} />)
    await user.click(screen.getByRole('radio', { name: 'Yearly' }))
    expect(onValueChange).toHaveBeenCalledWith('yearly')
    expect(screen.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'false')
  })

  it('tabs to the checked radio, moves with the arrow keys, and selects with Space', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Cadence onValueChange={onValueChange} />)
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveFocus()

    // Radix moves focus a tick after keydown and selects only while the arrow key is still down,
    // so hold each arrow as a real keypress does (user-event would otherwise release it first).
    await user.keyboard('{ArrowDown>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Yearly' })).toHaveFocus())
    await user.keyboard('{/ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true')
    expect(onValueChange).toHaveBeenLastCalledWith('yearly')

    // Up moves back to the previous radio and selects it.
    await user.keyboard('{ArrowUp>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveFocus())
    await user.keyboard('{/ArrowUp}')
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'false')

    // Space checks the focused radio (a no-op here, as it is already checked) and never unchecks it.
    await user.keyboard(' ')
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true')
  })

  it('checks a focused but unchecked radio with Space', async () => {
    const user = userEvent.setup()
    render(
      <RadioGroup aria-label="Plan">
        <RadioGroupItem value="basic" aria-label="Basic" />
        <RadioGroupItem value="plus" aria-label="Plus" />
      </RadioGroup>,
    )
    await user.tab()
    const basic = screen.getByRole('radio', { name: 'Basic' })
    expect(basic).toHaveFocus()
    expect(basic).toHaveAttribute('aria-checked', 'false')
    await user.keyboard(' ')
    expect(basic).toHaveAttribute('aria-checked', 'true')
  })

  it("lets a caller's className replace the default gap", () => {
    render(
      <RadioGroup aria-label="Tight" className="gap-1">
        <RadioGroupItem value="a" aria-label="A" />
      </RadioGroup>,
    )
    const group = screen.getByRole('radiogroup', { name: 'Tight' })
    expect(group).toHaveClass('grid', 'gap-1')
    expect(group).not.toHaveClass('gap-3')
  })
})

describe('form building blocks and the app stylesheet', () => {
  it("leave keyboard focus to the app's global outline, and give every border a colour", () => {
    render(
      <>
        <Input aria-label="Input" />
        <Textarea aria-label="Textarea" />
        <NativeSelect aria-label="Select">
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>
        <Checkbox aria-label="Checkbox" />
        <Switch aria-label="Switch" />
        <RadioGroup aria-label="Radios">
          <RadioGroupItem value="a" aria-label="Radio" />
        </RadioGroup>
      </>,
    )
    const controls = [
      screen.getByRole('textbox', { name: 'Input' }),
      screen.getByRole('textbox', { name: 'Textarea' }),
      screen.getByRole('combobox', { name: 'Select' }),
      screen.getByRole('checkbox', { name: 'Checkbox' }),
      screen.getByRole('switch', { name: 'Switch' }),
      screen.getByRole('radio', { name: 'Radio' }),
    ]
    for (const control of controls) {
      // A focus ring would double the global outline, and outline-none cannot beat it anyway.
      expect(control.className).not.toMatch(/focus-visible:ring|outline-none|outline-hidden/)
      // There is no shadcn base layer giving a bare `border` its colour.
      expect(control).toHaveClass('border')
      expect(control.className).toMatch(/(^| )border-(input|border|transparent)( |$)/)
    }
  })
})
