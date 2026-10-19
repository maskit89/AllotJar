import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KpiTile } from './KpiTile'

// #344 P3-4: the strip tile's number had a trailing space in its class string (`strip="bar"`).
describe('KpiTile', () => {
  it.each([['bar'], ['bar-sub'], [true], [false]] as const)('the number’s class has no stray space (strip=%s)', (strip) => {
    render(<KpiTile label="In jars" value="€300.00" strip={strip} />)
    const value = screen.getByText('€300.00')
    expect(value.className).toBe(value.className.trim())
    if (strip === 'bar-sub') expect(value).toHaveClass('justify-self-end')
    else expect(value).not.toHaveClass('justify-self-end')
  })
})
