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
