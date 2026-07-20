import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

// Catalog coverage for docs/testing/cases/02-registration-login.md (REG-*), the
// `/login` page in both modes. These COMPLEMENT the five cases already in
// LoginPage.test.tsx (registration-only fields hidden in sign-in mode; safe
// internal returnUrl round-trip; full profile+prefs submit; includeSampleData
// only when ticked; staging required data-loss ack) and DO NOT duplicate them.
//
// Harness matches the repo convention (PR #169 gotcha): hoisted api mock fns,
// vi.mock('../lib/api') spreading importOriginal, page rendered inside
// <MemoryRouter><AuthProvider>. `../lib/env` is mocked so a test can flip the
// staging build flag; `../analytics` is mocked so the LoginPage -> track() wiring
// (REG-050) is assertable without the real GA bridge (which is inert under test
// anyway).
//
// jsdom native-validation note (probed): jsdom ENFORCES `required` (text +
// checkbox) and email `type=email` typeMismatch, so those client gates are
// asserted here by proving no POST fires. jsdom does NOT enforce `minLength`
// (`tooShort` never trips), so the <8-char password / 5-char password blocks
// (REG-013 step 1, REG-040 short-password) can only be asserted at the attribute
// level here — the runtime block belongs to the Playwright a11y/journey layer.

const { mockGet, mockPost, mockPut, mockDelete, envState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  envState: { isStaging: false },
}))

vi.mock('../lib/api', async (importOriginal) => ({
  // Spread the real module first so newly added api.ts exports keep working under
  // test; the stubs below override only what this file controls.
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, post: mockPost, put: mockPut, delete: mockDelete },
  getToken: () => null,
  setToken: vi.fn(),
  // Signed-out cold-load bootstrap: no cookie session to restore, so the form renders.
  refreshSession: () => Promise.resolve(null),
}))

// Build-time env flag — default off (GA/default build) so the staging banner and the
// staging data-loss checkbox are absent unless a test opts in.
vi.mock('../lib/env', () => ({
  get IS_STAGING() {
    return envState.isStaging
  },
  get APP_ENV() {
    return envState.isStaging ? 'staging' : undefined
  },
}))

// Spy on the analytics track() the page fires on sign-in/up/failure. Spread the
// real module so EVENTS keeps its true values.
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  track: vi.fn(),
}))

// Google Identity Services stub: exposes the captured credential callback so a test can act as
// Google handing back a signed token. Client id present by default; a test can blank it.
const { googleState } = vi.hoisted(() => ({
  googleState: {
    clientId: 'client-123.apps.googleusercontent.com',
    callback: undefined as ((credential: string) => void) | undefined,
  },
}))
vi.mock('../lib/googleAuth', () => ({
  get GOOGLE_CLIENT_ID() {
    return googleState.clientId
  },
  renderGoogleButton: (_el: HTMLElement, cb: (credential: string) => void) => {
    googleState.callback = cb
    return Promise.resolve()
  },
}))

import { LoginPage } from './LoginPage'
import { AuthProvider } from '../auth/AuthContext'
import { track, EVENTS } from '../analytics'
import { detectLocaleDefaults } from '../lib/money'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

/** Render the page at a route, with stub destinations so a post-auth navigate()
 *  is observable (a "/" landing renders HOME instead of the real Dashboard). */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/transactions" element={<div>TRANSACTIONS</div>} />
          <Route path="*" element={<div>ELSEWHERE</div>} />
        </Routes>
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** The auth response AuthContext.apply() accepts on a successful login/register. */
function authResponse(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok-secret-xyz',
    expiresAtUtc: '2999-01-01T00:00:00Z',
    userId: 'u1',
    email: 'owner@example.com',
    role: 0,
    displayName: 'Owner',
    ...overrides,
  }
}

/** A plain object axios treats as an AxiosError so the page's catch surfaces the
 *  server body exactly as in production (axios.isAxiosError checks isAxiosError). */
function axiosError(data: unknown, status = 400) {
  return { isAxiosError: true, response: { status, data } }
}

/** All values currently held in the in-memory localStorage (setup.ts polyfill). */
function allStoredValues(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k) out.push(localStorage.getItem(k) as string)
  }
  return out
}

/** The submit button (both the toggle and the submit share an accessible name). */
function submitButton(name: 'Sign in' | 'Create account') {
  return screen
    .getAllByRole('button', { name })
    .find((b) => (b as HTMLButtonElement).type === 'submit') as HTMLButtonElement
}

async function switchToRegister(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('LoginPage (REG catalog)', () => {
  beforeEach(() => {
    localStorage.clear()
    envState.isStaging = false
    mockGet.mockReset()
    mockPost.mockReset()
    mockPut.mockReset()
    mockDelete.mockReset()
    vi.mocked(track).mockClear()
    // /auth/me fires from AuthContext once a token exists; keep it resolvable.
    mockGet.mockResolvedValue({
      data: { userId: 'u1', email: 'owner@example.com', displayName: 'Owner', role: 0, ownerId: 'u1', memberId: null },
    })
  })

  // ---- Page chrome & mode toggle ------------------------------------------

  // REG-001 — sign-in mode is the default, with the full chrome and only the two
  // sign-in fields (no registration-only fields, no staging banner in a default build).
  it('REG-001: renders sign-in mode by default with the two-field chrome and no registration fields', () => {
    renderAt('/login')

    expect(screen.getByRole('heading', { name: /AllotJar/ })).toBeInTheDocument()
    expect(screen.getByText('Zero-based budgeting, in your currency.')).toBeInTheDocument()

    // Segmented control: "Sign in" selected, "Create account" not.
    expect(screen.getByRole('group', { name: 'Sign in or create an account' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account', pressed: false })).toBeInTheDocument()

    const email = screen.getByLabelText('Email')
    expect(email).toHaveAttribute('type', 'email')
    expect(email).toHaveAttribute('placeholder', 'you@example.com')
    expect(email).toHaveAttribute('autocomplete', 'email')

    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('placeholder', 'At least 8 characters')
    expect(password).toHaveAttribute('autocomplete', 'current-password')

    // Submit reads "Sign in"; no registration-only fields; no staging banner (default build).
    expect(submitButton('Sign in')).toBeInTheDocument()
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText(/Give every \w+ a job\./)).toBeInTheDocument()
  })

  // REG-002 — switching to "Create account" reveals every registration field with
  // the right attributes, flips the password autocomplete + submit label, and the
  // legal links open /terms and /privacy in a new tab.
  it('REG-002: Create account reveals all registration fields, flips autocomplete/label, and links to /terms & /privacy', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    await switchToRegister(user)

    expect(screen.getByLabelText('First name')).toHaveAttribute('autocomplete', 'given-name')
    expect(screen.getByLabelText('Last name')).toHaveAttribute('autocomplete', 'family-name')
    expect(screen.getByLabelText('Currency')).toBeInTheDocument()
    expect(screen.getByLabelText('Number format')).toBeInTheDocument()
    expect(
      screen.getByText('You can change your currency and number format anytime in account settings.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /sample figures/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /I agree to the/ })).toBeRequired()

    // Password autocomplete switches to new-password; submit label becomes "Create account".
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
    expect(submitButton('Create account')).toBeInTheDocument()

    const terms = screen.getByRole('link', { name: 'Terms of Service' })
    expect(terms).toHaveAttribute('href', '/terms')
    expect(terms).toHaveAttribute('target', '_blank')
    expect(terms).toHaveAttribute('rel', expect.stringContaining('noopener'))
    const privacy = screen.getByRole('link', { name: 'Privacy Policy' })
    expect(privacy).toHaveAttribute('href', '/privacy')
    expect(privacy).toHaveAttribute('target', '_blank')
  })

  // REG-002 — switching back to "Sign in" hides every registration-only field again
  // but keeps the entered email/password.
  it('REG-002: switching back to Sign in hides registration fields but preserves email/password', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    await switchToRegister(user)
    await user.type(screen.getByLabelText('Email'), 'keep@x.eu')
    await user.type(screen.getByLabelText('Password'), 'password123')
    expect(screen.getByLabelText('First name')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue('keep@x.eu')
    expect(screen.getByLabelText('Password')).toHaveValue('password123')
  })

  // REG-003 — the deep link opens the Create-account tab for ANY value of the
  // `register` param (the code checks searchParams.has, not the value); plain
  // /login still opens Sign in.
  it('REG-003: /login?register=<anything> opens the Create-account tab; plain /login opens Sign in', () => {
    for (const path of ['/login?register=1', '/login?register=anything', '/login?register=']) {
      const view = renderAt(path)
      expect(screen.getByLabelText('First name')).toBeInTheDocument()
      expect(submitButton('Create account')).toBeInTheDocument()
      view.unmount()
    }

    renderAt('/login')
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    expect(submitButton('Sign in')).toBeInTheDocument()
  })

  // REG-004 — switching tabs clears the current error message (switchMode calls
  // setError(null)).
  it('REG-004: switching tabs clears the current error message', async () => {
    mockPost.mockRejectedValue(axiosError({ error: 'Invalid email or password.' }, 401))
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrongpass1')
    await user.click(submitButton('Sign in'))

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent('Invalid email or password.')

    // Switching to Create account clears it immediately.
    await switchToRegister(user)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // And back to Sign in stays clean.
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // REG-005 — while the request is in flight the submit button is disabled and reads
  // "Please wait…", so a double-submit can't fire a second POST.
  it('REG-005: the submit button shows a disabled busy state that prevents a double submission', async () => {
    let resolveRegister!: (value: unknown) => void
    mockPost.mockImplementation(() => new Promise((res) => (resolveRegister = res)))
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-005@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    const busy = await screen.findByRole('button', { name: 'Please wait…' }, { timeout: 5000 })
    expect(busy).toBeDisabled()
    expect(mockPost).toHaveBeenCalledTimes(1)

    // A second click on the disabled button is a no-op — still one POST.
    await user.click(busy)
    expect(mockPost).toHaveBeenCalledTimes(1)

    resolveRegister({ data: authResponse() })
    expect(await screen.findByText('HOME', undefined, { timeout: 5000 })).toBeInTheDocument()
  })

  // ---- Currency & number-format pickers -----------------------------------

  // REG-030 — the picker option lists are exactly the curated sets from lib/money.ts.
  it('REG-030: currency lists 24 options (EUR first) and number format lists the 5 curated styles', async () => {
    const user = userEvent.setup()
    renderAt('/login')
    await switchToRegister(user)

    const currency = screen.getByLabelText('Currency') as HTMLSelectElement
    expect(currency.options).toHaveLength(24)
    expect(currency.options[0].value).toBe('EUR')
    expect(currency.options[0].textContent).toBe('Euro (€)')
    expect(within(currency).getByRole('option', { name: 'British pound (£)' })).toBeInTheDocument()
    expect(within(currency).getByRole('option', { name: 'Turkish lira (₺)' })).toBeInTheDocument()

    const numberFormat = screen.getByLabelText('Number format') as HTMLSelectElement
    expect(Array.from(numberFormat.options).map((o) => o.textContent)).toEqual([
      '1,234.56',
      '1.234,56',
      '1 234,56',
      "1'234.56",
      '1,23,456.78',
    ])
  })

  // REG-031 — the two selects and the footer tagline preselect from the browser
  // locale (detectLocaleDefaults, computed once on mount).
  it('REG-031: the browser locale preselects the currency, number format and tagline noun', () => {
    const cases = [
      { lang: 'en-GB', currency: 'GBP', format: 'comma-dot', noun: 'pound' },
      { lang: 'de-DE', currency: 'EUR', format: 'dot-comma', noun: 'euro' },
      { lang: 'en-US', currency: 'USD', format: 'comma-dot', noun: 'dollar' },
    ]
    for (const c of cases) {
      const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue(c.lang)
      try {
        const view = renderAt('/login?register=1')
        expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe(c.currency)
        expect((screen.getByLabelText('Number format') as HTMLSelectElement).value).toBe(c.format)
        expect(screen.getByText(`Give every ${c.noun} a job.`)).toBeInTheDocument()
        view.unmount()
      } finally {
        spy.mockRestore()
      }
    }
  })

  // ---- Create account: client-side validation gating ----------------------

  // REG-011 / REG-014 — required fields (and the terms checkbox specifically) block
  // submission: no POST fires until the terms box is ticked.
  it('REG-011/REG-014: an empty form and an unticked terms box block the register POST client-side', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login?register=1')

    // Whole form empty -> blocked by the first required field.
    await user.click(submitButton('Create account'))
    expect(mockPost).not.toHaveBeenCalled()

    // All text fields valid, terms still unticked -> blocked by the required checkbox.
    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-014@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(submitButton('Create account'))
    expect(mockPost).not.toHaveBeenCalled()

    // Tick terms -> the POST is allowed through.
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/register', expect.any(Object)), {
      timeout: 5000,
    })
  })

  // REG-012 — email format: a syntactically broken address is blocked by the
  // type=email control (no POST); the deliberately-lenient `a@b` is accepted and
  // reaches the server.
  it('REG-012: "notanemail" is blocked by type=email; the lenient "a@b" is accepted and posts', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()

    const view = renderAt('/login?register=1')
    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'notanemail')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))
    expect(mockPost).not.toHaveBeenCalled()
    view.unmount()

    renderAt('/login?register=1')
    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'a@b')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ email: 'a@b' })),
      { timeout: 5000 },
    )
  })

  // REG-013 / REG-040 — the password field carries minLength=8 in both modes. (The
  // runtime <8-char block is a native-browser behaviour jsdom does not enforce, so
  // it is asserted at the attribute level here and exercised for real in e2e.)
  it('REG-013/REG-040: the password input declares minLength=8 in both sign-in and register modes', async () => {
    const user = userEvent.setup()
    renderAt('/login')
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '8')

    await switchToRegister(user)
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '8')
  })

  // ---- Staging vs GA/default build -------------------------------------------

  // REG-016 — the default (non-staging) build renders neither the staging banner nor the
  // amber data-loss checkbox, and registration succeeds with terms alone.
  it('REG-016: default build shows no staging banner and no data-loss checkbox; terms alone suffices', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login?register=1')

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/my data may be reset or permanently lost/i)).not.toBeInTheDocument()
    // Only the optional sample box + the required terms box (no staging box).
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-016@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/register', expect.any(Object)), {
      timeout: 5000,
    })
  })

  // ---- Server error bodies render in the form's alert ----------------------

  // REG-017 / REG-023 — a duplicate-email 400 (the `{error}` string shape) renders
  // verbatim in the role="alert", and the form stays filled for a retry.
  it('REG-017/REG-023: a duplicate-email {error} renders verbatim in the alert and the form stays filled', async () => {
    mockPost.mockRejectedValue(axiosError({ error: 'An account with that email already exists.' }))
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent('An account with that email already exists.')
    // Form stays put and filled — no navigation.
    expect(screen.getByLabelText('Email')).toHaveValue('owner@example.com')
    expect(screen.queryByText('HOME')).not.toBeInTheDocument()
  })

  // REG-018 — a breached-password 400 (also the `{error}` shape) surfaces the HIBP
  // message in the alert.
  it('REG-018: a breached-password {error} surfaces the HIBP message in the alert', async () => {
    mockPost.mockRejectedValue(
      axiosError({ error: 'This password has appeared in a known data breach. Please choose a different one.' }),
    )
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-018@example.test')
    await user.type(screen.getByLabelText('Password'), 'Password1!')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'This password has appeared in a known data breach. Please choose a different one.',
    )
  })

  // REG-017 / REG-019 — the Identity composition-rule 400 (the `{errors:[…]}` array
  // shape) renders the messages joined with spaces.
  it('REG-017/REG-019: an {errors:[…]} array body renders the messages joined with spaces', async () => {
    mockPost.mockRejectedValue(
      axiosError({
        errors: [
          "Passwords must have at least one digit ('0'-'9').",
          "Passwords must have at least one uppercase ('A'-'Z').",
        ],
      }),
    )
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-019@example.test')
    await user.type(screen.getByLabelText('Password'), 'abcdefgh')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      "Passwords must have at least one digit ('0'-'9'). Passwords must have at least one uppercase ('A'-'Z').",
    )
  })

  // REG-017 / REG-047 — the network/unexpected fallback: a non-axios failure and an
  // empty-body 429 (rate limit) both surface "Something went wrong."
  it('REG-017/REG-047: a network failure and an empty-body 429 both surface "Something went wrong."', async () => {
    const user = userEvent.setup()

    // (a) Non-axios rejection -> fallback copy.
    mockPost.mockRejectedValue(new Error('offline'))
    const view = renderAt('/login')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(submitButton('Sign in'))
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Something went wrong.')
    view.unmount()

    // (b) Empty-body 429 from the auth rate limiter -> same fallback (not a crash).
    mockPost.mockRejectedValue(axiosError('', 429))
    renderAt('/login')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(submitButton('Sign in'))
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Something went wrong.')
  })

  // ---- Sign-in -------------------------------------------------------------

  // REG-036 — valid credentials sign in, navigate to "/", and persist only identity
  // hints in localStorage — never the access token.
  it('REG-036: valid credentials land on the dashboard and store identity hints, never the token', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'Sunlit-Meadow-42a')
    await user.click(submitButton('Sign in'))

    expect(await screen.findByText('HOME', undefined, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem('zbb.email')).toBe('owner@example.com'), { timeout: 5000 })
    expect(localStorage.getItem('zbb.role')).toBe('0')
    expect(localStorage.getItem('zbb.displayName')).toBe('Owner')
    // The access token is in-memory only — it must never touch localStorage.
    expect(allStoredValues()).not.toContain('tok-secret-xyz')
  })

  // REG-037 / REG-038 — a wrong password (and, identically, an unknown email) shows
  // the generic credential error; the form stays put with fields intact.
  it('REG-037/REG-038: wrong credentials show the generic error and keep the form filled with no navigation', async () => {
    mockPost.mockRejectedValue(axiosError({ error: 'Invalid email or password.' }, 401))
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x')
    await user.click(submitButton('Sign in'))

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent('Invalid email or password.')
    expect(screen.getByLabelText('Email')).toHaveValue('owner@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('WrongPass1x')
    expect(screen.getByTestId('loc').textContent).toContain('/login')
    expect(screen.queryByText('HOME')).not.toBeInTheDocument()
  })

  // REG-044 — the account-locked 401 message (a `{error}` string) renders verbatim
  // in the alert. (The 5-failure counting + 15-min expiry live server-side/e2e.)
  it('REG-044: the account-locked message renders verbatim in the alert', async () => {
    mockPost.mockRejectedValue(
      axiosError(
        {
          error:
            'Your account is temporarily locked after too many failed sign-in attempts. Please try again in a few minutes.',
        },
        401,
      ),
    )
    const user = userEvent.setup()
    renderAt('/login')

    await user.type(screen.getByLabelText('Email'), 'lockme@example.test')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x')
    await user.click(submitButton('Sign in'))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'Your account is temporarily locked after too many failed sign-in attempts. Please try again in a few minutes.',
    )
  })

  // REG-040 — sign-in client validation: both fields empty blocks the POST (required).
  it('REG-040: empty sign-in fields block the login POST client-side', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login')

    await user.click(submitButton('Sign in'))
    expect(mockPost).not.toHaveBeenCalled()
  })

  // REG-041 — an unsafe returnUrl is discarded and sign-in lands on "/" (the safe
  // internal case is already covered in LoginPage.test.tsx).
  it('REG-041: an off-origin returnUrl is discarded and sign-in lands on the dashboard', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login?returnUrl=https%3A%2F%2Fevil.example')

    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'Sunlit-Meadow-42a')
    await user.click(submitButton('Sign in'))

    expect(await screen.findByText('HOME', undefined, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'), { timeout: 5000 })
    expect(screen.queryByText('ELSEWHERE')).not.toBeInTheDocument()
  })

  // REG-043 — the expired-session banner renders only in sign-in mode: it appears on
  // ?reason=expired, hides on the Create-account tab, and returns on Sign in.
  it('REG-043: the expired-session banner shows in sign-in mode, hides in register mode, and returns', async () => {
    const user = userEvent.setup()
    renderAt('/login?reason=expired&returnUrl=%2Ftransactions')

    expect(
      screen.getByText(/Your session has expired, so we signed you out to keep your budget safe/),
    ).toBeInTheDocument()

    await switchToRegister(user)
    expect(screen.queryByText(/Your session has expired/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText(/Your session has expired/)).toBeInTheDocument()
  })

  // REG-043 — without ?reason=expired the banner never renders.
  it('REG-043: plain /login shows no expired-session banner', () => {
    renderAt('/login')
    expect(screen.queryByText(/Your session has expired/)).not.toBeInTheDocument()
  })

  // REG-027 — BUG (confirmed): when the server returns the ASP.NET
  // ValidationProblemDetails shape — `errors` as an OBJECT (`{errors:{FirstName:[…]}}`),
  // which is what fires for whitespace-only names the client trims to "" — LoginPage's
  // `data?.errors?.join(' ')` throws `TypeError: …join is not a function`. The throw
  // escapes the catch, so NO alert renders and `finally` re-enables the submit button:
  // the user is left with a re-enabled "Create account" button and no explanation.
  // Catalog REG-027 Expected: "The form must surface a visible error and stay usable."
  // Skipped (not weakened) until LoginPage handles the errors-object shape (e.g. flatten
  // Object.values(errors).flat(), or guard Array.isArray(errors) before .join).
  it('REG-027 BUG: a ValidationProblemDetails errors-object body must surface a visible error, not a TypeError', async () => {
    mockPost.mockRejectedValue(
      axiosError({ errors: { FirstName: ['The FirstName field is required.'] } }),
    )
    const user = userEvent.setup()
    renderAt('/login?register=1')

    // Whitespace-only names pass HTML5 required, then the client trims them to "".
    await user.type(screen.getByLabelText('First name'), '   ')
    await user.type(screen.getByLabelText('Last name'), '   ')
    await user.type(screen.getByLabelText('Email'), 'reg-027@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    // Correct behaviour: a visible, announced error message — never a swallowed TypeError.
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // ---- Analytics wiring ----------------------------------------------------

  // REG-050 — a successful registration fires one sign_up event carrying method AND
  // the sample_data flag (whitelisted param — must not be dropped).
  it('REG-050: a successful registration fires sign_up with method + sample_data', async () => {
    mockPost.mockResolvedValue({ data: authResponse() })
    const user = userEvent.setup()
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'reg-050@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /sample figures/i }))
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    await waitFor(
      () =>
        expect(track).toHaveBeenCalledWith(EVENTS.signUp, { method: 'password', sample_data: true }),
      { timeout: 5000 },
    )
  })

  // REG-050 — sign-in fires `login` on success and `login_failed` on a bad attempt.
  it('REG-050: sign-in fires login on success and login_failed on failure', async () => {
    const user = userEvent.setup()

    // Failure leg.
    mockPost.mockRejectedValue(axiosError({ error: 'Invalid email or password.' }, 401))
    const view = renderAt('/login')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'WrongPass1x')
    await user.click(submitButton('Sign in'))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.loginFailed, { method: 'password' }), {
      timeout: 5000,
    })
    view.unmount()

    // Success leg.
    vi.mocked(track).mockClear()
    mockPost.mockResolvedValue({ data: authResponse() })
    renderAt('/login')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'Sunlit-Meadow-42a')
    await user.click(submitButton('Sign in'))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.login, { method: 'password' }), {
      timeout: 5000,
    })
  })

  // REG-051 — sign-in mode offers the "Forgot password?" escape hatch beside the password
  // label; register mode hides it (a brand-new visitor has nothing to reset).
  it('REG-051: "Forgot password?" links to /forgot-password from sign-in mode only', async () => {
    const user = userEvent.setup()
    renderAt('/login')

    const link = screen.getByRole('link', { name: 'Forgot password?' })
    expect(link).toHaveAttribute('href', '/forgot-password')

    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument()
  })

  // REG-081 — the Google credential round-trip: Google's callback POSTs /auth/google with the
  // credential AND the locale-detected money defaults, applies the session, navigates, and
  // reports sign_up vs login from the server's isNewAccount verdict.
  it('REG-081: a Google credential signs in, sends locale defaults, and tracks by isNewAccount', async () => {
    mockPost.mockResolvedValue({ data: { ...authResponse(), isNewAccount: true } })
    renderAt('/login')

    // The divider appears only after the button reports ready.
    await screen.findByText('or')
    expect(googleState.callback).toBeDefined()

    await act(async () => googleState.callback!('google-credential-xyz'))

    await waitFor(() => expect(screen.getByText('HOME')).toBeInTheDocument())
    // Pin the CONCRETE locale-detected values (not just "some string"): the server applies these
    // as a new Google user's home currency, so forwarding the wrong field/a hardcoded value must
    // fail here. jsdom's navigator.language is en-US → GBP/EUR-agnostic detectLocaleDefaults output.
    const detected = detectLocaleDefaults()
    expect(mockPost).toHaveBeenCalledWith('/auth/google', {
      credential: 'google-credential-xyz',
      preferredCurrency: detected.currency,
      numberFormat: detected.numberFormat,
    })
    expect(track).toHaveBeenCalledWith(EVENTS.signUp, { method: 'google' })

    // Existing account: same flow, but the event is login.
    vi.mocked(track).mockClear()
    mockPost.mockResolvedValue({ data: { ...authResponse(), isNewAccount: false } })
    const second = renderAt('/login')
    await second.findByText('or')
    await act(async () => googleState.callback!('google-credential-2'))
    await waitFor(() => expect(track).toHaveBeenCalledWith(EVENTS.login, { method: 'google' }))
  })

  // REG-081 — a rejected credential surfaces the server's error on the card (no bounce, no
  // spurious session-expired redirect) and fires login_failed.
  it('REG-081: a rejected Google credential shows the server error inline', async () => {
    mockPost.mockRejectedValue(
      axiosError({ error: 'Google sign-in could not be verified. Please try again.' }, 401),
    )
    renderAt('/login')
    await screen.findByText('or')

    await act(async () => googleState.callback!('bad-credential'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('could not be verified')
    expect(track).toHaveBeenCalledWith(EVENTS.loginFailed, { method: 'google' })
    // Still on the login page, form intact.
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  // REG-080 — without a build-time client id there is no button and no divider: the card is
  // byte-identical to the password-only experience.
  it('REG-080: no client id means no Google button and no divider', async () => {
    googleState.clientId = ''
    renderAt('/login')

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument())
    expect(screen.queryByText('or')).not.toBeInTheDocument()
    expect(screen.queryByTestId('google-signin')).not.toBeInTheDocument()
    googleState.clientId = 'client-123.apps.googleusercontent.com'
  })

  // REG-093 — registering an email that already has an UNVERIFIED account gets the neutral
  // "check your inbox" panel (a claim link was emailed, no session): the form is replaced, and the
  // app is NOT navigated to.
  it('REG-093: a verification-pending register response shows check-your-inbox, no navigation', async () => {
    const user = userEvent.setup()
    // The server's reclaim response: no token, verificationPending true.
    mockPost.mockResolvedValue({ data: { verificationPending: true, email: 'taken@example.test' } })
    renderAt('/login?register=1')

    await user.type(screen.getByLabelText('First name'), 'Ana')
    await user.type(screen.getByLabelText('Last name'), 'Borg')
    await user.type(screen.getByLabelText('Email'), 'taken@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('checkbox', { name: /I agree to the/ }))
    await user.click(submitButton('Create account'))

    expect(await screen.findByText('Check your inbox', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('taken@example.test')).toBeInTheDocument()
    // Did NOT navigate (would render HOME) and the form is gone.
    expect(screen.queryByText('HOME')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    // No sign_up analytics fires — no account was created (the claim link went to the true owner).
    expect(track).not.toHaveBeenCalledWith(EVENTS.signUp, expect.anything())
    // Not a dead-end: "Use a different email" returns to the form.
    await user.click(screen.getByRole('button', { name: 'Use a different email' }))
    expect(await screen.findByLabelText('First name')).toBeInTheDocument()
  })
})
