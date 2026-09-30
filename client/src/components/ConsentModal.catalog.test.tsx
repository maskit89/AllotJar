import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Catalog coverage for docs/testing/cases/03-session-auth-lifecycle.md (SESS-*),
// the pure session-lifecycle surfaces of the blocking ConsentModal. These
// COMPLEMENT ConsentModal.test.tsx (hidden when already consented; success path;
// the "Sign out" affordance exists; no close control; never covers legal pages)
// and DO NOT duplicate them — here: the consent-POST-failure error banner
// (SESS-041) and clicking "Sign out" as the logout exit (SESS-042).
//
// Harness matches ConsentModal.test.tsx: the shared api mock with getToken → a live token so
// AuthProvider treats the session as signed in and loads /auth/me.

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => 'tok',
  }),
)

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { ConsentModal } from './ConsentModal'

function me(needsConsent: boolean) {
  return {
    data: {
      userId: 'u2',
      email: 'sam@x.com',
      displayName: 'Sam',
      role: 1,
      ownerId: 'owner-1',
      memberId: null,
      needsConsent,
    },
  }
}

const renderModal = (path = '/') => renderWithProviders(<ConsentModal />, { route: path })

describe('SESS: ConsentModal session-side surfaces', () => {
  beforeEach(() => {
    localStorage.clear()
    resetApiMocks()
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
    localStorage.setItem('zbb.email', 'sam@x.com')
    localStorage.setItem('zbb.role', '1')
    localStorage.setItem('zbb.displayName', 'Sam')
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
