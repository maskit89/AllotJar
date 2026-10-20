import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api', async (importOriginal) => (await import('../../test/apiMock')).apiModule(importOriginal))

import { mockDelete, mockGet, mockPost, resetApiMocks } from '../../test/apiMock'
import { renderWithProviders } from '../../test/render'
import { ownerMe } from '../../test/fixtures/me'
import { lastActive } from '../../lib/lastActive'
import { DevicesCard, type SignedInDevice } from './DevicesCard'

// Account settings' Devices card: where the login is signed in, signing one device out, and signing
// out everywhere (which asks first, then leaves for the sign-in page).
const devices: SignedInDevice[] = [
  { id: 'a', device: 'AllotJar app on iPhone', startedUtc: '2026-10-01T08:00:00Z', lastActiveUtc: '2026-10-15T09:00:00Z', current: true },
  { id: 'b', device: 'Chrome on Windows', startedUtc: '2026-09-20T08:00:00Z', lastActiveUtc: '2026-10-12T18:00:00Z', current: false },
  { id: 'c', device: null, startedUtc: '2026-09-01T08:00:00Z', lastActiveUtc: '2026-10-14T07:00:00Z', current: false },
]

describe('DevicesCard', () => {
  const assign = vi.fn()

  beforeEach(() => {
    resetApiMocks()
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    mockGet.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/auth/sessions' ? devices : ownerMe }),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lists each device, this one first without a sign-out of its own', async () => {
    renderWithProviders(<DevicesCard />)

    await screen.findByRole('heading', { name: 'AllotJar app on iPhone' })
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => within(r).getByRole('heading').textContent)).toEqual([
      'AllotJar app on iPhone',
      'Chrome on Windows',
      'Unknown device',
      'Sign out everywhere',
    ])
    expect(rows[0]).toHaveTextContent('This device')
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Active 3 days ago')
    expect(rows[2]).toHaveTextContent('Active yesterday')
  })

  it('signs another device out and drops it from the list', async () => {
    mockDelete.mockResolvedValue({ status: 204 })
    const user = userEvent.setup()
    renderWithProviders(<DevicesCard />)

    await user.click(await screen.findByRole('button', { name: 'Sign out Chrome on Windows' }))

    expect(mockDelete).toHaveBeenCalledWith('/auth/sessions/b')
    expect(screen.queryByRole('heading', { name: 'Chrome on Windows' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so when a device could not be signed out, and keeps it listed', async () => {
    mockDelete.mockRejectedValue({ response: { status: 500 } })
    const user = userEvent.setup()
    renderWithProviders(<DevicesCard />)

    await user.click(await screen.findByRole('button', { name: 'Sign out Chrome on Windows' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign that device out.')
    expect(screen.getByRole('heading', { name: 'Chrome on Windows' })).toBeInTheDocument()
  })

  it('asks before signing out everywhere, then goes to the sign-in page', async () => {
    mockPost.mockResolvedValue({ status: 204 })
    const user = userEvent.setup()
    renderWithProviders(<DevicesCard />)

    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' })
    expect(mockPost).not.toHaveBeenCalledWith('/auth/sign-out-everywhere')

    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(mockPost).toHaveBeenCalledWith('/auth/sign-out-everywhere')
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('stays put and says so when signing out everywhere fails', async () => {
    mockPost.mockRejectedValue(new Error('500'))
    const user = userEvent.setup()
    renderWithProviders(<DevicesCard />)

    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' })
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not sign you out everywhere.')
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('lastActive', () => {
  const now = new Date(2026, 9, 15, 12).getTime()
  it('counts calendar days', () => {
    expect(lastActive(new Date(2026, 9, 15, 0, 5).toISOString(), now)).toBe('Active today')
    expect(lastActive(new Date(2026, 9, 14, 23, 55).toISOString(), now)).toBe('Active yesterday')
    expect(lastActive(new Date(2026, 9, 10, 9).toISOString(), now)).toBe('Active 5 days ago')
  })
})
