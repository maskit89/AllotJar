import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// A controllable stand-in for the build-time env flag. The getter is read on every
// render, so flipping `state.isBeta` between tests toggles the banner without
// resetting modules (which would create a second React copy).
const state = vi.hoisted(() => ({ isBeta: false }))
vi.mock('../lib/env', () => ({
  get IS_BETA() {
    return state.isBeta
  },
  get APP_ENV() {
    return state.isBeta ? 'beta' : undefined
  },
}))

import { BetaBanner } from './BetaBanner'

beforeEach(() => {
  cleanup()
  state.isBeta = false
})

describe('BetaBanner', () => {
  it('renders nothing in the production/default build', () => {
    render(<BetaBanner />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('warns that data may be lost in the beta build', () => {
    state.isBeta = true
    render(<BetaBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(/data can be reset or lost/i)
  })
})
