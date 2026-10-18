import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge, EmptyState, ErrorBanner, type BadgeTone } from './index'

// Restyle PR 20: the in-house primitives on the status tokens (--color-ok/warn/bad and their -bg),
// with no amber, violet or rose-50 left (the audit's polish row).
const OLD_PALETTE = /\b(?:dark:)?(?:bg|text|border)-(?:amber|violet|rose|teal)-\d+/

describe('ErrorBanner', () => {
  it('is an alert on the bad tone: the bad text on its tint, no rose-50 card', () => {
    render(<ErrorBanner>Could not load.</ErrorBanner>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load.')
    expect(alert).toHaveAttribute('data-tone', 'bad')
    expect(alert).toHaveClass('bg-bad-bg', 'text-bad')
    expect(alert.className).not.toMatch(OLD_PALETTE)
  })

  it('keeps the caller’s classes', () => {
    render(<ErrorBanner className="mt-4">x</ErrorBanner>)
    expect(screen.getByRole('alert')).toHaveClass('mt-4')
  })
})

describe('EmptyState', () => {
  it('is on the neutral tone: the card surface, the icon on the neutral tint, the title in the ink', () => {
    render(
      <EmptyState icon={<svg data-testid="glyph" />} title="No jars yet" description="Start from one of these.">
        <button type="button">Add</button>
      </EmptyState>,
    )
    const card = screen.getByText('No jars yet').closest('[data-empty-state]') as HTMLElement
    expect(card).toHaveClass('bg-surface', 'border-dashed')
    expect(card.className).not.toMatch(OLD_PALETTE)
    const medallion = screen.getByTestId('glyph').parentElement!
    expect(medallion).toHaveClass('rounded-full', 'bg-surface-2', 'text-slate-500')
    expect(screen.getByText('No jars yet')).toHaveClass('font-semibold', 'text-slate-900')
    expect(screen.getByText('Start from one of these.')).toHaveClass('text-slate-500')
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('Badge', () => {
  it.each([
    ['ok', ['bg-ok-bg', 'text-ok']],
    ['warn', ['bg-warn-bg', 'text-warn']],
    ['bad', ['bg-bad-bg', 'text-bad']],
    ['brand', ['bg-brand-100', 'text-brand-700']],
    ['neutral', ['bg-slate-100', 'text-slate-600']],
  ] as Array<[BadgeTone, string[]]>)('the %s tone rides its tokens', (tone, classes) => {
    render(<Badge tone={tone}>Label</Badge>)
    const badge = screen.getByText('Label')
    expect(badge).toHaveClass(...classes)
    expect(badge.className).not.toMatch(OLD_PALETTE)
  })
})
