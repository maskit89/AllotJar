import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'

// Forgot password, Reset password and Accept invite in the restyle PR 9 frame: each card opens with
// its own title (the page's h1) and keeps its explanation behind an (i) beside it, every message
// stays reachable, the staging banner shows where it always did (not on Accept invite), and no
// control's aria-label holds a word the journeys find fields by.

const { envState } = vi.hoisted(() => ({ envState: { isStaging: false } }))

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    refreshSession: () => Promise.resolve(null),
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

import { mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { axiosError } from '../test/fixtures/http'
import { ForgotPasswordPage } from './ForgotPasswordPage'
import { ResetPasswordPage } from './ResetPasswordPage'
import { AcceptInvitePage } from './AcceptInvitePage'
import { LoginPage } from './LoginPage'

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
    </Routes>,
    { route: path },
  )
}

const FIELD_WORDS = /currency|email|password|first name|last name|your name/i
const fieldWordLabels = () =>
  Array.from(document.querySelectorAll('[aria-label]'))
    .map((el) => el.getAttribute('aria-label') ?? '')
    .filter((l) => FIELD_WORDS.test(l))

beforeEach(() => {
  localStorage.clear()
  envState.isStaging = false
  resetApiMocks()
})

describe('Forgot password in the frame', () => {
  it('titles the card "Reset your password" with the intro behind its (i), and links back inside the card', async () => {
    const user = userEvent.setup()
    renderAt('/forgot-password')

    expect(screen.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.queryByText(/send you a link to choose a new password/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About resetting' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      "Enter your account's email address and we'll send you a link to choose a new password.",
    )
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login')
    expect(fieldWordLabels()).toEqual([])
  })

  it('after sending: "Check your inbox" leads the status, the spam tip is behind its (i), the way back stays', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 })
    const user = userEvent.setup()
    renderAt('/forgot-password')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    const status = await screen.findByRole('status')
    // "Check your inbox" leads the panel and takes focus (which reads it); the live region holds
    // only the line under it, so the title is announced once (#352 P3-2).
    const title = screen.getByRole('heading', { level: 1, name: 'Check your inbox' })
    expect(title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status).not.toContainElement(title)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(within(status).getByText('owner@example.com')).toBeInTheDocument()
    expect(status).toHaveTextContent('If an account exists for owner@example.com')
    expect(screen.queryByText(/Check your spam folder/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'If nothing arrives' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'No email after a few minutes? Check your spam folder, or try again.',
    )
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument()
    expect(fieldWordLabels()).toEqual([])
  })

  it('after sending, focus moves to the "Check your inbox" title that replaced the form', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 })
    const user = userEvent.setup()
    renderAt('/forgot-password')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    const title = await screen.findByRole('heading', { level: 1, name: 'Check your inbox' })
    await waitFor(() => expect(title).toHaveFocus())
    await user.tab()
    expect(screen.getByRole('button', { name: 'If nothing arrives' })).toHaveFocus()
  })

  it('a failed send started from the button gives focus back to the button', async () => {
    let fail: (e: unknown) => void = () => {}
    mockPost.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    const user = userEvent.setup()
    renderAt('/forgot-password')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    const submit = screen.getByRole('button', { name: 'Email me a reset link' })
    submit.focus()
    await user.keyboard('{Enter}')
    // While busy the button is disabled, and a browser moves focus off a disabled control to <body>
    // (jsdom keeps it there, so do what the browser does).
    await waitFor(() => expect(submit).toBeDisabled())
    const sink = document.createElement('button')
    document.body.append(sink)
    sink.focus()
    sink.remove()
    expect(document.activeElement).toBe(document.body)

    fail(new Error('Network Error'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't send the email/)
    await waitFor(() => expect(submit).toHaveFocus())
  })

  it('shows the staging banner in a staging build, as before', () => {
    envState.isStaging = true
    renderAt('/forgot-password')
    expect(screen.getByRole('status')).toHaveTextContent('Staging · test data, may be reset')
  })
})

describe('Reset password in the frame', () => {
  it('titles the card "Choose a new password" and keeps who and what it signs out visible', () => {
    renderAt('/reset-password?email=owner%40example.com&token=tok')

    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument()
    expect(screen.getByText('owner@example.com')).toBeVisible()
    expect(screen.getByText(/signs you out everywhere else/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login')
    expect(fieldWordLabels()).toEqual([])
  })

  it('a mismatch marks the confirm field invalid and points it at the message', async () => {
    const user = userEvent.setup()
    renderAt('/reset-password?email=owner%40example.com&token=tok')

    const confirm = screen.getByLabelText('Confirm new password')
    expect(confirm).not.toHaveAttribute('aria-invalid')
    expect(confirm).not.toHaveAttribute('aria-describedby')
    await user.type(screen.getByLabelText('New password'), 'password123')
    await user.type(confirm, 'password124')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("Those passwords don't match.")
    expect(confirm).toHaveAttribute('aria-invalid', 'true')
    expect(confirm).toHaveAccessibleDescription("Those passwords don't match.")
    expect(screen.getByLabelText('New password')).not.toHaveAttribute('aria-invalid')
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('a server error is not pinned on the confirm field', async () => {
    mockPost.mockRejectedValueOnce(
      axiosError({ error: 'That reset link is invalid or has expired. Please request a new one.' }, 400),
    )
    const user = userEvent.setup()
    renderAt('/reset-password?email=owner%40example.com&token=tok')

    await user.type(screen.getByLabelText('New password'), 'password123')
    await user.type(screen.getByLabelText('Confirm new password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/)
    expect(screen.getByLabelText('Confirm new password')).not.toHaveAttribute('aria-invalid')
  })

  it('an incomplete link: its title, the explanation behind the (i), "Request a new link" and the way back', async () => {
    const user = userEvent.setup()
    renderAt('/reset-password?token=x')

    expect(screen.getByRole('heading', { level: 1, name: "This link isn't complete" })).toBeInTheDocument()
    expect(screen.queryByText(/split across two lines/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About this link' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'The reset link is missing some of its details — it may have been split across two lines in the email. You can request a fresh one below.',
    )
    expect(screen.getByRole('button', { name: 'Request a new link' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument()
  })
})

describe('Accept invite in the frame', () => {
  it('opens with the eyebrow and the one "Join the household" heading, the intro behind its (i)', async () => {
    const user = userEvent.setup()
    renderAt('/accept-invite?code=ABC123')

    expect(await screen.findByText('Household invite')).toBeInTheDocument()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Join the household' })).toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About this invite' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'You’ve been invited to share a budget on AllotJar — pool income, split shared costs, and each keep your own savings.',
    )
    expect(screen.getByLabelText('Your name (optional)')).toBeInTheDocument()
    expect(fieldWordLabels()).toEqual([])
  })

  it('the keyboard path: theme, (i), name, password, terms and its links, Accept invite, Sign in to accept, Not now', async () => {
    const user = userEvent.setup()
    renderAt('/accept-invite?code=ABC123')
    await screen.findByLabelText('Password')

    const order = [
      screen.getByRole('button', { name: 'Dark mode' }),
      screen.getByRole('button', { name: 'About this invite' }),
      screen.getByLabelText('Your name (optional)'),
      screen.getByLabelText('Password'),
      screen.getByRole('checkbox', { name: /I agree to the/ }),
      screen.getByRole('link', { name: 'Terms of Service' }),
      screen.getByRole('link', { name: 'Privacy Policy' }),
      screen.getByRole('button', { name: 'Accept invite' }),
      screen.getByRole('button', { name: 'Sign in to accept' }),
      screen.getByRole('button', { name: 'Not now' }),
    ]
    for (const el of order) {
      await user.tab()
      expect(el).toHaveFocus()
    }
  })

  it('never shows the staging banner (it never had one), even in a staging build', async () => {
    envState.isStaging = true
    renderAt('/accept-invite?code=ABC123')
    await screen.findByLabelText('Password')
    expect(screen.queryByText(/test data, may be reset/i)).not.toBeInTheDocument()
  })

  it('a link without its code: the title and the alert only', async () => {
    renderAt('/accept-invite?token=x')
    expect(await screen.findByRole('alert')).toHaveTextContent(/missing its code/)
    expect(screen.getByRole('heading', { level: 1, name: 'Join the household' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'About this invite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
  })
})

describe('The frame\'s line (restyle PR 16)', () => {
  // The app is euro-first: the line reads "Give every euro a job." on every signed-out page under
  // every browser locale (the landing page has read so since PR 15), never the locale's noun.
  it('reads "Give every euro a job." on every page, under a UK and a US browser alike', () => {
    for (const lang of ['en-GB', 'en-US', 'de-CH']) {
      const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue(lang)
      try {
        for (const path of ['/forgot-password', '/reset-password?email=a%40b.c&token=t', '/accept-invite?code=ABC123']) {
          const view = renderAt(path)
          expect(screen.getByRole('banner')).toHaveTextContent(/^AllotJarGive every euro a job\.$/)
          expect(screen.queryByText(/pound|dollar|franc/)).not.toBeInTheDocument()
          view.unmount()
        }
      } finally {
        spy.mockRestore()
      }
    }
  })
})

describe('Sign in in a staging build', () => {
  it('keeps the banner above the room and the data-loss box under the terms one', async () => {
    envState.isStaging = true
    const user = userEvent.setup()
    renderAt('/login?register=1')

    expect(screen.getByRole('status')).toHaveTextContent('Staging · test data, may be reset')
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[1]).toBe(screen.getByRole('checkbox', { name: /staging/i }))
    expect(boxes[1]).toBeRequired()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
