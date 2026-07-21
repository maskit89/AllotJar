import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'
import type { JSX } from 'react'
import { safeInternalPath } from './lib/returnUrl'
import { useAuth } from './auth/AuthContext'
import { ConsentModal } from './components/ConsentModal'
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

function AuthSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500"
        aria-hidden="true"
      />
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

/** An already-signed-in visit to /login honours ?returnUrl= (e.g. back to an invite link). */
function AuthedLoginRedirect() {
  const [params] = useSearchParams()
  return <Navigate to={safeInternalPath(params.get('returnUrl')) ?? '/'} replace />
}

export default function App() {
  const { isAuthenticated, bootstrapping, needsConsent } = useAuth()
  const features = useFeatures()

  return (
    <MonthProvider>
      <Routes>
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
      {/* Onboarding waits for consent, so its focus-trapped welcome dialog can never sit
          (keyboard-unreachable) underneath the blocking consent prompt. */}
      {isAuthenticated && !needsConsent && <Onboarding />}
      {isAuthenticated && <ConsentModal />}
    </MonthProvider>
  )
}
