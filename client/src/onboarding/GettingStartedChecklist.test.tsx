import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'

// #301 P3-4b: the checklist read today once, when the module loaded, so a tab left open over a
// month's end kept asking about the old month. It reads today's month on every check.
vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
vi.mock('./OnboardingContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./OnboardingContext')>()),
  useOnboarding: () => ({ dismissChecklist: () => {} }),
}))

import { mockGet, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { GettingStartedChecklist } from './GettingStartedChecklist'

describe('GettingStartedChecklist: the month it asks about', () => {
  beforeEach(() => {
    resetApiMocks()
    mockGet.mockResolvedValue({ data: [] })
  })

  it('asks about the new month once the month has turned', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:00:00Z'))
    renderWithProviders(<GettingStartedChecklist />)
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/budget/2026/10'))

    vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
    await act(async () => {
      fireEvent.focus(window)
    })

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/budget/2026/11'))
  })
})
