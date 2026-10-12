import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MemberAvatar } from './MemberAvatar'

// MemberAvatar's `color` opt-in (the Account settings page, restyle PR 12: steel for a sign-in not
// linked to a person). Left out, the member hue's colour tints it, as on every other page.
describe('MemberAvatar', () => {
  it('left as it is: the initial on the hue’s tint, decorative', () => {
    const { container } = render(<MemberAvatar name="sam" hue="indigo" />)
    const avatar = container.firstElementChild as HTMLElement
    expect(avatar).toHaveAttribute('aria-hidden')
    expect(avatar).toHaveTextContent('S')
    expect(avatar.className).toContain('size-[30px]')
    expect(avatar.style.background).toContain('var(--color-cat-indigo)')
    expect(avatar.style.color).toContain('var(--color-cat-indigo)')
  })

  it('with `color`: that colour tints it in place of the hue', () => {
    const { container } = render(<MemberAvatar name="Alex" hue="emerald" color="var(--color-steel)" className="size-16" />)
    const avatar = container.firstElementChild as HTMLElement
    expect(avatar).toHaveTextContent('A')
    expect(avatar.style.background).toContain('var(--color-steel)')
    expect(avatar.style.background).not.toContain('cat-emerald')
    expect(avatar.style.boxShadow).toContain('var(--color-steel)')
  })
})
