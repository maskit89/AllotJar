import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  api,
  getToken,
  setToken,
  refreshSession,
  sessionExpired,
  setSessionHandlers,
  isAccessTokenExpired,
} from '../lib/api'
import { broadcastSignOut, onSignOutBroadcast } from '../lib/authChannel'
import { setMoneyFormat, detectLocaleDefaults, DEFAULT_CURRENCY_CODE, DEFAULT_FORMAT_KEY } from '../lib/money'
import { HouseholdRole, type AuthResponse, type HouseholdSummary, type MeResponse, type PreferencesResponse } from '../types'

/** What the sign-up form collects. */
export interface RegisterInput {
  email: string
  password: string
  firstName: string
  lastName: string
  preferredCurrency: string
  numberFormat: string
  acceptedTerms: boolean
}

/** What the account-preferences form submits. */
export interface PreferencesInput {
  firstName: string
  lastName: string
  preferredCurrency: string
  numberFormat: string
}

interface AuthState {
  token: string | null
  /** The signed-in login's id (from the session and /auth/me); null when signed out. */
  userId: string | null
  email: string | null
  displayName: string | null
  firstName: string | null
  lastName: string | null
  /** The login's own currency preference (ISO 4217). It seeds a brand-new household's budget
   *  currency; it never labels money (use budgetCurrency for that). */
  preferredCurrency: string
  /** The active household's budget currency: every account and every counted amount is in it.
   *  Falls back to preferredCurrency until /auth/me says otherwise. */
  budgetCurrency: string
  /** True once the login's own household has accounts, months or transactions, so its budget
   *  currency can no longer be changed. */
  currencyLocked: boolean
  /** The login's own household's budget currency: the one the preference is locked to once
   *  fixed. Falls back to preferredCurrency until /auth/me says otherwise. */
  ownBudgetCurrency: string
  /** The user's money-format preference key (e.g. "dot-comma"). */
  numberFormat: string
  /** Numeric HouseholdRole for the current login (defaults to Owner until resolved). */
  role: number
  isAuthenticated: boolean
  /** Owner only — may manage members and access. */
  canManageHousehold: boolean
  /** Admin and above — may change budget structure, accounts, funds, members. */
  canWrite: boolean
  /** Limited and above (i.e. not read-only) — may record day-to-day data. */
  canEnterData: boolean
  isReadOnly: boolean
  /** True while the app is re-establishing the session from the refresh cookie on a cold load. */
  bootstrapping: boolean
  /** Households this login can act in (for the switcher). Empty/one ⇒ no switcher shown. */
  households: HouseholdSummary[]
  /** OwnerId of the household currently being viewed. */
  activeOwnerId: string | null
  /** True once this login owns a household of its own (false for members who only joined others). */
  ownsHousehold: boolean
  /** True for invite-created logins that haven't accepted the terms yet (blocks the app until they do). */
  needsConsent: boolean
  /** True while the login still has a temporary password someone else set (blocks the app until it is changed). */
  mustChangePassword: boolean
  /** The budget person this login is linked to in the active household (null when none). */
  memberId: string | null
  /** Rule 32: this login should review who sees the personal accounts it holds. */
  sharingReviewPending: boolean
  /** Clears the sharing-review prompt once the login has answered it. */
  clearSharingReview: () => void
  /** Records the login's own terms acceptance and unblocks the app. */
  confirmConsent: () => Promise<void>
  /** Switch the active household and re-bootstrap the app into it. */
  switchHousehold: (ownerId: string) => Promise<void>
  /** Create the login's own (empty) household and re-bootstrap into it to set up a first month. */
  startOwnBudget: () => Promise<void>
  /** Leave a household the login joined, then re-bootstrap into whatever remains active. */
  /** Leaves a joined household; `privateAccounts` is the count the leaver was warned about (D4). */
  leaveHousehold: (ownerId: string, privateAccounts?: number) => Promise<void>
  /** False when the login has no password (Google-created) — the account page adapts. */
  hasPassword: boolean
  /** True when a Google identity is linked to this login. */
  hasGoogle: boolean
  /** Disconnects Google; rejects (throws) if it's the only sign-in method. Refreshes /auth/me. */
  unlinkGoogle: () => Promise<void>
  /** False until the login's email is verified — drives the "confirm your email" banner. */
  emailConfirmed: boolean
  /** Resends the address-verification email for the current login. */
  resendVerification: () => Promise<void>
  /** Marks the email confirmed in live state (the confirm-email page calls this on its 204), so the
   *  banner clears on the next client-side render rather than waiting for a token change or reload. */
  markEmailConfirmed: () => void
  login: (email: string, password: string) => Promise<void>
  /** Exchanges a Google ID token for a session; resolves with whether the account was just created. */
  loginWithGoogle: (credential: string) => Promise<{ isNewAccount: boolean }>
  /** Resolves { verificationPending: true } when the email already had an UNVERIFIED account (a
   *  claim link was emailed and NO session was created); otherwise signs in and resolves {}. */
  register: (input: RegisterInput) => Promise<{ verificationPending?: boolean }>
  acceptInvite: (token: string, password: string, displayName?: string, acceptedTerms?: boolean) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** Requests a reset email. Resolves on 204 whether or not the account exists (no enumeration). */
  forgotPassword: (email: string) => Promise<void>
  /** Redeems an emailed reset token; a successful reset signs this device in. */
  resetPassword: (email: string, token: string, newPassword: string) => Promise<void>
  updatePreferences: (input: PreferencesInput) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | undefined>(undefined)

// Who is signed in (email, name, role) is never kept in the browser's storage: it is read from the
// server on load (D2, client P3-8). These keys held it in older versions and are cleared on start.
const LEGACY_IDENTITY_KEYS = ['zbb.email', 'zbb.role', 'zbb.displayName']
const CURRENCY_KEY = 'zbb.currency'
const BUDGET_CURRENCY_KEY = 'zbb.budgetCurrency'
const FORMAT_KEY = 'zbb.numberFormat'

// The app-wide neutral fallbacks, shared with the backend default and the sign-up
// form (see lib/money.ts). Only used when a user has no stored preference — every
// registered user picks their own currency + money format.
const DEFAULT_CURRENCY = DEFAULT_CURRENCY_CODE
const DEFAULT_FORMAT = DEFAULT_FORMAT_KEY

function clearLegacyIdentity() {
  try {
    for (const key of LEGACY_IDENTITY_KEYS) localStorage.removeItem(key)
  } catch {
    // Storage unavailable (private mode, blocked site data): nothing was kept there either.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken())
  const [userId, setUserId] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [firstName, setFirstName] = useState<string | null>(null)
  const [lastName, setLastName] = useState<string | null>(null)
  const [preferredCurrency, setPreferredCurrency] = useState<string>(
    localStorage.getItem(CURRENCY_KEY) || DEFAULT_CURRENCY,
  )
  const [numberFormat, setNumberFormat] = useState<string>(
    localStorage.getItem(FORMAT_KEY) || DEFAULT_FORMAT,
  )
  // The active household's budget currency (null until known: preferredCurrency stands in).
  const [budgetCurrencyState, setBudgetCurrencyState] = useState<string | null>(
    localStorage.getItem(BUDGET_CURRENCY_KEY),
  )
  const [currencyLocked, setCurrencyLocked] = useState(false)
  const [ownBudgetCurrencyState, setOwnBudgetCurrencyState] = useState<string | null>(null)
  const [role, setRole] = useState<number>(HouseholdRole.Owner)
  // Whether a server answer (sign-in, refresh or /auth/me) has said which role this login has. A
  // cold load whose /auth/me fails before any answer did falls back to the least privileged role,
  // never Owner, so no owner controls show on a guess (PR #307 review P3-5).
  const roleKnown = useRef(false)
  const [households, setHouseholds] = useState<HouseholdSummary[]>([])
  const [activeOwnerId, setActiveOwnerId] = useState<string | null>(null)
  const [needsConsent, setNeedsConsent] = useState(false)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [memberId, setMemberId] = useState<string | null>(null)
  const [sharingReviewPending, setSharingReviewPending] = useState(false)
  // Default TRUE so the change-password card doesn't flicker away for ordinary password logins
  // before /auth/me answers; Google-only accounts flip it to false from the /me payload.
  const [hasPassword, setHasPassword] = useState(true)
  const [hasGoogle, setHasGoogle] = useState(false)
  // Default true so the banner never flashes for a confirmed/returning login before /auth/me;
  // register (new account) sets it false locally, and /auth/me is authoritative.
  const [emailConfirmed, setEmailConfirmed] = useState(true)
  // Once the user confirms in this session (markEmailConfirmed), confirmation is monotonic — there
  // is no "un-confirm" — so a /auth/me still in flight from before the confirm (its response reads
  // the old unverified state) must not downgrade it back. The latch makes the local confirm win
  // regardless of which resolves last. Reset when the identity changes (register/clear).
  const emailConfirmedLatch = useRef(false)
  // No in-memory access token on a cold load ⇒ try to restore the session from the refresh cookie.
  const [bootstrapping, setBootstrapping] = useState<boolean>(!getToken())
  // A cold load that restored a session keeps the splash up until /auth/me answers, so the first
  // screen paints with the server's identity and role rather than a guess (D2: none of it is
  // stored in the browser any more).
  const awaitingProfile = useRef(!getToken())
  function profileSettled() {
    if (!awaitingProfile.current) return
    awaitingProfile.current = false
    setBootstrapping(false)
  }

  useEffect(() => {
    clearLegacyIdentity()
  }, [])

  // Apply the persisted money format on first mount so a hard reload renders amounts in
  // the user's chosen style before /auth/me round-trips.
  useEffect(() => {
    setMoneyFormat(numberFormat)
    // Intentionally run once; numberFormat changes are applied where they're set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Let lib/api.ts reach back into React state: interceptor-driven refreshes re-apply the fresh
  // session (so the /auth/me-on-token-change effect refires and picks up role/preference changes),
  // and a genuinely dead session tears auth state down and tells the other tabs. Registered before
  // the bootstrap effect below so a bootstrap refresh flows through it too.
  useEffect(() => {
    // Guard against incomplete test mocks of lib/api so the provider never throws.
    if (typeof setSessionHandlers !== 'function') return
    setSessionHandlers({
      refreshed: (session) => apply(session),
      expired: () => {
        clearAuthState()
        broadcastSignOut()
      },
    })
    return () => setSessionHandlers(null)
    // apply/clearAuthState only close over stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sign-outs propagate across tabs: another tab logging out (or its session dying) clears this
  // tab's auth state too, so RequireAuth bounces it to /login instead of it keeping a working
  // access token for up to 15 more minutes. Receive-only — never re-broadcasts, so no loops.
  useEffect(() => {
    return onSignOutBroadcast(() => {
      if (getToken()) clearAuthState()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A tab left open while the access token lapses (overnight laptop lid, background tab) should
  // find out the moment the user comes back — not when a stale page's save fails. On focus or
  // becoming visible, if the token's lifetime has passed, revalidate against the refresh cookie:
  // success re-arms the session silently; failure means the session is over → prompt sign-in.
  useEffect(() => {
    function revalidate() {
      // typeof guards: incomplete test mocks of lib/api must never crash the provider.
      if (typeof isAccessTokenExpired !== 'function' || typeof refreshSession !== 'function') return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!isAccessTokenExpired()) return
      // Unreachable (offline, server error): stay signed in; the next request tries again.
      refreshSession()
        .then((session) => {
          if (!session && typeof sessionExpired === 'function') sessionExpired()
        })
        .catch(() => {})
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [])

  // Cold load: the access token lives in memory, so it's gone after a refresh — but the HttpOnly
  // refresh cookie may still be valid. Try once to restore the session before showing sign-in.
  // Uses the shared single-flight refreshSession() (lib/api.ts) rather than POSTing directly: React
  // StrictMode double-invokes this effect in dev, and two /auth/refresh calls racing the same cookie
  // would trip server-side reuse detection and burn every refresh token. Single-flight ⇒ one POST.
  useEffect(() => {
    if (getToken()) {
      setBootstrapping(false)
      return
    }
    let cancelled = false
    // refreshSession() rejects only when the server can't be reached: the visitor then sees sign-in,
    // as with no session. .catch also guards an apply() throw.
    refreshSession()
      .then((data) => {
        if (!cancelled && data?.token) apply(data)
      })
      .catch(() => {})
      .finally(() => {
        // With a session restored, the /auth/me effect ends the bootstrap (profileSettled).
        if (!cancelled && !getToken()) profileSettled()
      })
    return () => {
      cancelled = true
    }
  }, [])

  function applyPrefs(currency: string | null | undefined, format: string | null | undefined) {
    const c = currency || DEFAULT_CURRENCY
    const f = format || DEFAULT_FORMAT
    setPreferredCurrency(c)
    setNumberFormat(f)
    setMoneyFormat(f)
    localStorage.setItem(CURRENCY_KEY, c)
    localStorage.setItem(FORMAT_KEY, f)
  }

  function applyBudgetCurrency(currency: string | null | undefined) {
    const c = typeof currency === 'string' && currency ? currency : null
    setBudgetCurrencyState(c)
    if (c) localStorage.setItem(BUDGET_CURRENCY_KEY, c)
    else localStorage.removeItem(BUDGET_CURRENCY_KEY)
  }

  function apply(res: AuthResponse) {
    setToken(res.token, res.expiresAtUtc)
    setTokenState(res.token)
    setUserId(typeof res.userId === 'string' ? res.userId : null)
    setEmail(res.email)
    roleKnown.current = typeof res.role === 'number'
    setRole(roleKnown.current ? res.role : HouseholdRole.ReadOnly)
    setDisplayName(res.displayName)
  }

  // Refresh role + profile/preferences from the server whenever there's a token — a role
  // change (or revoke) and the user's saved preferences both take effect on next load.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const request = api.get<MeResponse>('/auth/me')
    // Guard against a non-promise (e.g. an incomplete mock) so the provider never throws.
    if (!request || typeof request.then !== 'function') {
      profileSettled()
      return
    }
    request
      .then((res) => {
        if (cancelled) return
        const coldLoad = awaitingProfile.current
        profileSettled()
        const data = res?.data
        // Only adopt a well-formed response — never let a malformed /auth/me downgrade the role.
        if (!data || typeof data.role !== 'number') {
          if (coldLoad && !roleKnown.current) setRole(HouseholdRole.ReadOnly)
          return
        }
        roleKnown.current = true
        setRole(data.role)
        if (typeof data.userId === 'string') setUserId(data.userId)
        if (typeof data.email === 'string') setEmail(data.email)
        setDisplayName(data.displayName ?? null)
        setFirstName(data.firstName ?? null)
        setLastName(data.lastName ?? null)
        setHouseholds(Array.isArray(data.households) ? data.households : [])
        setActiveOwnerId(typeof data.ownerId === 'string' ? data.ownerId : null)
        setNeedsConsent(data.needsConsent === true)
        setMustChangePassword(data.mustChangePassword === true)
        setMemberId(typeof data.memberId === 'string' ? data.memberId : null)
        setSharingReviewPending(data.sharingReviewPending === true)
        setHasPassword(data.hasPassword !== false)
        setHasGoogle(data.hasGoogle === true)
        // Respect a local confirm (see emailConfirmedLatch): never downgrade true→false from a
        // response that predates it. A cold-load unverified user (latch false) still flips to false.
        setEmailConfirmed(emailConfirmedLatch.current || data.emailConfirmed !== false)
        applyPrefs(data.preferredCurrency, data.numberFormat)
        applyBudgetCurrency(data.budgetCurrency)
        setCurrencyLocked(data.currencyLocked === true)
        setOwnBudgetCurrencyState(typeof data.ownBudgetCurrency === 'string' && data.ownBudgetCurrency ? data.ownBudgetCurrency : null)
      })
      .catch(() => {
        if (cancelled) return
        if (awaitingProfile.current && !roleKnown.current) setRole(HouseholdRole.ReadOnly)
        profileSettled()
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function login(email: string, password: string) {
    const { data } = await api.post<AuthResponse>('/auth/login', { email, password })
    apply(data)
  }

  async function loginWithGoogle(credential: string) {
    // Send the browser's locale-detected money defaults along — applied only if this sign-in
    // CREATES the account (register-form parity; the server ignores them otherwise).
    const localeDefaults = detectLocaleDefaults()
    const { data } = await api.post<AuthResponse>('/auth/google', {
      credential,
      preferredCurrency: localeDefaults.currency,
      numberFormat: localeDefaults.numberFormat,
    })
    apply(data)
    return { isNewAccount: data.isNewAccount === true }
  }

  async function unlinkGoogle() {
    // The server rotates the security stamp when it removes the login, so it returns a fresh
    // session (new token + cookie) to keep this device signed in — adopt it, exactly like
    // change-password. The token change re-fires the /auth/me effect, which refreshes hasGoogle;
    // set it here too for an immediate UI update.
    const { data } = await api.post<AuthResponse>('/auth/google/unlink')
    if (data?.token) apply(data)
    setHasGoogle(false)
  }

  async function register(input: RegisterInput) {
    const { data } = await api.post<AuthResponse & { verificationPending?: boolean }>(
      '/auth/register',
      input,
    )
    // Registering an email that already had an UNVERIFIED account emails a claim link and issues
    // NO session (the caller isn't proven to own it) — surface that so the form says so.
    if (!data?.token) {
      return { verificationPending: data?.verificationPending === true }
    }
    apply(data)
    // The new user picked these at sign-up — apply immediately so the app speaks their
    // currency/format right away (the /auth/me refresh will confirm them). A brand-new account is
    // unverified until they click the emailed link.
    setFirstName(input.firstName || null)
    setLastName(input.lastName || null)
    emailConfirmedLatch.current = false
    setEmailConfirmed(false)
    applyPrefs(input.preferredCurrency, input.numberFormat)
    // A brand-new household takes its budget currency from the preference chosen at sign-up.
    applyBudgetCurrency(input.preferredCurrency)
    return {}
  }

  async function resendVerification() {
    await api.post('/auth/resend-verification')
  }

  function markEmailConfirmed() {
    emailConfirmedLatch.current = true
    setEmailConfirmed(true)
  }

  async function acceptInvite(
    inviteToken: string,
    password: string,
    displayName?: string,
    acceptedTerms?: boolean,
  ) {
    const { data } = await api.post<AuthResponse>('/auth/accept-invite', {
      token: inviteToken,
      password,
      displayName,
      acceptedTerms: acceptedTerms === true,
    })
    apply(data)
  }

  async function confirmConsent() {
    await api.post('/auth/consent')
    setNeedsConsent(false)
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    // Changing the password signs out every other device server-side; the response carries a
    // fresh token + rotated cookie so THIS device carries on seamlessly — adopt it.
    const { data } = await api.post<AuthResponse>('/auth/change-password', { currentPassword, newPassword })
    if (data?.token) apply(data)
  }

  async function forgotPassword(email: string) {
    await api.post('/auth/forgot-password', { email })
  }

  async function resetPassword(email: string, token: string, newPassword: string) {
    // Like change-password, the server revokes every other session and answers with a fresh
    // token + cookie for this device — adopt it so the user lands signed in.
    const { data } = await api.post<AuthResponse>('/auth/reset-password', { email, token, newPassword })
    if (data?.token) apply(data)
    // The emailed link is how a direct-invite login chooses its own password (S-P2-3).
    setMustChangePassword(false)
  }

  async function switchHousehold(ownerId: string) {
    await api.post('/households/switch', { ownerId })
    // Every screen's data is scoped to the active household, so re-bootstrap the whole app.
    window.location.assign('/')
  }

  async function startOwnBudget() {
    await api.post('/households/start-own')
    // The server made the new own household active — re-bootstrap into it, greeting them.
    window.location.assign('/?started=1')
  }

  async function leaveHousehold(ownerId: string, privateAccounts = 0) {
    // privateAccounts: how many of this login's private accounts there the leaver was warned
    // about; the server refuses (409, with the count) while it holds more (D4).
    await api.post('/households/leave', { ownerId, privateAccounts })
    // Active household may have changed; re-bootstrap so every screen re-scopes. The ?left=1
    // greeting explains the landing — a pure invitee's own household starts with no months,
    // and an unexplained blank dashboard would read as data loss.
    window.location.assign('/?left=1')
  }

  async function updatePreferences(input: PreferencesInput) {
    const { data } = await api.put<PreferencesResponse>('/auth/preferences', input)
    setFirstName(data.firstName)
    setLastName(data.lastName)
    setDisplayName(data.displayName)
    applyPrefs(data.preferredCurrency, data.numberFormat)
    // The login's own household takes its budget currency from the preference until it has
    // accounts, months or transactions (then the server refuses a change). Adopt the server's
    // figure when it sends one; otherwise follow the preference while viewing an unlocked own one.
    if (typeof data.budgetCurrency === 'string' && data.budgetCurrency) applyBudgetCurrency(data.budgetCurrency)
    else if (!currencyLocked && households.some((h) => h.isActive && h.isOwn)) applyBudgetCurrency(data.preferredCurrency)
    if (typeof data.currencyLocked === 'boolean') setCurrencyLocked(data.currencyLocked)
  }

  function clearAuthState() {
    setToken(null)
    setTokenState(null)
    setUserId(null)
    setEmail(null)
    setDisplayName(null)
    setFirstName(null)
    setLastName(null)
    roleKnown.current = false
    setRole(HouseholdRole.Owner)
    setHouseholds([])
    setActiveOwnerId(null)
    setNeedsConsent(false)
    setMustChangePassword(false)
    setHasPassword(true)
    setHasGoogle(false)
    emailConfirmedLatch.current = false
    setEmailConfirmed(true)
    applyPrefs(DEFAULT_CURRENCY, DEFAULT_FORMAT)
    applyBudgetCurrency(null)
    setCurrencyLocked(false)
    // The next login in this tab must not inherit who this one was (CL-P3-2).
    setOwnBudgetCurrencyState(null)
    setMemberId(null)
    setSharingReviewPending(false)
    clearLegacyIdentity()
    // A session that died while the bootstrap waited for /auth/me ends the splash too.
    profileSettled()
  }

  function logout() {
    // Revoke the refresh token + clear the cookie server-side; don't block the UI on it.
    api.post('/auth/logout').catch(() => {})
    clearAuthState()
    broadcastSignOut()
  }

  const value = useMemo<AuthState>(
    () => ({
      token,
      userId,
      email,
      displayName,
      firstName,
      lastName,
      preferredCurrency,
      budgetCurrency: budgetCurrencyState || preferredCurrency,
      currencyLocked,
      ownBudgetCurrency: ownBudgetCurrencyState ?? preferredCurrency,
      numberFormat,
      role,
      isAuthenticated: !!token,
      canManageHousehold: role === HouseholdRole.Owner,
      canWrite: role <= HouseholdRole.Admin,
      canEnterData: role <= HouseholdRole.Limited,
      isReadOnly: role === HouseholdRole.ReadOnly,
      bootstrapping,
      households,
      activeOwnerId,
      ownsHousehold: households.some((h) => h.isOwn),
      needsConsent,
      mustChangePassword,
      memberId,
      sharingReviewPending,
      clearSharingReview: () => setSharingReviewPending(false),
      hasPassword,
      hasGoogle,
      unlinkGoogle,
      emailConfirmed,
      resendVerification,
      markEmailConfirmed,
      confirmConsent,
      switchHousehold,
      startOwnBudget,
      leaveHousehold,
      login,
      loginWithGoogle,
      register,
      acceptInvite,
      changePassword,
      forgotPassword,
      resetPassword,
      updatePreferences,
      logout,
    }),
    [token, userId, email, displayName, firstName, lastName, preferredCurrency, budgetCurrencyState, currencyLocked, ownBudgetCurrencyState, numberFormat, role, bootstrapping, households, activeOwnerId, needsConsent, mustChangePassword, memberId, sharingReviewPending, hasPassword, hasGoogle, emailConfirmed],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
