import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Catalog coverage for docs/testing/cases/02-registration-login.md — the Google sign-in button
// shell (REG-080): renders Google's container + reports readiness when configured, renders
// NOTHING without a client id, and degrades to nothing when the GSI script fails — so the
// password card never shows an orphaned divider or a dead button.

const { state } = vi.hoisted(() => ({
  state: {
    clientId: 'client-123.apps.googleusercontent.com',
    render: vi.fn<(el: HTMLElement, cb: (c: string) => void, opts?: unknown) => Promise<void>>(),
  },
}))

vi.mock('../lib/googleAuth', () => ({
  get GOOGLE_CLIENT_ID() {
    return state.clientId
  },
  renderGoogleButton: (el: HTMLElement, cb: (c: string) => void, opts?: unknown) =>
    state.render(el, cb, opts),
}))

import { GoogleSignInButton } from './GoogleSignInButton'

beforeEach(() => {
  vi.clearAllMocks()
  state.clientId = 'client-123.apps.googleusercontent.com'
})

describe('GoogleSignInButton (catalog REG-080)', () => {
  it('REG-080: renders the container, reports ready, and forwards the credential', async () => {
    let capturedCallback: ((c: string) => void) | undefined
    state.render.mockImplementation((_el, cb) => {
      capturedCallback = cb
      return Promise.resolve()
    })
    const onCredential = vi.fn()
    const onReady = vi.fn()

    render(<GoogleSignInButton onCredential={onCredential} onReady={onReady} />)

    await waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(screen.getByTestId('google-signin')).toBeInTheDocument()

    // Google's iframe hands back the signed credential — it must reach the caller verbatim.
    capturedCallback!('signed-credential-abc')
    expect(onCredential).toHaveBeenCalledWith('signed-credential-abc')
  })

  it('REG-080: renders nothing at all without a configured client id', () => {
    state.clientId = ''

    const { container } = render(<GoogleSignInButton onCredential={vi.fn()} onReady={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
    expect(state.render).not.toHaveBeenCalled()
  })

  it('REG-080: degrades to nothing when the GSI script fails to load', async () => {
    state.render.mockRejectedValue(new Error('blocked'))
    const onReady = vi.fn()

    const { container } = render(<GoogleSignInButton onCredential={vi.fn()} onReady={onReady} />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(onReady).not.toHaveBeenCalled()
  })
})
