import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPasskey, getPasskey, passkeyError, PasskeyCancelled } from './passkeys'

// The browser half of passkeys: options from the server become the binary the WebAuthn API takes,
// and its answer becomes the toJSON() shape the server reads (base64url, no padding).
const bytes = (...b: number[]) => new Uint8Array(b).buffer

describe('passkeys', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns request options into binary and the assertion into JSON', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 'AQI',
      rawId: bytes(1, 2),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: bytes(123, 125), authenticatorData: bytes(255, 254), signature: bytes(0, 1, 2), userHandle: bytes(117) },
    })
    vi.stubGlobal('navigator', { credentials: { get } })

    const json = JSON.parse(
      await getPasskey(JSON.stringify({ challenge: '-_8', rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: 'AQI' }] })),
    )

    const publicKey = get.mock.calls[0][0].publicKey
    expect(new Uint8Array(publicKey.challenge)).toEqual(new Uint8Array([251, 255]))
    expect(new Uint8Array(publicKey.allowCredentials[0].id)).toEqual(new Uint8Array([1, 2]))
    expect(publicKey.rpId).toBe('localhost')
    expect(json).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: 'e30', authenticatorData: '__4', signature: 'AAEC', userHandle: 'dQ' },
    })
  })

  it('turns creation options into binary and the attestation into JSON', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'AQI',
      rawId: bytes(1, 2),
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: bytes(123, 125), attestationObject: bytes(160), getTransports: () => ['internal'] },
    })
    vi.stubGlobal('navigator', { credentials: { create } })

    const json = JSON.parse(await createPasskey(JSON.stringify({ challenge: 'AA', user: { id: 'dQ', name: 'a@b.c' } })))

    expect(new Uint8Array(create.mock.calls[0][0].publicKey.user.id)).toEqual(new Uint8Array([117]))
    expect(json.response).toEqual({ clientDataJSON: 'e30', attestationObject: 'oA', transports: ['internal'] })
  })

  it('treats a closed prompt as nothing to say', () => {
    expect(passkeyError(new DOMException('x', 'NotAllowedError'))).toBeNull()
    expect(passkeyError(new PasskeyCancelled())).toBeNull()
    expect(passkeyError(new DOMException('x', 'InvalidStateError'))).toBe('This device already has a passkey for AllotJar.')
    expect(passkeyError(new Error('boom'))).toBe("That passkey didn't work. Try again.")
  })
})
