import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    refreshSession: () => Promise.resolve(null),
  }),
)
const getPasskey = vi.fn()
vi.mock('../lib/passkeys', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  passkeysSupported: () => true,
  getPasskey: (...a: unknown[]) => getPasskey(...a),
}))

import { mockGet, mockPost, mockSetToken, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { LoginPage } from './LoginPage'

// Two-factor sign-in on the sign-in page (fix 14): "Sign in with a passkey", and the passkey step a
// password sign-in leads to for a login that has one, with a recovery code as the way round.
const session = { token: 'tok', expiresAtUtc: '2030-01-01T00:00:00Z', userId: 'u1', email: 'sam@x.com', role: 0, displayName: null }
const step = { passkeyRequired: true, ticket: 't1', options: '{"challenge":"abc"}' }

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<div>HOME</div>} />
    </Routes>,
    { route: '/login' },
  )
}

async function signInWithPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'sam@x.com')
  await user.type(screen.getByLabelText('Password'), 'password123')
  const submit = screen.getAllByRole('button', { name: 'Sign in' }).find((b) => b.getAttribute('type') === 'submit')!
  await user.click(submit)
}

describe('LoginPage passkeys', () => {
  beforeEach(() => {
    resetApiMocks()
    getPasskey.mockReset()
    mockGet.mockResolvedValue({ data: { userId: 'u1', email: 'sam@x.com', role: 0, ownerId: 'u1' } })
  })

  it('asks for the passkey after a right password, and signs in once it answers', async () => {
    mockPost.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/auth/login' ? step : session }),
    )
    getPasskey.mockResolvedValue('{"id":"cred"}')
    const user = userEvent.setup()
    renderPage()

    await signInWithPassword(user)
    expect(await screen.findByRole('heading', { name: 'Confirm with your passkey' })).toBeInTheDocument()
    expect(mockSetToken).not.toHaveBeenCalledWith('tok', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Use passkey' }))
    expect(getPasskey).toHaveBeenCalledWith('{"challenge":"abc"}')
    expect(mockPost).toHaveBeenCalledWith('/auth/second-step/passkey', { ticket: 't1', credential: '{"id":"cred"}' })
    expect(await screen.findByText('HOME')).toBeInTheDocument()
  })

  it('takes a recovery code instead', async () => {
    mockPost.mockImplementation((url: string) => Promise.resolve({ data: url === '/auth/login' ? step : session }))
    const user = userEvent.setup()
    renderPage()

    await signInWithPassword(user)
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }))
    await user.type(screen.getByLabelText('Recovery code'), 'abcde-fghjk')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(mockPost).toHaveBeenCalledWith('/auth/second-step/recovery-code', { ticket: 't1', code: 'abcde-fghjk' })
    expect(await screen.findByText('HOME')).toBeInTheDocument()
  })

  it('says why a wrong code failed, and goes back to sign-in when the ticket ran out', async () => {
    let tries = 0
    mockPost.mockImplementation((url: string) => {
      if (url === '/auth/login') return Promise.resolve({ data: step })
      tries++
      return Promise.reject({
        isAxiosError: true,
        response: { status: 401, data: tries === 1 ? { error: "That code isn't right, or it was used already." } : { error: 'That took too long.', restart: true } },
      })
    })
    const user = userEvent.setup()
    renderPage()

    await signInWithPassword(user)
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }))
    await user.type(screen.getByLabelText('Recovery code'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That code isn't right")

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByLabelText('Password')).toHaveValue('')
    expect(screen.queryByRole('heading', { name: 'Enter a recovery code' })).not.toBeInTheDocument()
  })

  it('signs in with a passkey alone', async () => {
    mockPost.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/auth/passkey-sign-in/options' ? { ceremony: 'c1', options: '{"o":1}' } : session }),
    )
    getPasskey.mockResolvedValue('{"id":"cred"}')
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
    expect(mockPost).toHaveBeenCalledWith('/auth/passkey-sign-in', { ceremony: 'c1', credential: '{"id":"cred"}' })
    expect(await screen.findByText('HOME')).toBeInTheDocument()
  })

  it('says nothing when the passkey prompt is closed', async () => {
    mockPost.mockResolvedValue({ data: { ceremony: 'c1', options: '{}' } })
    getPasskey.mockRejectedValue(new DOMException('closed', 'NotAllowedError'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled()
  })
})
