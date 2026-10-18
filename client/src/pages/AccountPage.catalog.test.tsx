import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import type { HouseholdMemberDto, MeResponse } from '../types'
import { formatMoney, fromAmount, setMoneyFormat } from '../lib/money'

// Catalog: docs/testing/cases/04-account-preferences.md (prefix PREF).
// AccountPage.test.tsx keeps the mismatch-blocked-without-API, Household-card,
// start-own/leave and locked-currency cases, and the restyle's pencil, dialogs, ⋯ menus and (i)
// hints (restyle PR 12). This file covers the change-password and name/prefs saves, side effects,
// currency relabel, format-immediate-effect, change-password validation, read-only self-serve,
// sharing navigation and theme. Since the restyle the name fields open from the pencil ("Edit
// name"), the password is changed in a dialog opened by the Password row's "Change" (named
// "Change password", so the dialog's own submit is looked up inside the dialog), the explanations
// sit behind (i) buttons, and Disconnect sits behind the Google row's ⋯.
//
// Determinism notes (this RTL suite is flake-prone under parallel workers):
//  - every async wait carries an explicit { timeout: 5000 };
//  - the api mock answers EVERY endpoint the tree loads on mount (/members for the
//    Household provider, /auth/me for everything else);
//  - the money-format module locale is reset in beforeEach so the app-wide
//    formatMoney assertions have a known baseline.

vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))

import { mockGet, mockPut, mockPost, resetApiMocks } from '../test/apiMock'
import { renderWithProviders } from '../test/render'
import { AccountPage } from './AccountPage'
import { useAuth } from '../auth/AuthContext'
import { axiosError } from '../test/fixtures/http'
import { joinedMe, ownerMe } from '../test/fixtures/me'

// ownerMe deliberately omits firstName/lastName/preferredCurrency/numberFormat so the app falls
// back to its defaults (EUR / comma-dot), matching a login that has never customised them.
// readOnlyMe is a Read-only member (role 3) viewing a household they only joined.
const readOnlyMe = joinedMe(3, { userId: 'u3' })

/** Matches the probe's "<CURRENCY> · <household>" line without depending on the middot
 *  glyph — asserts the currency code re-labels alongside the household name. */
function chipShows(currency: string) {
  return (content: string) => content.includes(currency) && content.includes('Your household')
}

/**
 * The app-wide active currency and household, as AuthContext publishes them. The app frame's
 * account button shows only the name and household now (the approved mock-ups), so the
 * currency re-label (PREF-011/013) is read from the context the whole app formats money with.
 */
function CurrencyProbe() {
  const { budgetCurrency, households } = useAuth()
  const household = households.find((h) => h.isActive)?.label
  return <span data-testid="currency-probe">{household ? `${budgetCurrency} · ${household}` : ''}</span>
}

let membersData: HouseholdMemberDto[] = []
let meData: MeResponse = ownerMe

/** The text behind the (i) named `name` (it renders only while open), read as a pointer would. */
async function hintText(user: UserEvent, name: string): Promise<string> {
  const button = await screen.findByRole('button', { name }, { timeout: 5000 })
  await user.hover(button)
  const text = (await screen.findByRole('tooltip', {}, { timeout: 5000 })).textContent ?? ''
  await user.unhover(button)
  return text
}

/** Opens the Change password dialog from the Password row's "Change" (named "Change password"). */
async function openChangePassword(user: UserEvent): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Change password' }, { timeout: 5000 }))
  return screen.findByRole('dialog', { name: 'Change password' }, { timeout: 5000 })
}

function renderPage(opts: { withPeopleRoute?: boolean } = {}) {
  return renderWithProviders(
    <>
      {opts.withPeopleRoute ? (
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="/people" element={<div>PEOPLE PAGE SENTINEL</div>} />
        </Routes>
      ) : (
        <AccountPage />
      )}
      <CurrencyProbe />
    </>,
    { route: '/account', household: true },
  )
}

describe('AccountPage — preferences catalog (PREF)', () => {
  beforeEach(() => {
    resetApiMocks()
    membersData = []
    meData = ownerMe
    mockGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ data: membersData })
      return Promise.resolve({ data: meData })
    })
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    // Known baseline for the app-wide money locale (comma-dot → en-GB).
    setMoneyFormat('comma-dot')
  })

  // PREF-005 — Edit first + last name and save; the details card and the user chip update
  // immediately (side-effects the existing test leaves unasserted), the name is never kept in
  // localStorage (D2), and currency/format ride along unchanged in the payload.
  it('PREF-005: saving a new name updates the details card and the user chip, never localStorage', async () => {
    mockPut.mockResolvedValue({
      data: { firstName: 'Christopher', lastName: 'Borg', displayName: 'Christopher Borg', preferredCurrency: 'EUR', numberFormat: 'comma-dot' },
    })
    const user = userEvent.setup()

    renderPage()

    // The name opens as fields from its pencil.
    await user.click(await screen.findByRole('button', { name: 'Edit name' }, { timeout: 5000 }))
    const first = (await screen.findByLabelText('First name', {}, { timeout: 5000 })) as HTMLInputElement
    const last = screen.getByLabelText('Last name') as HTMLInputElement
    await user.clear(first)
    await user.type(first, 'Christopher')
    await user.clear(last)
    await user.type(last, 'Borg')
    // Hold the typed values against any late /auth/me hydration before submitting.
    await waitFor(
      () => {
        expect(first.value).toBe('Christopher')
        expect(last.value).toBe('Borg')
      },
      { timeout: 5000 },
    )

    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    await waitFor(
      () =>
        expect(mockPut).toHaveBeenCalledWith('/auth/preferences', {
          firstName: 'Christopher',
          lastName: 'Borg',
          preferredCurrency: 'EUR',
          numberFormat: 'comma-dot',
        }),
      { timeout: 5000 },
    )
    expect(await screen.findByText(/preferences have been saved/, {}, { timeout: 5000 })).toBeInTheDocument()

    // The details card "Name" and the user chip re-render to the recomposed display name
    // without a reload; the next cold load reads it from /auth/me, not from storage.
    await waitFor(() => expect(screen.getAllByText('Christopher Borg').length).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    expect(localStorage.getItem('zbb.displayName')).toBeNull()
  })

  // PREF-012 — The Currency select offers exactly the curated 24-currency list and the
  // Number-format select exactly 5 worked-example options, with the helper copy behind the
  // Currency (i).
  it('PREF-012: the currency and number-format selects offer the curated option sets', async () => {
    const user = userEvent.setup()
    renderPage()

    const currency = (await screen.findByLabelText('Currency', {}, { timeout: 5000 })) as HTMLSelectElement
    expect(currency.options.length).toBe(24)
    expect(currency.options[0].textContent).toBe('Euro (€)')
    expect(currency.options[currency.options.length - 1].textContent).toBe('Turkish lira (₺)')
    expect(screen.getByRole('option', { name: 'US dollar ($)' })).toBeInTheDocument()

    const fmt = screen.getByLabelText('Number format') as HTMLSelectElement
    expect(Array.from(fmt.options).map((o) => o.textContent)).toEqual([
      '1,234.56',
      '1.234,56',
      '1 234,56',
      "1'234.56",
      '1,23,456.78',
    ])

    expect(await hintText(user, 'About these settings')).toMatch(/number format controls the decimal and grouping separators/)
  })

  // PREF-011 — Changing the preferred currency re-labels (never converts): the chip reads
  // the new code, localStorage['zbb.currency'] updates, and the PUT keeps names/format as-is.
  it('PREF-011: changing the currency re-labels the chip and stores it, untouched names/format', async () => {
    mockPut.mockResolvedValue({
      data: { firstName: null, lastName: null, displayName: 'Alex', preferredCurrency: 'USD', numberFormat: 'comma-dot' },
    })
    const user = userEvent.setup()

    renderPage()

    const currency = (await screen.findByLabelText('Currency', {}, { timeout: 5000 })) as HTMLSelectElement
    // Baseline chip reads EUR once /auth/me hydrates the active household label.
    await screen.findAllByText(chipShows('EUR'), {}, { timeout: 5000 })

    await user.selectOptions(currency, 'USD')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    await waitFor(
      () =>
        expect(mockPut).toHaveBeenCalledWith('/auth/preferences', {
          firstName: '',
          lastName: '',
          preferredCurrency: 'USD',
          numberFormat: 'comma-dot',
        }),
      { timeout: 5000 },
    )
    await screen.findByText(/preferences have been saved/, {}, { timeout: 5000 })

    await waitFor(() => expect(screen.getAllByText(chipShows('USD')).length).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    expect(localStorage.getItem('zbb.currency')).toBe('USD')
  })

  // PREF-013 — A zero-decimal currency (JPY) re-labels the chip and drops decimals: the
  // same 350 renders 0-dp yen while EUR keeps 2-dp — per-currency minor units, no FX
  // conversion (regression PR #125), driven through the preferences save.
  it('PREF-013: switching to JPY re-labels the chip and renders 0-decimal amounts (no FX)', async () => {
    mockPut.mockResolvedValue({
      data: { firstName: null, lastName: null, displayName: 'Alex', preferredCurrency: 'JPY', numberFormat: 'comma-dot' },
    })
    const user = userEvent.setup()

    renderPage()

    const currency = (await screen.findByLabelText('Currency', {}, { timeout: 5000 })) as HTMLSelectElement
    await screen.findAllByText(chipShows('EUR'), {}, { timeout: 5000 })

    await user.selectOptions(currency, 'JPY')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    await screen.findByText(/preferences have been saved/, {}, { timeout: 5000 })
    await waitFor(() => expect(screen.getAllByText(chipShows('JPY')).length).toBeGreaterThanOrEqual(1), { timeout: 5000 })

    // Yen carries no minor unit: "350" with no fractional part; EUR still shows 2 decimals.
    const yen = formatMoney(fromAmount(350), 'JPY')
    expect(yen).toContain('350')
    expect(yen).not.toMatch(/350[.,]\d/)
    expect(formatMoney(fromAmount(350), 'EUR')).toContain('350.00')
  })

  // PREF-015 — A number-format change takes effect app-wide immediately (no reload): the
  // module-level locale swaps so every consumer re-renders German-style grouping, and the
  // choice is stored. Currency is independent and unchanged.
  it('PREF-015: saving a number format re-renders money app-wide immediately and stores it', async () => {
    mockPut.mockResolvedValue({
      data: { firstName: null, lastName: null, displayName: 'Alex', preferredCurrency: 'EUR', numberFormat: 'dot-comma' },
    })
    const user = userEvent.setup()

    renderPage()

    const fmt = (await screen.findByLabelText('Number format', {}, { timeout: 5000 })) as HTMLSelectElement
    await waitFor(() => expect(fmt.value).toBe('comma-dot'), { timeout: 5000 })
    // Before: en-GB grouping.
    expect(formatMoney(fromAmount(1234.56), 'EUR')).toContain('1,234.56')

    await user.selectOptions(fmt, 'dot-comma')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    await screen.findByText(/preferences have been saved/, {}, { timeout: 5000 })

    // After: setMoneyFormat swapped the active locale — consumers now render de-DE grouping.
    expect(formatMoney(fromAmount(1234.56), 'EUR')).toContain('1.234,56')
    expect(localStorage.getItem('zbb.numberFormat')).toBe('dot-comma')
    expect(mockPut).toHaveBeenCalledWith('/auth/preferences', {
      firstName: '',
      lastName: '',
      preferredCurrency: 'EUR',
      numberFormat: 'dot-comma',
    })
  })

  // PREF-018 — A failed preferences save applies nothing (no optimistic application): the
  // error banner shows, the app-wide format is unchanged, and the form keeps the unsaved
  // pick so the user can retry.
  it('PREF-018: a failed preferences save applies nothing app-wide (no optimistic switch)', async () => {
    mockPut.mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()

    renderPage()

    const fmt = (await screen.findByLabelText('Number format', {}, { timeout: 5000 })) as HTMLSelectElement
    await waitFor(() => expect(fmt.value).toBe('comma-dot'), { timeout: 5000 })

    await user.selectOptions(fmt, 'dot-comma')
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Could not save your preferences.')
    // The active money format never changed (still en-GB), and the select keeps the unsaved value.
    expect(formatMoney(fromAmount(1234.56), 'EUR')).toContain('1,234.56')
    expect(fmt.value).toBe('dot-comma')
    // The stored preference is still the hydrated baseline — the failed save persisted nothing.
    expect(localStorage.getItem('zbb.numberFormat')).toBe('comma-dot')
  })

  // PREF-022 — A successful change clears all three fields and keeps THIS device signed in
  // (the 200 AuthResponse is adopted, no bounce to /login). Extends the existing happy path,
  // which asserts only the POST + success line. The dialog closes on success, so the cleared
  // fields are checked by opening it again.
  it('PREF-022: a successful password change clears the fields and keeps this device signed in', async () => {
    mockPost.mockResolvedValue({
      data: { token: 'fresh-token', expiresAtUtc: '2999-01-01T00:00:00Z', userId: 'u1', email: 'alex@x.com', role: 0, displayName: 'Alex' },
    })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    const current = within(dialog).getByLabelText('Current password') as HTMLInputElement
    const next = within(dialog).getByLabelText('New password') as HTMLInputElement
    const confirm = within(dialog).getByLabelText('Confirm new password') as HTMLInputElement
    await user.type(current, 'Sunlit-Meadow-42a')
    await user.type(next, 'Aa1-fresh-secret')
    await user.type(confirm, 'Aa1-fresh-secret')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith('/auth/change-password', {
          currentPassword: 'Sunlit-Meadow-42a',
          newPassword: 'Aa1-fresh-secret',
        }),
      { timeout: 5000 },
    )
    expect(await screen.findByText(/password has been changed/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(current).not.toBeInTheDocument()

    // No navigation — the change-password form is still reachable and usable, its three fields empty.
    const again = await openChangePassword(user)
    await waitFor(
      () => {
        expect((within(again).getByLabelText('Current password') as HTMLInputElement).value).toBe('')
        expect((within(again).getByLabelText('New password') as HTMLInputElement).value).toBe('')
        expect((within(again).getByLabelText('Confirm new password') as HTMLInputElement).value).toBe('')
      },
      { timeout: 5000 },
    )
    expect(within(again).getByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  // PREF-024 — A wrong current password surfaces the Identity message verbatim and keeps
  // the entered values (no clear-on-error), with no success line.
  it('PREF-024: a wrong current password shows the Identity error and keeps the values', async () => {
    mockPost.mockRejectedValue(axiosError({ errors: ['Incorrect password.'] }))
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    const current = within(dialog).getByLabelText('Current password') as HTMLInputElement
    await user.type(current, 'Wrong-Guess-99z')
    await user.type(within(dialog).getByLabelText('New password'), 'Aa1-fresh-secret')
    await user.type(within(dialog).getByLabelText('Confirm new password'), 'Aa1-fresh-secret')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Incorrect password.')
    expect(screen.queryByText(/password has been changed/)).not.toBeInTheDocument()
    // Session untouched, values kept for correction (the dialog stays open).
    expect(current).toBeInTheDocument()
    expect(current.value).toBe('Wrong-Guess-99z')
  })

  // PREF-027 — Identity complexity failures surface, and multiple messages join into a
  // single banner line (`errors.join(' ')`).
  it('PREF-027: multiple new-password complexity errors join into one banner line', async () => {
    const upper = "Passwords must have at least one uppercase letter ('A'-'Z')."
    const digit = "Passwords must have at least one digit ('0'-'9')."
    mockPost.mockRejectedValue(axiosError({ errors: [upper, digit] }))
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
    await user.type(within(dialog).getByLabelText('New password'), 'alllowercase')
    await user.type(within(dialog).getByLabelText('Confirm new password'), 'alllowercase')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

    const banner = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(banner).toHaveTextContent(upper)
    expect(banner).toHaveTextContent(digit)
    expect(banner.textContent).toBe(`${upper} ${digit}`)
  })

  // PREF-028 — A breached new password is rejected by the HIBP check and the exact message
  // reaches the banner through the change-password UI path (unasserted at the UI until now).
  it('PREF-028: a breached new password surfaces the HIBP rejection message', async () => {
    const hibp = 'This password has appeared in a known data breach. Please choose a different one.'
    mockPost.mockRejectedValue(axiosError({ errors: [hibp] }))
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    await user.type(within(dialog).getByLabelText('Current password'), 'Sunlit-Meadow-42a')
    await user.type(within(dialog).getByLabelText('New password'), 'Password123')
    await user.type(within(dialog).getByLabelText('Confirm new password'), 'Password123')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(hibp)
    expect(screen.queryByText(/password has been changed/)).not.toBeInTheDocument()
  })

  // PREF-026 — New-password length boundary: a 7-character password never reaches the API
  // (native minLength=8 OR the JS length backstop, whichever the browser applies), while
  // exactly 8 characters meeting the policy is accepted — 8 is inclusive.
  it('PREF-026: a 7-char new password never hits the API; exactly 8 is accepted', async () => {
    mockPost.mockResolvedValue({ data: null })
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    const submit = within(dialog).getByRole('button', { name: 'Change password' })
    const current = within(dialog).getByLabelText('Current password')
    const next = within(dialog).getByLabelText('New password') as HTMLInputElement
    const confirm = within(dialog).getByLabelText('Confirm new password') as HTMLInputElement
    await user.type(current, 'Sunlit-Meadow-42a')
    await user.type(next, 'Aa1xyzw') // 7 characters
    await user.type(confirm, 'Aa1xyzw')
    await user.click(submit)

    // Blocked below the minimum — no request, no success.
    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.queryByText(/password has been changed/)).not.toBeInTheDocument()

    // Exactly 8 characters, digit + upper + lower — accepted.
    await user.clear(next)
    await user.type(next, 'Aa1xyzw2') // 8 characters
    await user.clear(confirm)
    await user.type(confirm, 'Aa1xyzw2')
    await user.click(submit)

    await waitFor(
      () =>
        expect(mockPost).toHaveBeenCalledWith('/auth/change-password', {
          currentPassword: 'Sunlit-Meadow-42a',
          newPassword: 'Aa1xyzw2',
        }),
      { timeout: 5000 },
    )
    expect(await screen.findByText(/password has been changed/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // PREF-033 — A Read-only member can still self-serve: the shell shows the read-only
  // banner, but the Preferences and Change-password forms are fully enabled (no role gate),
  // and a preferences save goes through.
  it('PREF-033: a read-only member can still edit their own preferences and password', async () => {
    meData = readOnlyMe
    mockPut.mockResolvedValue({
      data: { firstName: 'Sam', lastName: null, displayName: 'Sam', preferredCurrency: 'EUR', numberFormat: 'dot-comma' },
    })
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText(/read-only access/, {}, { timeout: 5000 })).toBeInTheDocument()
    const saveBtn = screen.getByRole('button', { name: 'Save preferences' })
    expect(saveBtn).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Edit name' }))
    expect(screen.getByLabelText('First name')).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('Number format'), 'dot-comma')
    await user.click(saveBtn)

    await waitFor(
      () =>
        expect(mockPut).toHaveBeenCalledWith('/auth/preferences', {
          firstName: '',
          lastName: '',
          preferredCurrency: 'EUR',
          numberFormat: 'dot-comma',
        }),
      { timeout: 5000 },
    )
    expect(await screen.findByText(/preferences have been saved/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // PREF-034 — The solo sharing row ("Just you") carries the on-your-own copy behind its (i) and
  // its "Share this budget" button navigates (SPA) to /people. Extends the existing test, which
  // asserts only the button's presence.
  it('PREF-034: the solo Sharing card explains sharing and navigates to /people', async () => {
    membersData = []
    const user = userEvent.setup()

    renderPage({ withPeopleRoute: true })

    const shareBtn = await screen.findByRole('button', { name: 'Share this budget' }, { timeout: 5000 })
    expect(await hintText(user, 'About sharing')).toMatch(/budgeting on your own/)

    await user.click(shareBtn)
    expect(await screen.findByText('PEOPLE PAGE SENTINEL', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // PREF-036 — An explicit theme pick applies instantly (the <html> gains/loses `dark`),
  // reflects aria-pressed, and persists to localStorage['zbb.theme'] on this device. The
  // control is the top bar's Dark mode toggle.
  it('PREF-036: picking a theme applies it instantly and persists on this device', async () => {
    const user = userEvent.setup()

    renderPage()

    const darkBtn = await screen.findByRole('button', { name: 'Dark mode' }, { timeout: 5000 })
    // Fresh profile, jsdom has no matchMedia → defaults to light.
    expect(document.documentElement).not.toHaveClass('dark')
    expect(darkBtn).toHaveAttribute('aria-pressed', 'false')

    await user.click(darkBtn)
    expect(document.documentElement).toHaveClass('dark')
    expect(darkBtn).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('zbb.theme')).toBe('dark')

    await user.click(darkBtn)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(darkBtn).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem('zbb.theme')).toBe('light')
  })

  // PREF-040 — a Google-created (passwordless) login sees no change-password form; instead the
  // Password row's "Set a password" (the forgot-password flow), with the add-a-password note behind
  // its (i). A password login keeps the form.
  it('PREF-040: a passwordless login gets an add-password note, not a change-password form', async () => {
    meData = { ...ownerMe, hasPassword: false } as typeof ownerMe
    const user = userEvent.setup()

    renderPage()

    // The row is titled Password and the form is gone.
    expect(await screen.findByRole('heading', { name: 'Password' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()

    // The way to ADD a password is the (passwordless-safe) forgot-password flow.
    const link = screen.getByRole('link', { name: 'Set a password' })
    expect(link).toHaveAttribute('href', '/forgot-password')
    expect(await hintText(user, 'About the password')).toMatch(/sign in with Google/i)
  })

  // PREF-040 — the ordinary password login is unchanged: the change-password form is present
  // (in the dialog the Password row's "Change" opens), and no "Set a password".
  it('PREF-040: a password login keeps the change-password form', async () => {
    meData = { ...ownerMe, hasPassword: true } as typeof ownerMe
    const user = userEvent.setup()

    renderPage()

    const dialog = await openChangePassword(user)
    expect(within(dialog).getByRole('heading', { name: 'Change password' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Current password')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Set a password' })).not.toBeInTheDocument()
  })

  // PREF-041 — the Google row only shows when Google is linked; with a password, Disconnect (behind
  // the row's ⋯) is enabled and POSTs /auth/google/unlink; the reissued session is applied.
  it('PREF-041: a linked login with a password can disconnect Google', async () => {
    meData = { ...ownerMe, hasGoogle: true, hasPassword: true } as typeof ownerMe
    mockPost.mockResolvedValue({
      data: { token: 't2', expiresAtUtc: '2999-01-01T00:00:00Z', userId: 'u1', email: 'alex@x.com', role: 0, displayName: 'Alex' },
    })
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Google: more actions' }, { timeout: 5000 }))
    const disconnect = await screen.findByRole('menuitem', { name: 'Disconnect' }, { timeout: 5000 })
    expect(disconnect).not.toHaveAttribute('aria-disabled')
    await user.click(disconnect)

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/google/unlink'), { timeout: 5000 })
    expect(await screen.findByText('Google has been disconnected.')).toBeInTheDocument()
  })

  // PREF-041 — a passwordless linked login can't disconnect (it's the only way in): the menu item is
  // disabled and the line under it explains to set a password first.
  it('PREF-041: a passwordless linked login sees Disconnect disabled with a set-a-password hint', async () => {
    meData = { ...ownerMe, hasGoogle: true, hasPassword: false } as typeof ownerMe
    const user = userEvent.setup()

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Google: more actions' }, { timeout: 5000 }))
    const disconnect = await screen.findByRole('menuitem', { name: 'Disconnect' }, { timeout: 5000 })
    expect(disconnect).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/only way to sign in, so it can't be disconnected/i)).toBeInTheDocument()
    expect(disconnect).toHaveAccessibleDescription(/only way to sign in, so it can't be disconnected/i)
    await user.click(disconnect)
    expect(mockPost).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    // The way to set one is the Password row's "Set a password" — it points at /forgot-password.
    const setLinks = screen.getAllByRole('link', { name: 'Set a password' })
    expect(setLinks.length).toBeGreaterThanOrEqual(1)
    setLinks.forEach((l) => expect(l).toHaveAttribute('href', '/forgot-password'))
  })

  // PREF-041 — no Google linked ⇒ no Google row (and no "Connected accounts" card) at all.
  it('PREF-041: no card when Google is not linked', async () => {
    meData = { ...ownerMe, hasGoogle: false } as typeof ownerMe

    renderPage()

    await screen.findByRole('heading', { name: 'Sign-in' }, { timeout: 5000 })
    await screen.findByRole('button', { name: 'Change password' }, { timeout: 5000 })
    expect(screen.queryByRole('heading', { name: 'Connected accounts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Google' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Google: more actions' })).not.toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })
})
