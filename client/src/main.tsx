import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'
import { FeatureProvider } from './features/FeatureContext'
import { HouseholdProvider } from './features/HouseholdContext'
import { OnboardingProvider } from './onboarding/OnboardingContext'
import { AnalyticsProvider } from './analytics/AnalyticsProvider'
import { registerServiceWorker } from './lib/serviceWorker'
import { moveLegacyStorage } from './lib/legacyStorage'

// Before anything reads its saved preferences (the providers read them as they mount).
moveLegacyStorage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <FeatureProvider>
          <HouseholdProvider>
            <AnalyticsProvider>
              <OnboardingProvider>
                <App />
              </OnboardingProvider>
            </AnalyticsProvider>
          </HouseholdProvider>
        </FeatureProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)

registerServiceWorker()
