import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { HouseholdSummary, MeResponse } from '../types'

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under test;
  // the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: vi.fn(), delete: vi.fn() },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { HouseholdSwitcher } from './HouseholdSwitcher'
import { AuthProvider } from '../auth/AuthContext'

function me(households: HouseholdSummary[]): MeResponse {
  return { userId: 'u1', email: 'u1@x.com', displayName: 'U1', role: 0, ownerId: 'u1', memberId: null, households }
}

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HouseholdSwitcher />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('HouseholdSwitcher', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
  })

  it('is hidden when the login has a single household', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({
      data: me([{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }]),
    })

    renderSwitcher()

    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(screen.queryByLabelText('Active household')).not.toBeInTheDocument()
  })

  it('offers a switcher across two households', { timeout: 15000 }, async () => {
    mockGet.mockResolvedValue({
      data: me([
        { ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true },
        { ownerId: 'owner-a', label: 'Alex', role: 1, isActive: false, isOwn: false },
      ]),
    })

    renderSwitcher()

    const select = await screen.findByLabelText('Active household', {}, { timeout: 5000 })
    expect(select).toBeInTheDocument()
    expect(screen.getByText('Your household')).toBeInTheDocument()
    expect(screen.getByText('Alex')).toBeInTheDocument()
  })
})
