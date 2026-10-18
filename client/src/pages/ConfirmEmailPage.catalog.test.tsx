import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Catalog: docs/testing/cases/02-registration-login.md — the confirm-email page (REG-092): the
// POST-once logic and the three outcomes, and (restyle PR 16) the card inside the signed-out
// frame: the four states, one primary each, the theme button in the room, the (i) on the
// incomplete link's title, the staging banner. Harness matches the repo convention: the shared
// api mock, `../lib/env` mocked so a test can flip the staging flag, page inside <MemoryRouter>.

const { markEmailConfirmed, envState } = vi.hoisted(() => ({
  markEmailConfirmed: vi.fn(),
  envState: { isStaging: false },
}))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
  }),
)

vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return envState.isStaging
  },
  get APP_ENV() {
    return envState.isStaging ? 'staging' : undefined
  },
}))

// The page only needs markEmailConfirmed from auth — stub it so we can assert the banner-clear
// wiring fires exactly on a successful confirm (and never on a dead/incomplete link).
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ markEmailConfirmed }),
}))

import { mockPost } from '../test/apiMock'
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

/** The filled green pills on the page (the one primary per screen). */
const primaries = () => Array.from(document.querySelectorAll('a.bg-brand-600, button.bg-brand-600'))

/** Words the journeys find fields by: no control's aria-label on this page may contain them. */
const FIELD_WORDS = /currency|email|password|first name|last name|your name/i
const fieldWordLabels = () =>
  Array.from(document.querySelectorAll('[aria-label]'))
    .map((el) => el.getAttribute('aria-label') ?? '')
    .filter((l) => FIELD_WORDS.test(l))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  envState.isStaging = false
})

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
    // The banner-clear wiring ran on success (so an in-app nav back doesn't show a stale banner).
    expect(markEmailConfirmed).toHaveBeenCalled()
  })

  it('REG-092: a dead link shows the expired state with a path to resend', async () => {
    mockPost.mockRejectedValueOnce(new Error('400'))

    renderAt('/confirm-email?email=owner%40example.com&token=dead')

    expect(await screen.findByText('This link has expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    // A failed confirm must NOT mark the email confirmed.
    expect(markEmailConfirmed).not.toHaveBeenCalled()
  })

  it('REG-092: an incomplete link (no token) never calls the API', async () => {
    renderAt('/confirm-email?email=owner%40example.com')

    expect(await screen.findByText("This link isn't complete")).toBeInTheDocument()
    await waitFor(() => expect(mockPost).not.toHaveBeenCalled())
    expect(markEmailConfirmed).not.toHaveBeenCalled()
  })
})

describe('ConfirmEmailPage in the green-banner frame (restyle PR 16)', () => {
  it('working: the title is the status, the quiet way back under it, no primary yet', () => {
    mockPost.mockReturnValueOnce(new Promise(() => {}))
    renderAt('/confirm-email?email=owner%40example.com&token=slow')

    const status = screen.getByRole('status')
    expect(within(status).getByRole('heading', { level: 1, name: 'Confirming your email…' })).toBeInTheDocument()
    expect(status.textContent).toBe('Confirming your email…')
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login')
    expect(primaries()).toHaveLength(0)
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('done: the title takes focus and is announced, one line, "Go to AllotJar" the one primary and the only way out', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 })
    renderAt('/confirm-email?email=owner%40example.com&token=tok')

    const title = await screen.findByRole('heading', { level: 1, name: 'Email confirmed' })
    const status = screen.getByRole('status')
    expect(status).toContainElement(title)
    await waitFor(() => expect(title).toHaveFocus())
    expect(within(status).getByText("You're all set.")).toBeInTheDocument()
    expect(screen.queryByText(/Thanks — your email address is confirmed/)).not.toBeInTheDocument()

    const go = screen.getByRole('link', { name: 'Go to AllotJar' })
    expect(primaries()).toEqual([go])
    expect(go).toHaveClass('auth-pill')
    // "Go to AllotJar" already leads out: no "Back to sign in" under it.
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('expired: the title, the one recovery line and "Sign in" as the one primary (no second link to /login)', async () => {
    mockPost.mockRejectedValueOnce(new Error('400'))
    renderAt('/confirm-email?email=owner%40example.com&token=dead')

    const title = await screen.findByRole('heading', { level: 1, name: 'This link has expired' })
    expect(title.parentElement!.parentElement!).toHaveTextContent(
      'This link has expiredSign in and use Resend in the banner to get a fresh one.',
    )
    expect(screen.queryByText(/invalid or has expired/)).not.toBeInTheDocument()
    const signIn = screen.getByRole('link', { name: 'Sign in' })
    expect(signIn).toHaveAttribute('href', '/login')
    expect(primaries()).toEqual([signIn])
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('incomplete: the same recovery line, the why behind the (i) "Why" on the title, "Sign in" the one primary', async () => {
    const user = userEvent.setup()
    renderAt('/confirm-email')

    const title = await screen.findByRole('heading', { level: 1, name: "This link isn't complete" })
    expect(title.parentElement!.parentElement!).toHaveTextContent(
      "This link isn't completeSign in and use Resend in the banner to get a fresh one.",
    )
    // The split-across-two-lines sentence left the card for the (i).
    expect(screen.queryByText(/split across two lines/)).not.toBeInTheDocument()
    const why = screen.getByRole('button', { name: 'Why' })
    expect(why).toHaveClass('auth-i')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await user.hover(why)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'The confirmation link is missing some of its details — it may have been split across two lines in the email.',
    )
    expect(why).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    const signIn = screen.getByRole('link', { name: 'Sign in' })
    expect(signIn).toHaveAttribute('href', '/login')
    expect(primaries()).toEqual([signIn])
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    // The expired state has no (i): nothing to explain.
    expect(fieldWordLabels()).toEqual([])
  })

  it('incomplete: Tab walks the room and the card in order: theme, the (i), Sign in', async () => {
    const user = userEvent.setup()
    renderAt('/confirm-email')
    await screen.findByRole('heading', { level: 1 })

    await user.tab()
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Why' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveFocus()
  })

  it('the room: the wordmark, the euro line, the round "Dark mode" button (no Light | Dark group), the jars as decoration', async () => {
    const user = userEvent.setup()
    renderAt('/confirm-email')
    await screen.findByRole('heading', { level: 1 })

    const banner = screen.getByRole('banner')
    expect(banner).toHaveTextContent(/^AllotJarGive every euro a job\.$/)
    expect(screen.queryByText('Confirm your email.')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('img')).toEqual([])
    expect(screen.getAllByRole('heading')).toHaveLength(1)

    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Light mode' })).not.toBeInTheDocument()
    // The frame's short variant: the desktop card ends under its content (this page only).
    expect(document.querySelector('.auth')).toHaveClass('auth-short')
    const dark = within(banner).getByRole('button', { name: 'Dark mode' })
    expect(dark).toHaveAttribute('aria-pressed', 'false')
    await user.click(dark)
    expect(dark).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('zbb.theme')).toBe('dark')
  })

  it('shows the staging banner in a staging build above the room, as the other auth pages do', async () => {
    envState.isStaging = true
    mockPost.mockResolvedValueOnce({ status: 204 })
    renderAt('/confirm-email?email=owner%40example.com&token=tok')
    await screen.findByRole('heading', { level: 1, name: 'Email confirmed' })

    const statuses = screen.getAllByRole('status')
    expect(statuses[0]).toHaveTextContent('Staging · test data, may be reset')
    expect(statuses[0].compareDocumentPosition(screen.getByRole('banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
