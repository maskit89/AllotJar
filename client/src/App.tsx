import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'
import { useEffect, useRef, useState, type JSX } from 'react'
import { safeInternalPath } from './lib/returnUrl'
import { hasNewerBuild, isMidEntry, RELOAD_AFTER_MS, useOnReturn } from './lib/appReturn'
import { useAuth } from './auth/AuthContext'
import { JarLogo } from './components/Jar'
import { ConsentModal } from './components/ConsentModal'
import { PasswordChangeModal } from './components/PasswordChangeModal'
import { useFeatures } from './features/FeatureContext'
import { MonthProvider } from './features/MonthContext'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { ConfirmEmailPage } from './pages/ConfirmEmailPage'
import { LandingPage } from './pages/LandingPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { TermsPage } from './pages/TermsPage'
import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { AccountPage } from './pages/AccountPage'
import { PeoplePage } from './pages/PeoplePage'
import { DashboardPage } from './pages/DashboardPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { AccountsPage } from './pages/AccountsPage'
import { AccountDetailPage } from './pages/AccountDetailPage'
import { JarsPage } from './pages/JarsPage'
import { AllocationPage } from './pages/AllocationPage'
import { ReportsPage } from './pages/ReportsPage'
import { ImportPage } from './pages/ImportPage'
import { HelpPage } from './pages/HelpPage'
import { Onboarding } from './onboarding/Onboarding'
import { OperatorBar } from './components/OperatorBar'

/**
 * The boot splash while the session is restored from the refresh cookie (restyle PR 20): the warm
 * page of the signed-out frame, quiet (the sage page deepening into its floor, no room, no card),
 * with the wordmark and a slim loading line under it. It fades in after a beat, so a quick restore
 * shows only the page's own colour, never a flash of the mark. Announced once as "Loading…".
 */
function AuthSplash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="splash-mark" aria-hidden>
        <span className="splash-brand">
          <JarLogo size={40} />
          <span className="splash-name">
            Allot<span>Jar</span>
          </span>
        </span>
        <span className="splash-line">
          <span />
        </span>
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isAuthenticated, bootstrapping } = useAuth()
  const location = useLocation()
  // Don't bounce to /login while we're still restoring the session from the refresh cookie.
  if (bootstrapping) return <AuthSplash />
  if (isAuthenticated) return children
  // Keep where they were headed so signing in lands them there, not on the dashboard.
  const here = `${location.pathname}${location.search}`
  const suffix = here !== '/' ? `?returnUrl=${encodeURIComponent(here)}` : ''
  return <Navigate to={`/login${suffix}`} replace />
}

/** The pages that show figures and keep unsaved work only in a dialog or a `data-entry` editor
 *  (not Import's review). */
const FIGURE_PAGE = /^\/(transactions|jars|accounts(\/[^/]+)?|reports|allocation)?\/?$/

/** An already-signed-in visit to /login honours ?returnUrl= (e.g. back to an invite link). */
function AuthedLoginRedirect() {
  const [params] = useSearchParams()
  return <Navigate to={safeInternalPath(params.get('returnUrl')) ?? '/'} replace />
}

export default function App() {
  const { isAuthenticated, bootstrapping, needsConsent, mustChangePassword } = useAuth()
  const features = useFeatures()

  // While a temporary password is pending the server refuses every page's reads (S-P2-3). Once
  // the login chooses its own, remount the routes so each page loads afresh behind the closed
  // prompt. Only on that change: remounting when the flag first arrives from /auth/me would wipe
  // a form already being filled, such as the emailed link's new-password page.
  const [routesEpoch, setRoutesEpoch] = useState(0)
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !mustChangePassword) setRoutesEpoch((n) => n + 1)
    wasPending.current = mustChangePassword
  }, [mustChangePassword])

  // A page reads its figures when it opens, and a phone usually resumes the installed app rather
  // than starting it afresh. So when someone comes back after a while, remount the page as a
  // fresh start would, and it reads its figures again (a partner's changes included); if a
  // deploy has happened meanwhile, reload the whole app instead, so nobody keeps saving through
  // an old build. Only the figure pages, never part-way through an entry (a focused field, an
  // open dialog or inline editor, so nothing typed is lost) and never offline, where the
  // figures already on screen beat a page that can't load.
  const { pathname } = useLocation()
  useOnReturn((awayMs) => {
    if (!isAuthenticated || awayMs < RELOAD_AFTER_MS || !FIGURE_PAGE.test(pathname)) return
    if (navigator.onLine === false || isMidEntry()) return
    void hasNewerBuild().then((newer) => {
      if (isMidEntry()) return // they started typing while the check ran
      if (newer) window.location.reload()
      else setRoutesEpoch((n) => n + 1)
    })
  })

  return (
    <MonthProvider>
      <Routes key={routesEpoch}>
        <Route
          path="/login"
          element={
            bootstrapping ? <AuthSplash /> : isAuthenticated ? <AuthedLoginRedirect /> : <LoginPage />
          }
        />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        {/* Password reset — public: the whole point is having no working credential. The reset
            link must work in a fresh browser, so neither route depends on auth state. */}
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        {/* Public legal pages — crawlable, available signed in or out. */}
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route
          path="/"
          element={
            // The root is the public marketing landing page for anonymous visitors
            // and the dashboard for signed-in users. Show the splash while we're
            // still restoring the session so authed users don't flash the landing.
            bootstrapping ? <AuthSplash /> : isAuthenticated ? <DashboardPage /> : <LandingPage />
          }
        />
        <Route
          path="/transactions"
          element={
            <RequireAuth>
              <TransactionsPage />
            </RequireAuth>
          }
        />
        {features.accounts && (
          <Route
            path="/accounts"
            element={
              <RequireAuth>
                <AccountsPage />
              </RequireAuth>
            }
          />
        )}
        {features.accounts && (
          <Route
            path="/accounts/:id"
            element={
              <RequireAuth>
                <AccountDetailPage />
              </RequireAuth>
            }
          />
        )}
        {features.jars && (
          <Route
            path="/jars"
            element={
              <RequireAuth>
                <JarsPage />
              </RequireAuth>
            }
          />
        )}
        {features.householdAllocation && (
          <Route
            path="/people"
            element={
              <RequireAuth>
                <PeoplePage />
              </RequireAuth>
            }
          />
        )}
        {/* The People page replaces the old Members + Members & access pages. */}
        <Route path="/members" element={<Navigate to="/people" replace />} />
        <Route path="/access" element={<Navigate to="/people" replace />} />
        {features.householdAllocation && (
          <Route
            path="/allocation"
            element={
              <RequireAuth>
                <AllocationPage />
              </RequireAuth>
            }
          />
        )}
        {features.reports && (
          <Route
            path="/reports"
            element={
              <RequireAuth>
                <ReportsPage />
              </RequireAuth>
            }
          />
        )}
        <Route
          path="/account"
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        {features.camtImport && (
          <Route
            path="/import"
            element={
              <RequireAuth>
                <ImportPage />
              </RequireAuth>
            }
          />
        )}
        <Route
          path="/help"
          element={
            <RequireAuth>
              <HelpPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Onboarding waits for consent and for the login's own password, so its focus-trapped
          welcome dialog can never sit (keyboard-unreachable) underneath a blocking prompt. The
          password comes first: until it changes, the server refuses everything else (S-P2-3). */}
      {isAuthenticated && !needsConsent && !mustChangePassword && <Onboarding />}
      {isAuthenticated && !mustChangePassword && <ConsentModal />}
      {isAuthenticated && <PasswordChangeModal />}
      {isAuthenticated && <OperatorBar />}
    </MonthProvider>
  )
}
