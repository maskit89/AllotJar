// Renders a screen inside the providers it has in the app, nested the way main.tsx and App.tsx
// nest them: router > auth > features > household > month. Every screen test wraps its page in
// a router and AuthProvider; the other providers are opt-in so a test stays as small as the
// screen it exercises.
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext'
import { FeatureProvider } from '../features/FeatureContext'
import { HouseholdProvider } from '../features/HouseholdContext'
import { MonthProvider } from '../features/MonthContext'

export interface ProviderOptions {
  /** The URL the router starts at (the app's location, e.g. '/accounts/a1'). */
  route?: string
  /** Wrap in FeatureProvider (feature flags from /features). */
  features?: boolean
  /** Wrap in HouseholdProvider (the members list from /members). */
  household?: boolean
  /** Wrap in MonthProvider (the app-wide selected month). */
  month?: boolean
}

export function renderWithProviders(ui: ReactNode, { route, features, household, month }: ProviderOptions = {}) {
  let tree = ui
  if (month) tree = <MonthProvider>{tree}</MonthProvider>
  if (household) tree = <HouseholdProvider>{tree}</HouseholdProvider>
  if (features) tree = <FeatureProvider>{tree}</FeatureProvider>
  return render(
    <MemoryRouter initialEntries={route === undefined ? undefined : [route]}>
      <AuthProvider>{tree}</AuthProvider>
    </MemoryRouter>,
  )
}
