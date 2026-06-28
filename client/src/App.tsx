import { Navigate, Route, Routes } from 'react-router-dom'
import type { JSX } from 'react'
import { useAuth } from './auth/AuthContext'
import { useFeatures } from './features/FeatureContext'
import { MonthProvider } from './features/MonthContext'
import { LoginPage } from './pages/LoginPage'
import { AcceptInvitePage } from './pages/AcceptInvitePage'
import { AccountPage } from './pages/AccountPage'
import { PeoplePage } from './pages/PeoplePage'
import { DashboardPage } from './pages/DashboardPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { AccountsPage } from './pages/AccountsPage'
import { FundsPage } from './pages/FundsPage'
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
  // Don't bounce to /login while we're still restoring the session from the refresh cookie.
  if (bootstrapping) return <AuthSplash />
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

export default function App() {
  const { isAuthenticated, bootstrapping } = useAuth()
  const features = useFeatures()

  return (
    <MonthProvider>
      <Routes>
        <Route
          path="/login"
          element={
            bootstrapping ? <AuthSplash /> : isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
          }
        />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
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
        {features.sinkingFunds && (
          <Route
            path="/funds"
            element={
              <RequireAuth>
                <FundsPage />
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
      {isAuthenticated && <Onboarding />}
    </MonthProvider>
  )
}
