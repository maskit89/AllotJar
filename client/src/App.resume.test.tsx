import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// A page reads its figures when it opens, and a phone usually resumes the installed app rather
// than starting it afresh. Coming back after a while remounts the figure page (App.tsx), as a
// fresh start would, so it reads its figures again, or reloads the app fully when a newer build
// has been deployed; never part-way through an entry (a focused field, a dialog, an inline
// editor marked data-entry), never on Import's review or the account settings, never offline.
//
// The REAL App routing tree with the pages stubbed (the App.catalog.test.tsx set-up); the
// stubs count their mounts, and a second mount is the page reading its figures again.

const { mockGet, mockPost, mounts } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mounts: {} as Record<string, number>,
}))

vi.mock('./lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockGet, delete: mockGet },
  getToken: () => 'tok',
  setToken: vi.fn(),
  refreshSession: () => Promise.resolve(null),
}))

async function counted(name: string) {
  const { useEffect } = await import('react')
  return function Stub() {
    useEffect(() => {
      mounts[name] = (mounts[name] ?? 0) + 1
    }, [])
    return name
  }
}

vi.mock('./pages/DashboardPage', async () => ({ DashboardPage: await counted('DashboardPage') }))
vi.mock('./pages/AccountDetailPage', async () => ({ AccountDetailPage: await counted('AccountDetailPage') }))
vi.mock('./pages/ImportPage', async () => ({ ImportPage: await counted('ImportPage') }))
vi.mock('./pages/AccountPage', async () => ({ AccountPage: await counted('AccountPage') }))
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => 'LoginPage' }))
vi.mock('./pages/LandingPage', () => ({ LandingPage: () => 'LandingPage' }))
vi.mock('./pages/PrivacyPage', () => ({ PrivacyPage: () => 'PrivacyPage' }))
vi.mock('./pages/TermsPage', () => ({ TermsPage: () => 'TermsPage' }))
vi.mock('./pages/AcceptInvitePage', () => ({ AcceptInvitePage: () => 'AcceptInvitePage' }))
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => 'PeoplePage' }))
vi.mock('./pages/TransactionsPage', () => ({ TransactionsPage: () => 'TransactionsPage' }))
vi.mock('./pages/AccountsPage', () => ({ AccountsPage: () => 'AccountsPage' }))
vi.mock('./pages/JarsPage', () => ({ JarsPage: () => 'JarsPage' }))
vi.mock('./pages/AllocationPage', () => ({ AllocationPage: () => 'AllocationPage' }))
vi.mock('./pages/ReportsPage', () => ({ ReportsPage: () => 'ReportsPage' }))
vi.mock('./pages/HelpPage', () => ({ HelpPage: () => 'HelpPage' }))
vi.mock('./onboarding/Onboarding', () => ({ Onboarding: () => null }))
vi.mock('./components/ConsentModal', () => ({ ConsentModal: () => null }))

import App from './App'
import { AuthProvider } from './auth/AuthContext'

const ME = {
  userId: 'u1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 0,
  ownerId: 'u1',
  memberId: null,
  needsConsent: false,
}

async function openAt(path: string, page: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText(page)).toBeInTheDocument(), { timeout: 5000 })
  await waitFor(() => expect(mounts[page]).toBe(1))
}

/** The app goes to the background for `minutes`, then comes back on screen. */
function awayFor(minutes: number) {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  vi.setSystemTime(Date.now() + minutes * 60_000)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

/** Lets the new-build check and any remount it leads to finish, so a "not reloaded" holds. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('coming back to the app reloads the figures on screen', () => {
  beforeEach(() => {
    for (const key of Object.keys(mounts)) delete mounts[key]
    mockGet.mockReset()
    mockPost.mockReset()
    mockGet.mockResolvedValue({ data: ME })
    mockPost.mockResolvedValue({ data: {} })
  })
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    document.head.querySelectorAll('script[src^="/assets/"]').forEach((el) => el.remove())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads the Dashboard after ten minutes away', async () => {
    await openAt('/', 'DashboardPage')
    awayFor(10)
    await waitFor(() => expect(mounts.DashboardPage).toBe(2))
  })

  it("reloads an account's page too", async () => {
    await openAt('/accounts/acc1', 'AccountDetailPage')
    awayFor(30)
    await waitFor(() => expect(mounts.AccountDetailPage).toBe(2))
  })

  it('leaves the page as it is after a short absence (checking the bank app)', async () => {
    await openAt('/', 'DashboardPage')
    awayFor(9)
    await settle()
    expect(mounts.DashboardPage).toBe(1)
  })

  it('never reloads under an open dialog', async () => {
    await openAt('/', 'DashboardPage')
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    awayFor(60)
    await settle()
    expect(mounts.DashboardPage).toBe(1)
    dialog.remove()
  })

  it('never reloads while a field has the focus', async () => {
    await openAt('/', 'DashboardPage')
    const field = document.body.appendChild(document.createElement('input'))
    field.focus()
    awayFor(60)
    await settle()
    expect(mounts.DashboardPage).toBe(1)
    field.remove()
  })

  it('never reloads offline: the figures on screen beat a page that cannot load', async () => {
    await openAt('/', 'DashboardPage')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    awayFor(60)
    await settle()
    expect(mounts.DashboardPage).toBe(1)
  })

  it("never reloads Import's review", async () => {
    await openAt('/import', 'ImportPage')
    awayFor(60)
    await settle()
    expect(mounts.ImportPage).toBe(1)
  })

  it('never reloads the account settings', async () => {
    await openAt('/account', 'AccountPage')
    awayFor(60)
    await settle()
    expect(mounts.AccountPage).toBe(1)
  })

  it('never reloads under an open inline editor, even with the focus on its checkbox', async () => {
    await openAt('/', 'DashboardPage')
    const editor = document.body.appendChild(document.createElement('div'))
    editor.setAttribute('data-entry', '')
    const jar = editor.appendChild(document.createElement('input'))
    jar.type = 'checkbox'
    jar.focus()
    awayFor(60)
    await settle()
    expect(mounts.DashboardPage).toBe(1)
    editor.remove()
  })

  it('loads the new version when one was deployed while the app was away', async () => {
    const entry = document.head.appendChild(document.createElement('script'))
    entry.type = 'module'
    entry.src = '/assets/index-old111.js'
    const fetchPage = vi.fn(async () => new Response('<script type="module" crossorigin src="/assets/index-new222.js"></script>'))
    vi.stubGlobal('fetch', fetchPage)
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })

    await openAt('/', 'DashboardPage')
    awayFor(30)

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(fetchPage).toHaveBeenCalledWith('/index.html', { cache: 'no-store' })
    expect(mounts.DashboardPage).toBe(1)
  })
})
