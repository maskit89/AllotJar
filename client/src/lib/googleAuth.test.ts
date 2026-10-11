import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The Google Identity Services wrapper (restyle PR 9): it initialises Google once per page, passes
// the button options the sign-in card sets (theme, pill shape, width) straight through, redraws in
// place, and routes Google's credential to the latest button's callback.

type Gsi = {
  initialize: ReturnType<typeof vi.fn>
  renderButton: ReturnType<typeof vi.fn>
}

async function loadWith(clientId: string) {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId)
  return import('./googleAuth')
}

let gsi: Gsi

beforeEach(() => {
  gsi = { initialize: vi.fn(), renderButton: vi.fn() }
  ;(window as unknown as { google: unknown }).google = { accounts: { id: gsi } }
})

afterEach(() => {
  vi.unstubAllEnvs()
  delete (window as unknown as { google?: unknown }).google
})

describe('renderGoogleButton', () => {
  it('initialises once, forwards the options and redraws into a cleared container', async () => {
    const { renderGoogleButton } = await loadWith('client-1')
    const el = document.createElement('div')
    el.innerHTML = '<span>stale</span>'

    await renderGoogleButton(el, vi.fn(), { theme: 'outline', shape: 'pill', width: 356 })
    expect(el.innerHTML).toBe('')
    await renderGoogleButton(el, vi.fn(), { theme: 'filled_black', shape: 'pill', width: 350 })

    expect(gsi.initialize).toHaveBeenCalledTimes(1)
    expect(gsi.initialize.mock.calls[0][0]).toMatchObject({ client_id: 'client-1', use_fedcm_for_prompt: true })
    expect(gsi.renderButton).toHaveBeenCalledTimes(2)
    expect(gsi.renderButton.mock.calls[0]).toEqual([
      el,
      { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 356, logo_alignment: 'center' },
    ])
    expect(gsi.renderButton.mock.calls[1][1]).toMatchObject({ theme: 'filled_black', shape: 'pill', width: 350 })
  })

  it('keeps the old defaults when no options are given', async () => {
    const { renderGoogleButton } = await loadWith('client-1')
    await renderGoogleButton(document.createElement('div'), vi.fn())
    expect(gsi.renderButton.mock.calls[0][1]).toMatchObject({ theme: 'outline', shape: 'rectangular', text: 'continue_with', size: 'large' })
  })

  it("hands Google's credential to the latest button's callback", async () => {
    const { renderGoogleButton } = await loadWith('client-1')
    const first = vi.fn()
    const second = vi.fn()
    await renderGoogleButton(document.createElement('div'), first)
    await renderGoogleButton(document.createElement('div'), second)

    const { callback } = gsi.initialize.mock.calls[0][0] as { callback: (r: { credential: string }) => void }
    callback({ credential: 'signed-token' })
    expect(second).toHaveBeenCalledWith('signed-token')
    expect(first).not.toHaveBeenCalled()
  })

  it('refuses without a client id', async () => {
    const { renderGoogleButton } = await loadWith('')
    await expect(renderGoogleButton(document.createElement('div'), vi.fn())).rejects.toThrow(/not configured/)
    expect(gsi.renderButton).not.toHaveBeenCalled()
  })
})
