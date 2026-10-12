import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { JarAllocationFields } from './JarAllocationFields'
import { PaidFromJarSelect } from './PaidFromJarSelect'
import { fromJarAllocations, jarAllocationsTotal, toJarAllocations } from '../../lib/jarAllocationFields'

const jars = [
  { jarId: 'j1', name: 'Holiday', balance: 400, isArchived: false },
  { jarId: 'j2', name: 'Car', balance: 300, isArchived: false },
]

describe('JarAllocationFields (rule 78)', () => {
  it('shows each jar with its balance in major units and the unallocated remainder', () => {
    const onChange = vi.fn()
    render(
      <JarAllocationFields jars={jars} accountName="Savings" currency="EUR" amount={500} value={{ j1: '300' }} onChange={onChange} idPrefix="t" />,
    )
    expect(screen.getByText('(€400.00)')).toBeInTheDocument()
    expect(screen.getByText('Stays unallocated: €200.00')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Amount for Car'), { target: { value: '200' } })
    expect(onChange).toHaveBeenCalledWith({ j1: '300', j2: '200' })
  })

  it('flags jar amounts that exceed what arrived', () => {
    render(<JarAllocationFields jars={jars} accountName="Savings" currency="EUR" amount={100} value={{ j1: '300' }} onChange={() => {}} idPrefix="t" />)
    expect(screen.getByText('The jar amounts exceed the €100.00 received.')).toBeInTheDocument()
  })

  // The `look="dialog"` opt-in (the Allocation page's Allocate dialog, restyle PR 10).
  it('left as it is: the framed prompt with its visible legend and note, and no (i)', () => {
    render(<JarAllocationFields jars={jars} accountName="Savings" currency="EUR" amount={500} value={{}} onChange={() => {}} idPrefix="t" />)
    const legend = screen.getByText('Put into jars in Savings')
    expect(legend.tagName).toBe('LEGEND')
    expect(legend.className).not.toContain('sr-only')
    expect(screen.getByTestId('t-jar-allocation').className).toContain('border-slate-300')
    expect(screen.getByText(/Leave a jar empty to keep that money unallocated/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'About putting it into jars' })).not.toBeInTheDocument()
    expect(screen.queryByText('Into jars')).not.toBeInTheDocument()
  })

  it('the dialog look: "Into jars" with an (i), each jar with what it holds, and what stays unallocated', async () => {
    const onChange = vi.fn()
    render(
      <JarAllocationFields
        look="dialog"
        hint="Alex’s €500.00 lands in Savings."
        jars={[...jars, { jarId: 'j3', name: 'Old', balance: 0, isArchived: true }]}
        accountName="Savings"
        currency="EUR"
        amount={500}
        value={{ j1: '300' }}
        onChange={onChange}
        idPrefix="t"
      />,
    )
    // The fieldset keeps its full name; the visible heading is short.
    expect(screen.getByRole('group', { name: 'Put into jars in Savings' })).toBe(screen.getByTestId('t-jar-allocation'))
    expect(screen.getByText('Into jars')).toBeInTheDocument()
    expect(screen.getByText('Put into jars in Savings').className).toContain('sr-only')
    // The note is behind the (i), after the caller's sentence.
    fireEvent.focus(screen.getByRole('button', { name: 'About putting it into jars' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Alex’s €500.00 lands in Savings.Put into jars in Savings. Leave a jar empty to keep that money unallocated. You can allocate it later from the Jars page.',
    )
    expect(screen.getByText('€400.00').parentElement).toHaveTextContent('holds €400.00')
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByText(/^Stays unallocated/).parentElement).toHaveTextContent('Stays unallocated: €200.00')
    fireEvent.change(screen.getByLabelText('Amount for Car'), { target: { value: '200' } })
    expect(onChange).toHaveBeenCalledWith({ j1: '300', j2: '200' })
  })

  it('the dialog look: the (i) can take a name of its own (one per person in a dialog with several), and opens against the screen', () => {
    render(
      <JarAllocationFields
        look="dialog"
        hintLabel="About putting Sam’s share into jars"
        jars={jars}
        accountName="Sam Pot"
        currency="EUR"
        amount={100}
        value={{}}
        onChange={() => {}}
        idPrefix="s"
      />,
    )
    expect(screen.queryByRole('button', { name: 'About putting it into jars' })).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About putting Sam’s share into jars' }))
    // Placed against the screen: a dialog's scrolling middle can't cut it off.
    expect(screen.getByRole('tooltip').parentElement).toHaveClass('fixed')
  })

  it('parses, totals and round-trips the typed amounts', () => {
    expect(toJarAllocations({ j1: '300', j2: '', j3: '0' })).toEqual([{ jarId: 'j1', amount: 300 }])
    expect(jarAllocationsTotal({ j1: '300', j2: '200.5' })).toBe(500.5)
    expect(jarAllocationsTotal({ j1: 'abc' })).toBeNull()
    expect(fromJarAllocations([{ jarId: 'j1', amount: 300 }])).toEqual({ j1: '300' })
  })
})

describe('PaidFromJarSelect (rule 79)', () => {
  it('defaults to unallocated and lists the jars with major-unit balances', () => {
    const onChange = vi.fn()
    render(<PaidFromJarSelect jars={jars} accountName="Savings" currency="EUR" value="" onChange={onChange} id="p" />)
    const select = screen.getByLabelText('Which jar in Savings does this come from?')
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Holiday (€400.00)' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'j2' } })
    expect(onChange).toHaveBeenCalledWith('j2')
  })
})
