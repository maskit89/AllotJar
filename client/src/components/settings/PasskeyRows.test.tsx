import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api', async (importOriginal) => (await import('../../test/apiMock')).apiModule(importOriginal))
const createPasskey = vi.fn()
const getPasskey = vi.fn()
vi.mock('../../lib/passkeys', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  passkeysSupported: () => true,
  createPasskey: (...a: unknown[]) => createPasskey(...a),
  getPasskey: (...a: unknown[]) => getPasskey(...a),
}))

import { mockGet, mockPost, resetApiMocks } from '../../test/apiMock'
import { renderWithProviders } from '../../test/render'
import { ownerMe } from '../../test/fixtures/me'
import { PasskeyRows } from './PasskeyRows'

// The Sign-in card's passkey rows: adding one (the first shows the recovery codes once), removing
// one, new codes, and Confirm it's you when the server asks for proof first.
const none = { passkeys: [], recoveryCodesLeft: 0 }
const one = {
  passkeys: [{ id: 'cred-1', name: 'Safari on iPhone', createdUtc: '2026-10-12T08:00:00Z' }],
  recoveryCodesLeft: 2,
}
const codes = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`)
const proofAsked = (kinds: object) => ({ isAxiosError: true, response: { status: 403, data: { error: "Confirm it's you first.", proof: kinds } } })

let listed: object
function answerGets() {
  mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/auth/passkeys' ? listed : ownerMe }))
}

describe('PasskeyRows', () => {
  beforeEach(() => {
    resetApiMocks()
    createPasskey.mockReset()
    getPasskey.mockReset()
    listed = none
    answerGets()
  })

  it('offers to add a passkey when there is none', async () => {
    renderWithProviders(<PasskeyRows />)
    expect(await screen.findByRole('button', { name: 'Add a passkey' })).toBeInTheDocument()
    expect(screen.queryByText('On')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Recovery codes' })).not.toBeInTheDocument()
  })

  it('adds the first passkey and shows its recovery codes once', async () => {
    mockPost.mockImplementation((url: string) => {
      if (url === '/auth/passkeys/options') return Promise.resolve({ data: { ceremony: 'c1', options: '{"x":1}' } })
      if (url === '/auth/passkeys') {
        listed = one
        return Promise.resolve({ data: { passkey: one.passkeys[0], recoveryCodes: codes } })
      }
      return Promise.reject(new Error(url))
    })
    createPasskey.mockResolvedValue('{"id":"cred-1"}')
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))

    expect(createPasskey).toHaveBeenCalledWith('{"x":1}')
    expect(mockPost).toHaveBeenCalledWith('/auth/passkeys', { ceremony: 'c1', credential: '{"id":"cred-1"}' })
    const dialog = await screen.findByRole('dialog', { name: 'Save your recovery codes' })
    expect(within(within(dialog).getByRole('list', { name: 'Recovery codes' })).getAllByRole('listitem')).toHaveLength(10)
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Safari on iPhone' })).toBeInTheDocument()
    expect(screen.getByText('2 left')).toBeInTheDocument()
  })

  it('says nothing when the device prompt is closed', async () => {
    mockPost.mockResolvedValue({ data: { ceremony: 'c1', options: '{}' } })
    createPasskey.mockRejectedValue(new DOMException('closed', 'NotAllowedError'))
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalledWith('/auth/passkeys', expect.anything())
  })

  it('asks for the password first when the server wants proof, then adds the passkey', async () => {
    let asked = false
    mockPost.mockImplementation((url: string, body: { proof?: { password?: string } }) => {
      if (url === '/auth/passkeys/options') {
        if (!body.proof) {
          asked = true
          return Promise.reject(proofAsked({ password: true, passkey: false, recoveryCode: false }))
        }
        return Promise.resolve({ data: { ceremony: 'c2', options: '{}' } })
      }
      return Promise.resolve({ data: { passkey: one.passkeys[0], recoveryCodes: codes } })
    })
    createPasskey.mockResolvedValue('{}')
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))
    expect(asked).toBe(true)
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await user.type(within(dialog).getByLabelText('Password'), 'my-password')
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }))

    expect(mockPost).toHaveBeenCalledWith('/auth/passkeys/options', { proof: { password: 'my-password' } })
    expect(await screen.findByRole('dialog', { name: 'Save your recovery codes' })).toBeInTheDocument()
  })

  it('removes a passkey after asking, proving it with the passkey when the server wants proof', async () => {
    listed = one
    answerGets()
    mockPost.mockImplementation((url: string, body?: { proof?: object }) => {
      if (url === '/auth/passkeys/cred-1/remove') {
        if (!body?.proof) return Promise.reject(proofAsked({ password: true, passkey: true, recoveryCode: true }))
        listed = none
        return Promise.resolve({ status: 204 })
      }
      if (url === '/auth/passkeys/proof-options') return Promise.resolve({ data: { ceremony: 'p1', options: '{"p":1}' } })
      return Promise.reject(new Error(url))
    })
    getPasskey.mockResolvedValue('{"assert":1}')
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'Remove passkey Safari on iPhone' }))
    const confirm = await screen.findByRole('dialog', { name: 'Remove this passkey?' })
    expect(confirm).toHaveTextContent('Signing in will no longer ask for a passkey')
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }))

    const proof = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await user.click(within(proof).getByRole('button', { name: 'Use passkey' }))

    expect(mockPost).toHaveBeenCalledWith('/auth/passkeys/cred-1/remove', { proof: { ceremony: 'p1', credential: '{"assert":1}' } })
    expect(await screen.findByRole('button', { name: 'Add a passkey' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('makes new recovery codes and shows them', async () => {
    listed = one
    answerGets()
    mockPost.mockResolvedValue({ data: { recoveryCodes: codes } })
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'New codes' }))
    expect(mockPost).toHaveBeenCalledWith('/auth/passkeys/recovery-codes', { proof: undefined })
    expect(await screen.findByRole('dialog', { name: 'Save your recovery codes' })).toBeInTheDocument()
  })

  it('asks a Google-only login with no passkey to sign in again', async () => {
    mockPost.mockRejectedValue(proofAsked({ password: false, passkey: false, recoveryCode: false }))
    const user = userEvent.setup()
    renderWithProviders(<PasskeyRows />)

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign in again' })
    expect(within(dialog).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument()
  })
})
