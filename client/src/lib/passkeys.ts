import axios from 'axios'

/*
 * Passkeys in the browser (two-factor sign-in, compliance fix 14). The server hands over WebAuthn
 * options as JSON with binary fields in base64url; the browser's own parse/toJSON helpers are too
 * new for the iPhones and Androids we support (iOS 16+), so the conversion is done here.
 */

/** The step after a password, Google or reset sign-in for a login that has a passkey. */
export interface SecondStep {
  ticket: string
  /** WebAuthn request options, JSON. */
  options: string
}

/** True where this browser can use a passkey at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials
}

function fromB64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return bytes.buffer
}

function toB64Url(buffer: ArrayBuffer | null | undefined): string | null {
  if (!buffer) return null
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Descriptor = { type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }

function descriptors(list: Descriptor[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({ ...d, id: fromB64Url(d.id) }))
}

/** The browser's reply as the server reads it (the WebAuthn PublicKeyCredential toJSON() shape). */
function credentialJson(credential: PublicKeyCredential): string {
  const response = credential.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse
  const body: Record<string, unknown> = { clientDataJSON: toB64Url(response.clientDataJSON) }
  if ('attestationObject' in response && response.attestationObject) {
    body.attestationObject = toB64Url(response.attestationObject)
    body.transports = typeof response.getTransports === 'function' ? response.getTransports() : []
  } else {
    body.authenticatorData = toB64Url(response.authenticatorData)
    body.signature = toB64Url(response.signature)
    body.userHandle = toB64Url(response.userHandle)
  }
  return JSON.stringify({
    id: credential.id,
    rawId: toB64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: body,
  })
}

/** Asks the device for a passkey that answers these request options; resolves to the credential JSON. */
export async function getPasskey(optionsJson: string): Promise<string> {
  const options = JSON.parse(optionsJson)
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromB64Url(options.challenge),
      allowCredentials: descriptors(options.allowCredentials),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new PasskeyCancelled()
  return credentialJson(credential)
}

/** Asks the device to make a passkey for these creation options; resolves to the credential JSON. */
export async function createPasskey(optionsJson: string): Promise<string> {
  const options = JSON.parse(optionsJson)
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromB64Url(options.challenge),
      user: { ...options.user, id: fromB64Url(options.user.id) },
      excludeCredentials: descriptors(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new PasskeyCancelled()
  return credentialJson(credential)
}

/** The person closed the device's prompt, or it timed out: say nothing, let them try again. */
export class PasskeyCancelled extends Error {
  constructor() {
    super('The passkey prompt was closed.')
    this.name = 'PasskeyCancelled'
  }
}

/**
 * What to show when a passkey step fails: null when the person just closed the prompt (the
 * browser's NotAllowedError), the server's own words when it answered, else a plain retry line.
 */
export function passkeyError(err: unknown, fallback = "That passkey didn't work. Try again."): string | null {
  if (err instanceof PasskeyCancelled) return null
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return null
    if (err.name === 'InvalidStateError') return 'This device already has a passkey for AllotJar.'
    return fallback
  }
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined
    return data?.error ?? fallback
  }
  return fallback
}

