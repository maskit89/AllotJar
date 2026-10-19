import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// A controllable stand-in for the build-time env flag. The getter is read on every
// render, so flipping `state.isStaging` between tests toggles the banner without
// resetting modules (which would create a second React copy).
const state = vi.hoisted(() => ({ isStaging: false }))
vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return state.isStaging
  },
  get APP_ENV() {
    return state.isStaging ? 'staging' : undefined
  },
}))

import { StagingBanner } from './StagingBanner'

beforeEach(() => {
  cleanup()
  state.isStaging = false
})

describe('StagingBanner', () => {
  it('renders nothing in the production/default build', () => {
    render(<StagingBanner />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('warns, in one line on the warn tone, that the data here may be reset in the staging build', () => {
    state.isStaging = true
    render(<StagingBanner />)
    const strip = screen.getByRole('status')
    expect(strip).toHaveTextContent('Staging · test data, may be reset')
    expect(strip).toHaveAttribute('data-tone', 'warn')
    // One line: no second sentence, no (i), no action.
    expect(strip.textContent).not.toMatch(/\. /)
    expect(strip.querySelector('button')).toBeNull()
  })
})
