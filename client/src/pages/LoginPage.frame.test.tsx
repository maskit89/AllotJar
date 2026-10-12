import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'

// The sign-in page in its restyle PR 9 frame (the approved "Green banner"): the "Sign in | Create
// account" switch and the URL, the keyboard path through the card, where focus goes when the mode
// switches, the (i) that holds the currency explainer, the theme button in the room, and the names
// the e2e journeys look things up by (helpers.ts register/sign-in). Signed out, no Google client id
// (as the journeys and the local dev server run), default (non-staging) build.

vi.mock('../lib/api', async (importOriginal) =>
  (await import('../test/apiMock')).apiModule(importOriginal, {
    getToken: () => null,
    refreshSession: () => Promise.resolve(null),
  }),
)

vi.mock('../lib/googleAuth', () => ({
  GOOGLE_CLIENT_ID: '',
  renderGoogleButton: () => Promise.reject(new Error('not configured')),
}))

import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { axiosError } from '../test/fixtures/http'
import { LoginPage } from './LoginPage'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

function renderAt(path: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
      <LocationProbe />
    </>,
    { route: path },
  )
}

const option = (name: 'Sign in' | 'Create account') =>
  within(screen.getByRole('group', { name: 'Sign in or create an account' })).getByRole('button', { name })

const submits = () =>
  screen.getAllByRole('button').filter((b) => (b as HTMLButtonElement).type === 'submit')

/** Words the journeys find fields by (Playwright getByLabel is a substring match that also reads
 *  aria-label): no control's aria-label on these pages may contain them. */
const FIELD_WORDS = /currency|email|password|first name|last name|your name/i

function ariaLabels(): string[] {
  return Array.from(document.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') ?? '')
}

/** A browser moves focus off a control the moment it is disabled (jsdom keeps it there): put focus
 *  on <body>, where the browser leaves it. */
function dropFocusLikeABrowser() {
  const sink = document.createElement('button')
  document.body.append(sink)
  sink.focus()
  sink.remove()
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  resetApiMocks()
  mockGet.mockResolvedValue({
    data: { userId: 'u1', email: 'owner@example.com', displayName: 'Owner', role: 0, ownerId: 'u1', memberId: null },
  })
})

describe('LoginPage in the green-banner frame', () => {
  it('the switch changes the mode without touching the URL, both ways', async () => {
    const user = userEvent.setup()
    renderAt('/login?returnUrl=%2Ftransactions')

    expect(option('Sign in')).toHaveAttribute('aria-pressed', 'true')
    await user.click(option('Create account'))
    expect(option('Create account')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
    expect(screen.getByTestId('loc').textContent).toBe('/login?returnUrl=%2Ftransactions')

    await user.click(option('Sign in'))
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    expect(screen.getByTestId('loc').textContent).toBe('/login?returnUrl=%2Ftransactions')
  })

  it('/login?register=1 opens on Create account; switching to Sign in keeps the URL as it was', async () => {
    const user = userEvent.setup()
    renderAt('/login?register=1')

    expect(option('Create account')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { level: 1, name: 'Create your AllotJar account' })).toBeInTheDocument()
    await user.click(option('Sign in'))
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to AllotJar' })).toBeInTheDocument()
    expect(screen.getByTestId('loc').textContent).toBe('/login?register=1')
  })

  it('has exactly one submit button in each mode, named by what it does', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    expect(submits()).toHaveLength(1)
    expect(submits()[0]).toHaveTextContent('Sign in')
    await user.click(option('Create account'))
    expect(submits()).toHaveLength(1)
    expect(submits()[0]).toHaveTextContent('Create account')
  })

  it('Tab walks the room and the card in order: theme, switch, Email, Forgot password?, Password, submit', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    await user.tab()
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveFocus()
    await user.tab()
    expect(option('Sign in')).toHaveFocus()
    await user.tab()
    expect(option('Create account')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Email')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Password')).toHaveFocus()
    await user.tab()
    expect(submits()[0]).toHaveFocus()
  })

  it('Space and Enter switch the mode from the keyboard and focus stays on the pressed option', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    option('Create account').focus()
    await user.keyboard(' ')
    expect(option('Create account')).toHaveAttribute('aria-pressed', 'true')
    expect(option('Create account')).toHaveFocus()
    expect(screen.getByLabelText('First name')).toBeInTheDocument()

    // From the switch, Tab goes straight into the new mode's first field.
    await user.tab()
    expect(screen.getByLabelText('First name')).toHaveFocus()

    option('Sign in').focus()
    await user.keyboard('{Enter}')
    expect(option('Sign in')).toHaveAttribute('aria-pressed', 'true')
    expect(option('Sign in')).toHaveFocus()
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
  })

  it('Create account: the keyboard reaches the (i) between Password and Currency, then the rest in order', async () => {
    const user = userEvent.setup()
    renderAt('/login?register=1')

    screen.getByLabelText('Password').focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'About these settings' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Currency')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Number format')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('checkbox', { name: /I agree to the/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveFocus()
    await user.tab()
    expect(submits()[0]).toHaveFocus()
  })

  it('the currency (i) opens on focus as a tooltip the button points at, and Escape closes it', async () => {
    const user = userEvent.setup()
    renderAt('/login?register=1')

    const hint = screen.getByRole('button', { name: 'About these settings' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    hint.focus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(/Your budget and its accounts use this currency/)
    expect(hint).toHaveAttribute('aria-describedby', tip.id)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('the (i) sits outside the Currency label: the field keeps its one label and the journeys their names', async () => {
    const user = userEvent.setup()
    renderAt('/login?register=1')

    // Playwright's getByLabel('Currency') is a substring match over labels AND aria-labels.
    expect(screen.getAllByLabelText(/currency/i)).toHaveLength(1)
    expect(screen.getByLabelText('Currency').tagName).toBe('SELECT')
    expect(ariaLabels().filter((l) => FIELD_WORDS.test(l))).toEqual([])
    await user.click(option('Sign in'))
    expect(ariaLabels().filter((l) => FIELD_WORDS.test(l))).toEqual([])
  })

  it('the theme button in the room is a "Dark mode" toggle that pins the theme', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    const banner = screen.getByRole('banner')
    const dark = within(banner).getByRole('button', { name: 'Dark mode' })
    expect(dark).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument()
    await user.click(dark)
    expect(dark).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('zbb.theme')).toBe('dark')
  })

  it('the room holds the wordmark and the one line; its shelf of jars is decoration', () => {
    renderAt('/login')

    const banner = screen.getByRole('banner')
    expect(banner).toHaveTextContent('AllotJar')
    expect(banner).toHaveTextContent(/^AllotJarGive every \w+ a job\.$/)
    // Jars and logo are hidden from assistive tech; no image role anywhere on the page.
    expect(screen.queryAllByRole('img')).toEqual([])
    // One heading on the page: the visually hidden h1.
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it('Check your inbox: its second sentence is behind an (i), and "Use a different email" returns to the Email field', async () => {
    mockPost.mockResolvedValueOnce({ data: { verificationPending: true } })
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'taken@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submits()[0])

    const status = await screen.findByRole('status', {}, { timeout: 5000 })
    expect(within(status).getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument()
    expect(within(status).getByText('taken@example.test')).toBeInTheDocument()
    expect(screen.queryByText(/If that's you, follow the link/)).not.toBeInTheDocument()
    await user.hover(within(status).getByRole('button', { name: 'What to do next' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent("If that's you, follow the link to take it over. If not, you can ignore this.")
    expect(ariaLabels().filter((l) => FIELD_WORDS.test(l))).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Use a different email' }))
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus())
    expect(screen.getByLabelText('Email')).toHaveValue('taken@example.test')
    expect(option('Create account')).toHaveAttribute('aria-pressed', 'true')
  })

  it('the error line is one alert above the submit whose own text is the message', async () => {
    mockPost.mockRejectedValueOnce(axiosError({ error: 'Invalid email or password.' }, 401))
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x')
    await user.click(submits()[0])

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert.textContent).toBe('Invalid email or password.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Directly above the submit, inside the form.
    expect(alert.nextElementSibling).toBe(submits()[0])
  })

  it('the session-expired notice is one quiet line at the top of the card, its why behind an (i)', async () => {
    const user = userEvent.setup()
    renderAt('/login?reason=expired')

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Your session has expired.')
    const notice = status.parentElement!
    expect(notice.nextElementSibling).toBe(screen.getByRole('group', { name: 'Sign in or create an account' }))
    expect(screen.queryByText(/to keep your budget safe/)).not.toBeInTheDocument()

    const why = within(notice).getByRole('button', { name: 'Why you were signed out' })
    await user.tab()
    await user.tab()
    expect(why).toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off.',
    )
    expect(why).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    expect(ariaLabels().filter((l) => FIELD_WORDS.test(l))).toEqual([])
  })

  it('a failed sign-in started from the submit button leaves focus on the button, not on the page', async () => {
    let fail: (e: unknown) => void = () => {}
    mockPost.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x')
    const submit = submits()[0]
    submit.focus()
    await user.keyboard('{Enter}')
    // While busy the button is disabled, and a browser moves focus off a disabled control to <body>.
    await waitFor(() => expect(submit).toBeDisabled())
    dropFocusLikeABrowser()
    expect(document.activeElement).toBe(document.body)

    fail(axiosError({ error: 'Invalid email or password.' }, 401))
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Invalid email or password.')
    await waitFor(() => expect(submits()[0]).toHaveFocus())
  })

  it('a failed sign-in started with Enter in a field leaves focus in that field', async () => {
    mockPost.mockRejectedValueOnce(axiosError({ error: 'Invalid email or password.' }, 401))
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x{Enter}')
    await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(screen.getByLabelText('Password')).toHaveFocus()
  })

  it('Check your inbox takes focus on its title when it replaces the form', async () => {
    mockPost.mockResolvedValueOnce({ data: { verificationPending: true } })
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'taken@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submits()[0])

    const title = await screen.findByRole('heading', { name: 'Check your inbox' }, { timeout: 5000 })
    await waitFor(() => expect(title).toHaveFocus())
    // The next Tab goes on to the title's (i), then "Use a different email".
    await user.tab()
    expect(screen.getByRole('button', { name: 'What to do next' })).toHaveFocus()
  })
})
