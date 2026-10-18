import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Notice, NoticeAction } from './Notice'

// The app's one banner (restyle PR 17): one line on a tone, an optional (i), one quiet action, a ✕.
describe('Notice', () => {
  it('is one line on the given tone, exposed as data-tone, with no controls unless given', () => {
    const { container } = render(<Notice tone="warn">Confirm your email: check your inbox for the link.</Notice>)
    const banner = container.firstElementChild!
    expect(banner).toHaveAttribute('data-tone', 'warn')
    expect(banner).toHaveTextContent('Confirm your email: check your inbox for the link.')
    expect(banner.querySelectorAll('button')).toHaveLength(0)
    // The tone's icon is decorative.
    expect(banner.querySelector('svg')?.closest('[aria-hidden]')).not.toBeNull()
  })

  it.each(['info', 'warn', 'bad', 'ok'] as const)('draws the %s tone', (tone) => {
    const { container } = render(<Notice tone={tone}>Line</Notice>)
    expect(container.firstElementChild).toHaveAttribute('data-tone', tone)
  })

  it('keeps the detail behind an (i) named by hintLabel', async () => {
    const user = userEvent.setup()
    render(
      <Notice tone="info" hint="The whole story." hintLabel="About this line">
        One line.
      </Notice>,
    )
    expect(screen.queryByText('The whole story.')).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About this line' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('The whole story.')
  })

  it('places one quiet action and a ✕ that dismisses', async () => {
    const user = userEvent.setup()
    const onAct = vi.fn()
    const onDismiss = vi.fn()
    render(
      <Notice tone="ok" role="status" action={<NoticeAction onClick={onAct}>Resend</NoticeAction>} onDismiss={onDismiss}>
        Done.
      </Notice>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Done.')
    await user.click(screen.getByRole('button', { name: 'Resend' }))
    expect(onAct).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('the strip variant is the sticky full-width band (the staging banner), still one line', () => {
    const { container } = render(
      <Notice variant="strip" tone="warn" role="status">
        Staging · test data, may be reset
      </Notice>,
    )
    const strip = container.firstElementChild!
    expect(strip).toHaveAttribute('data-tone', 'warn')
    expect(strip).toHaveClass('sticky')
    expect(strip).toHaveTextContent('Staging · test data, may be reset')
    expect(strip.querySelectorAll('button')).toHaveLength(0)
  })
})
