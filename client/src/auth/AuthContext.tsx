import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, setToken, refreshSession } from '../lib/api'
import { setMoneyFormat, DEFAULT_CURRENCY_CODE, DEFAULT_FORMAT_KEY } from '../lib/money'
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
  email: string | null
  displayName: string | null
  firstName: string | null
  lastName: string | null
  /** The user's home currency (ISO 4217) — drives the app-wide default + display label. */
  preferredCurrency: string
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
  /** Records the login's own terms acceptance and unblocks the app. */
  confirmConsent: () => Promise<void>
  /** Switch the active household and re-bootstrap the app into it. */
  switchHousehold: (ownerId: string) => Promise<void>
  /** Create the login's own household (Owner + starter budget) and re-bootstrap into it. */
  startOwnBudget: () => Promise<void>
  /** Leave a household the login joined, then re-bootstrap into whatever remains active. */
  leaveHousehold: (ownerId: string) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (input: RegisterInput) => Promise<void>
  acceptInvite: (token: string, password: string, displayName?: string, acceptedTerms?: boolean) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  updatePreferences: (input: PreferencesInput) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | undefined>(undefined)

const EMAIL_KEY = 'zbb.email'
const ROLE_KEY = 'zbb.role'
const NAME_KEY = 'zbb.displayName'
const CURRENCY_KEY = 'zbb.currency'
const FORMAT_KEY = 'zbb.numberFormat'

// The app-wide neutral fallbacks, shared with the backend default and the sign-up
// form (see lib/money.ts). Only used when a user has no stored preference — every
// registered user picks their own currency + money format.
const DEFAULT_CURRENCY = DEFAULT_CURRENCY_CODE
const DEFAULT_FORMAT = DEFAULT_FORMAT_KEY

function storedRole(): number {
  const raw = localStorage.getItem(ROLE_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : HouseholdRole.Owner
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken())
  const [email, setEmail] = useState<string | null>(localStorage.getItem(EMAIL_KEY))
  const [displayName, setDisplayName] = useState<string | null>(localStorage.getItem(NAME_KEY))
  const [firstName, setFirstName] = useState<string | null>(null)
  const [lastName, setLastName] = useState<string | null>(null)
  const [preferredCurrency, setPreferredCurrency] = useState<string>(
    localStorage.getItem(CURRENCY_KEY) || DEFAULT_CURRENCY,
  )
  const [numberFormat, setNumberFormat] = useState<string>(
    localStorage.getItem(FORMAT_KEY) || DEFAULT_FORMAT,
  )
  const [role, setRole] = useState<number>(storedRole())
  const [households, setHouseholds] = useState<HouseholdSummary[]>([])
  const [activeOwnerId, setActiveOwnerId] = useState<string | null>(null)
  const [needsConsent, setNeedsConsent] = useState(false)
  // No in-memory access token on a cold load ⇒ try to restore the session from the refresh cookie.
  const [bootstrapping, setBootstrapping] = useState<boolean>(!getToken())

  // Apply the persisted money format on first mount so a hard reload renders amounts in
  // the user's chosen style before /auth/me round-trips.
  useEffect(() => {
    setMoneyFormat(numberFormat)
    // Intentionally run once; numberFormat changes are applied where they're set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // refreshSession() never rejects (it swallows request errors); .catch only guards an apply() throw.
    refreshSession()
      .then((data) => {
        if (!cancelled && data?.token) apply(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBootstrapping(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function apply(res: AuthResponse) {
    setToken(res.token)
    setTokenState(res.token)
    setEmail(res.email)
    setRole(res.role)
    setDisplayName(res.displayName)
    localStorage.setItem(EMAIL_KEY, res.email)
    localStorage.setItem(ROLE_KEY, String(res.role))
    if (res.displayName) localStorage.setItem(NAME_KEY, res.displayName)
    else localStorage.removeItem(NAME_KEY)
  }

  // Refresh role + profile/preferences from the server whenever there's a token — a role
  // change (or revoke) and the user's saved preferences both take effect on next load.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const request = api.get<MeResponse>('/auth/me')
    // Guard against a non-promise (e.g. an incomplete mock) so the provider never throws.
    if (!request || typeof request.then !== 'function') return
    request
      .then((res) => {
        const data = res?.data
        // Only adopt a well-formed response — never let a malformed /auth/me downgrade the role.
        if (cancelled || !data || typeof data.role !== 'number') return
        setRole(data.role)
        if (typeof data.email === 'string') setEmail(data.email)
        setDisplayName(data.displayName ?? null)
        setFirstName(data.firstName ?? null)
        setLastName(data.lastName ?? null)
        setHouseholds(Array.isArray(data.households) ? data.households : [])
        setActiveOwnerId(typeof data.ownerId === 'string' ? data.ownerId : null)
        setNeedsConsent(data.needsConsent === true)
        applyPrefs(data.preferredCurrency, data.numberFormat)
        localStorage.setItem(ROLE_KEY, String(data.role))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token])

  async function login(email: string, password: string) {
    const { data } = await api.post<AuthResponse>('/auth/login', { email, password })
    apply(data)
  }

  async function register(input: RegisterInput) {
    const { data } = await api.post<AuthResponse>('/auth/register', input)
    apply(data)
    // The new user picked these at sign-up — apply immediately so the app speaks their
    // currency/format right away (the /auth/me refresh will confirm them).
    setFirstName(input.firstName || null)
    setLastName(input.lastName || null)
    applyPrefs(input.preferredCurrency, input.numberFormat)
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
    await api.post('/auth/change-password', { currentPassword, newPassword })
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

  async function leaveHousehold(ownerId: string) {
    await api.post('/households/leave', { ownerId })
    // Active household may have changed; re-bootstrap so every screen re-scopes.
    window.location.assign('/')
  }

  async function updatePreferences(input: PreferencesInput) {
    const { data } = await api.put<PreferencesResponse>('/auth/preferences', input)
    setFirstName(data.firstName)
    setLastName(data.lastName)
    setDisplayName(data.displayName)
    if (data.displayName) localStorage.setItem(NAME_KEY, data.displayName)
    else localStorage.removeItem(NAME_KEY)
    applyPrefs(data.preferredCurrency, data.numberFormat)
  }

  function clearAuthState() {
    setToken(null)
    setTokenState(null)
    setEmail(null)
    setDisplayName(null)
    setFirstName(null)
    setLastName(null)
    setRole(HouseholdRole.Owner)
    setHouseholds([])
    setActiveOwnerId(null)
    setNeedsConsent(false)
    applyPrefs(DEFAULT_CURRENCY, DEFAULT_FORMAT)
    localStorage.removeItem(EMAIL_KEY)
    localStorage.removeItem(ROLE_KEY)
    localStorage.removeItem(NAME_KEY)
  }

  function logout() {
    // Revoke the refresh token + clear the cookie server-side; don't block the UI on it.
    api.post('/auth/logout').catch(() => {})
    clearAuthState()
  }

  const value = useMemo<AuthState>(
    () => ({
      token,
      email,
      displayName,
      firstName,
      lastName,
      preferredCurrency,
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
      confirmConsent,
      switchHousehold,
      startOwnBudget,
      leaveHousehold,
      login,
      register,
      acceptInvite,
      changePassword,
      updatePreferences,
      logout,
    }),
    [token, email, displayName, firstName, lastName, preferredCurrency, numberFormat, role, bootstrapping, households, activeOwnerId, needsConsent],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
