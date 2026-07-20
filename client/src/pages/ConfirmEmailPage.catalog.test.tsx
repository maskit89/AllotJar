import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Catalog: docs/testing/cases/02-registration-login.md — the confirm-email page (REG-092).
// Harness matches the repo convention: hoisted api mock, vi.mock('../lib/api') spreading
// importOriginal, page inside <MemoryRouter>.

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: vi.fn(), post: mockPost, put: vi.fn(), delete: vi.fn() },
  getToken: () => null,
}))

import { ConfirmEmailPage } from './ConfirmEmailPage'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('ConfirmEmailPage (catalog REG-092)', () => {
  it('REG-092: a valid link confirms the email (POSTs the decoded email+token) and shows success', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 })

    renderAt('/confirm-email?email=owner%40example.com&token=tok%2Babc')

    expect(await screen.findByText('Email confirmed')).toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledWith('/auth/confirm-email', {
      email: 'owner@example.com',
      token: 'tok+abc', // URL-decoded
    })
    expect(screen.getByRole('link', { name: 'Go to AllotJar' })).toHaveAttribute('href', '/')
  })

  it('REG-092: a dead link shows the expired state with a path to resend', async () => {
    mockPost.mockRejectedValueOnce(new Error('400'))

    renderAt('/confirm-email?email=owner%40example.com&token=dead')

    expect(await screen.findByText('This link has expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('REG-092: an incomplete link (no token) never calls the API', async () => {
    renderAt('/confirm-email?email=owner%40example.com')

    expect(await screen.findByText("This link isn't complete")).toBeInTheDocument()
    await waitFor(() => expect(mockPost).not.toHaveBeenCalled())
  })
})
