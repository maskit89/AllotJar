import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/03-session-auth-lifecycle.md (SESS-*),
// the pure session-lifecycle surfaces of the blocking ConsentModal. These
// COMPLEMENT ConsentModal.test.tsx (hidden when already consented; success path;
// the "Sign out" affordance exists; no close control; never covers legal pages)
// and DO NOT duplicate them — here: the consent-POST-failure error banner
// (SESS-041) and clicking "Sign out" as the logout exit (SESS-042).
//
// Harness matches ConsentModal.test.tsx: hoisted api mock fns, vi.mock('../lib/api')
// spreading importOriginal, getToken → a live token so AuthProvider treats the
// session as signed in and loads /auth/me.

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost },
  getToken: () => 'tok',
  setToken: vi.fn(),
}))

import { ConsentModal } from './ConsentModal'
import { AuthProvider } from '../auth/AuthContext'

function me(needsConsent: boolean) {
  return {
    data: {
      userId: 'u2',
      email: 'liza@x.com',
      displayName: 'Liza',
      role: 1,
      ownerId: 'owner-1',
      memberId: null,
      needsConsent,
    },
  }
}

function renderModal(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <ConsentModal />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('SESS: ConsentModal session-side surfaces', () => {
  beforeEach(() => {
    localStorage.clear()
    mockGet.mockReset()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: {} })
  })

  // SESS-041 — when POST /auth/consent fails, onAgree's catch shows the EXACT error
  // banner and the dialog stays open and blocking (needsConsent is NOT cleared — the
  // session is neither let in nor signed out). A later successful retry unblocks.
  it('SESS-041: a failed consent POST shows the exact error banner and keeps the dialog blocking, then a retry unblocks', async () => {
    mockGet.mockResolvedValue(me(true))
    mockPost.mockRejectedValueOnce(new Error('500')) // the consent POST fails once
    const user = userEvent.setup()
    renderModal()

    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'I agree' }))

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent('Something went wrong saving your agreement — please try again.')
    expect(screen.getByRole('dialog')).toBeInTheDocument() // still blocking

    // Retry: the default resolved mock records consent → alert + dialog disappear.
    await user.click(screen.getByRole('button', { name: 'I agree' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // SESS-042 — "Sign out" on the blocking prompt is wired straight to useAuth().logout:
  // it fires POST /auth/logout, wipes the identity hints, resets needsConsent, and the
  // now-unauthenticated dialog unmounts. (The full logout semantics are SESS-037.)
  it('SESS-042: "Sign out" runs logout — POST /auth/logout, identity hints wiped, blocking dialog unmounts', async () => {
    mockGet.mockResolvedValue(me(true))
    // Identity hints a signed-in session would have stored (apply() writes these).
    localStorage.setItem('zbb.email', 'liza@x.com')
    localStorage.setItem('zbb.role', '1')
    localStorage.setItem('zbb.displayName', 'Liza')
    const user = userEvent.setup()
    renderModal()

    await screen.findByRole('dialog', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/logout'), { timeout: 5000 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(localStorage.getItem('zbb.email')).toBeNull()
    expect(localStorage.getItem('zbb.role')).toBeNull()
    expect(localStorage.getItem('zbb.displayName')).toBeNull()
  })
})
